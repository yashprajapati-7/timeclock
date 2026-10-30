// Data access. Rows are mapped to the legacy shapes used by pay.js and the UI.
export const DEFAULT_SETTINGS = {
  company: 'Time Clock',
  currency: '$',
  tierHours: 24,            // pay rate 1 for the first N paid hours of the week, rate 2 after
  breakMode: 'greater',     // policy | actual | greater
  breakRules: [ {h:4,m:15}, {h:5,m:30}, {h:7,m:60}, {h:10,m:90} ],
  theme: 'auto',            // auto | light | dark
  kioskIdleSec: 20,
  adminTimeoutMin: 5,
  maxShiftHours: 14,
  defaultPin: true,
};
// Settings that may leave the server; adminPinHash never does.
export const PUBLIC_SETTINGS = Object.keys(DEFAULT_SETTINGS);

// ----- Settings -----
export function getSettings(db){
  const s = structuredClone(DEFAULT_SETTINGS);
  for(const r of db.all('SELECT key, value FROM settings')) s[r.key] = JSON.parse(r.value);
  return s;
}
export function publicSettings(db){
  const s = getSettings(db);
  return Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, s[k]]));
}
export function setSettings(db, patch){
  db.tx(() => {
    for(const [k, v] of Object.entries(patch))
      db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, JSON.stringify(v)]);
  });
}

// ----- Employees -----
const toEmp = r => r && { id: r.id, name: r.name, pin: r.pin, rate1: r.rate1, rate2: r.rate2, active: !!r.active };
const rate = v => v === '' || v == null ? null : Number(v);

export const listEmployees = db => db.all('SELECT * FROM employees ORDER BY created_at, rowid').map(toEmp);
export const getEmployee = (db, id) => toEmp(db.get('SELECT * FROM employees WHERE id = ?', id));
export const findEmployeeByPin = (db, pin) => toEmp(db.get('SELECT * FROM employees WHERE pin = ? AND active = 1', String(pin)));
export function createEmployee(db, e, now){
  db.run('INSERT INTO employees (id, name, pin, rate1, rate2, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [e.id, e.name, e.pin, rate(e.rate1), rate(e.rate2), e.active === false ? 0 : 1, now]);
}
export function updateEmployee(db, id, e){
  db.run('UPDATE employees SET name = ?, pin = ?, rate1 = ?, rate2 = ?, active = ? WHERE id = ?',
    [e.name, e.pin, rate(e.rate1), rate(e.rate2), e.active === false ? 0 : 1, id]);
}
export const deleteEmployee = (db, id) => db.run('DELETE FROM employees WHERE id = ?', id);
export const employeeHasShifts = (db, id) => !!db.get('SELECT 1 x FROM shifts WHERE emp_id = ? LIMIT 1', id);

// ----- Shifts & breaks -----
function attachBreaks(db, rows){
  if(!rows.length) return [];
  const byShift = new Map(rows.map(r => [r.id, { id: r.id, empId: r.emp_id, in: r.clock_in, out: r.clock_out, breaks: [] }]));
  const ph = rows.map(() => '?').join(',');
  for(const b of db.all(`SELECT shift_id, start_at, end_at FROM breaks WHERE shift_id IN (${ph}) ORDER BY start_at`, rows.map(r => r.id)))
    byShift.get(b.shift_id).breaks.push({ start: b.start_at, end: b.end_at });
  return [...byShift.values()];
}
export const getShift = (db, id) => attachBreaks(db, db.all('SELECT * FROM shifts WHERE id = ?', id))[0] ?? null;
export function listShifts(db, { from = -Infinity, to = Infinity, empId } = {}){
  const where = ['clock_in >= ?', 'clock_in < ?'], p = [from === -Infinity ? -8.64e15 : from, to === Infinity ? 8.64e15 : to];
  if(empId){ where.push('emp_id = ?'); p.push(empId); }
  return attachBreaks(db, db.all(`SELECT * FROM shifts WHERE ${where.join(' AND ')} ORDER BY clock_in`, p));
}
export const openShiftFor = (db, empId) => attachBreaks(db, db.all('SELECT * FROM shifts WHERE emp_id = ? AND clock_out IS NULL', empId))[0] ?? null;
export function saveShift(db, sh){
  db.tx(() => {
    db.run(`INSERT INTO shifts (id, emp_id, clock_in, clock_out) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET emp_id = excluded.emp_id, clock_in = excluded.clock_in, clock_out = excluded.clock_out`,
      [sh.id, sh.empId, sh.in, sh.out ?? null]);
    db.run('DELETE FROM breaks WHERE shift_id = ?', sh.id);
    for(const b of sh.breaks || []) db.run('INSERT INTO breaks (shift_id, start_at, end_at) VALUES (?, ?, ?)', [sh.id, b.start, b.end ?? null]);
  });
}
export const deleteShift = (db, id) => db.run('DELETE FROM shifts WHERE id = ?', id);

// ----- Adjustments ('YYYY-MM-DD|empId' -> [{id,type,label,amount}]) -----
export function listAdjustments(db){
  const map = {};
  for(const r of db.all('SELECT * FROM adjustments ORDER BY week_start, emp_id, position, id'))
    (map[`${r.week_start}|${r.emp_id}`] ||= []).push({ id: r.id, type: r.type, label: r.label, amount: r.amount });
  return map;
}
export const getAdjustment = (db, id) => db.get('SELECT * FROM adjustments WHERE id = ?', Number(id)) ?? null;
export function addAdjustment(db, a){
  const pos = db.get('SELECT COALESCE(MAX(position), -1) + 1 p FROM adjustments WHERE week_start = ? AND emp_id = ?', [a.week, a.empId]).p;
  return Number(db.run('INSERT INTO adjustments (week_start, emp_id, type, label, amount, position) VALUES (?, ?, ?, ?, ?, ?)',
    [a.week, a.empId, a.type, a.label, a.amount, a.position ?? pos]).lastInsertRowid);
}
export const deleteAdjustment = (db, id) => db.run('DELETE FROM adjustments WHERE id = ?', Number(id));

// ----- Audit -----
export function addAudit(db, { ts, actor, action, detail = '' }){
  db.run('INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)', [ts, actor, action, String(detail ?? '')]);
}
export function listAudit(db, { q = '', limit } = {}){
  const like = `%${String(q).toLowerCase().replace(/[\\%_]/g, c => '\\' + c)}%`;
  const sql = `SELECT ts, actor, action, detail FROM audit
    WHERE lower(actor || ' ' || action || ' ' || detail) LIKE ? ESCAPE '\\' ORDER BY ts DESC, id DESC`;
  return limit ? db.all(sql + ' LIMIT ?', [like, Number(limit)]) : db.all(sql, like);
}

// Everything pay.js needs, in the legacy shape.
export function loadData(db){
  return { settings: getSettings(db), employees: listEmployees(db), shifts: listShifts(db), adj: listAdjustments(db) };
}
