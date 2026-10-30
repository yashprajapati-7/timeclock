// Per-session undo stacks of row before/after images. Undo refuses (409) if a touched row changed since the action.
import { HttpError } from './errors.js';
import { getShift, saveShift, deleteShift, addAudit } from './repo.js';

const MAX = 30;

const snap = {
  employees: (db, id) => db.get('SELECT * FROM employees WHERE id = ?', id) ?? null,
  shifts: (db, id) => getShift(db, id),
  adjustments: (db, id) => db.get('SELECT * FROM adjustments WHERE id = ?', Number(id)) ?? null,
  settings: (db, key) => db.get('SELECT * FROM settings WHERE key = ?', key) ?? null,
  roster: (db, id) => db.get('SELECT * FROM roster WHERE id = ?', Number(id)) ?? null,
};

// Upsert a whole row image by its own column names (stays correct as migrations add columns).
const upsertRow = (db, table, row, key = 'id') => {
  const cols = Object.keys(row);
  db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(${key}) DO UPDATE SET ${cols.filter(c => c !== key).map(c => `${c} = excluded.${c}`).join(', ')}`, cols.map(c => row[c]));
};

const restore = {
  employees(db, id, row){
    if(!row) return db.run('DELETE FROM employees WHERE id = ?', id);
    upsertRow(db, 'employees', row);
  },
  roster(db, id, row){
    if(!row) return db.run('DELETE FROM roster WHERE id = ?', Number(id));
    upsertRow(db, 'roster', row);
  },
  shifts: (db, id, row) => row ? saveShift(db, row) : deleteShift(db, id),
  adjustments(db, id, row){
    if(!row) return db.run('DELETE FROM adjustments WHERE id = ?', Number(id));
    db.run(`INSERT INTO adjustments (id, week_start, emp_id, type, label, amount, position) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET week_start = excluded.week_start, emp_id = excluded.emp_id, type = excluded.type,
      label = excluded.label, amount = excluded.amount, position = excluded.position`,
      [row.id, row.week_start, row.emp_id, row.type, row.label, row.amount, row.position]);
  },
  settings(db, key, row){
    if(!row) return db.run('DELETE FROM settings WHERE key = ?', key);
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, row.value]);
  },
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createUndo(db, clock = Date.now){
  const stacks = new Map();   // session key -> [{ action, entries: [{table, id, before, after}] }]
  return {
    label: key => stacks.get(key)?.at(-1)?.action ?? null,
    clear: key => stacks.delete(key),
    clearAll: () => stacks.clear(),

    // fn(touch) performs the mutation; it calls touch(table, id) BEFORE changing a row,
    // or touch(table, id, { created: true }) right after inserting a new one.
    run(key, action, fn){
      const entries = [];
      const touch = (table, id, { created = false } = {}) => {
        if(!entries.some(e => e.table === table && String(e.id) === String(id)))
          entries.push({ table, id, before: created ? null : snap[table](db, id) });
      };
      const result = db.tx(() => fn(touch));
      for(const e of entries) e.after = snap[e.table](db, e.id);
      const stack = stacks.get(key) ?? [];
      stack.push({ action, entries });
      if(stack.length > MAX) stack.shift();
      stacks.set(key, stack);
      return result;
    },

    undo(key){
      const stack = stacks.get(key);
      const top = stack?.at(-1);
      if(!top) return null;
      const conflict = () => new HttpError(409, 'Data changed since this action; cannot undo');
      try{
        db.tx(() => {
          if(top.entries.some(e => !same(snap[e.table](db, e.id), e.after))) throw conflict();
          // Removing an employee would hit rows this action never touched (shifts: RESTRICT, adjustments: CASCADE).
          const touchedAdj = new Set(top.entries.filter(e => e.table === 'adjustments').map(e => Number(e.id)));
          const touchedRoster = new Set(top.entries.filter(e => e.table === 'roster').map(e => Number(e.id)));
          for(const e of top.entries.filter(x => x.table === 'employees' && !x.before)){
            if(db.get('SELECT 1 x FROM shifts WHERE emp_id = ? LIMIT 1', e.id)) throw conflict();
            if(db.all('SELECT id FROM adjustments WHERE emp_id = ?', e.id).some(a => !touchedAdj.has(a.id))) throw conflict();
            if(db.all('SELECT id FROM roster WHERE emp_id = ?', e.id).some(r => !touchedRoster.has(r.id))) throw conflict();
          }
          // Shifts before employees on delete, employees before shifts on restore: reverse order handles both.
          for(const e of [...top.entries].reverse()) restore[e.table](db, e.id, e.before);
          addAudit(db, { ts: clock(), actor: 'Admin', action: 'Undo', detail: top.action });
        });
      }catch(err){
        // e.g. a restored employee code now belongs to someone else (UNIQUE) — still a conflict, not a crash.
        // Only constraint failures (primary result code 19) mean "changed meanwhile"; BUSY/IO errors stay real errors.
        if(err.code === 'ERR_SQLITE_ERROR' && (err.errcode & 0xff) === 19) throw conflict();
        throw err;
      }
      stack.pop();
      return top.action;
    },
  };
}
