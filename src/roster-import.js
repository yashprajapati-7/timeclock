// One-time (re-runnable) import from the old GJ06 roster app's JSON: {employees:[{id,name,role}], shifts:{'YYYY-MM-DD_<id>': entry|entry[]}}.
// The old app keyed days with toISOString() (UTC), so east of UTC every key is one day early → default offset +1.
// The offset and the source-id → employee map are remembered in settings.rosterImport, so re-runs are idempotent.
import { randomInt, randomUUID } from 'node:crypto';
import * as R from './repo.js';
import { validateRosterEntries } from './validate.js';
import { calcAll } from './shared/pay.js';
import { addDaysYmd, fmtDay, ymd } from './shared/format.js';
import { describeEntries } from './routes/roster.js';

const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const weekday = day => new Date(day + 'T00:00').getDay();   // 0 = Sunday
const sameEntries = (a, b) => JSON.stringify(a.map(({ type, start, end }) => [type, start ?? null, end ?? null]))
  === JSON.stringify(b.map(({ type, start, end }) => [type, start ?? null, end ?? null]));

// Only a hint: old-app data laid out Sun–Sat suggests +1; data laid out Mon–Sun suggests 0.
export function offsetWarning(keys, offsetDays){
  const days = keys.map(k => k.slice(0, 10)).sort();
  if(!days.length) return undefined;
  const first = weekday(days[0]), last = weekday(days.at(-1));
  if(offsetDays === 1 && first === 1 && last === 0)
    return 'The source days already look Monday-aligned; a +1 day offset would shift them to Tuesday. Check the preview, or use offset 0.';
  if(offsetDays === 0 && first === 0 && last === 6)
    return 'The source days look Sunday-aligned (the old app saved them one day early); offset +1 is probably right.';
  return undefined;
}

function sourceEntries(raw){
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(e => e?.type === 'shift'
    ? { type: e.category === 'BAKERY' ? 'BAKERY' : 'CAFE', start: e.start, end: e.end }
    : { type: e?.type, start: e?.start, end: e?.end });
}

// Pure plan. ctx = loadData(db) + {now}. Returns what an apply would do, without writing.
export function planImport(src, ctx, { offsetDays } = {}){
  if(!src || !Array.isArray(src.employees) || typeof src.shifts !== 'object' || src.shifts === null)
    throw Object.assign(new Error('Not roster data: expected {employees:[…], shifts:{…}}'), { status: 422 });
  const saved = ctx.settings.rosterImport || {};
  const offset = Number.isInteger(offsetDays) ? offsetDays : Number.isInteger(saved.offsetDays) ? saved.offsetDays : 1;
  const idMap = saved.idMap || {};
  const byName = new Map();
  for(const e of ctx.employees) (byName.get(norm(e.name)) ?? byName.set(norm(e.name), []).get(norm(e.name))).push(e);

  const target = new Map(), matched = [], toCreate = [], ambiguous = [];
  for(const s of src.employees){
    const nm = String(s?.name ?? '').trim().replace(/\s+/g, ' ');
    if(!nm) continue;                       // no name: its cells end up in "skipped"
    const mapped = idMap[s.id] && ctx.employees.find(e => e.id === idMap[s.id]);
    const same = byName.get(norm(s.name)) || [];
    if(mapped){ matched.push({ srcId: s.id, srcName: s.name, empId: mapped.id }); target.set(String(s.id), { empId: mapped.id, name: mapped.name }); }
    else if(same.length === 1){ matched.push({ srcId: s.id, srcName: s.name, empId: same[0].id }); target.set(String(s.id), { empId: same[0].id, name: same[0].name }); }
    else if(same.length > 1) ambiguous.push(nm);
    else { target.set(String(s.id), { newIndex: toCreate.length, name: nm }); toCreate.push({ srcId: s.id, name: nm, role: String(s.role ?? '').trim() }); }
  }

  const today = ymd(ctx.now), cells = [], skipped = [];
  let changedCells = 0, pastDayCells = 0;
  for(const [key, raw] of Object.entries(src.shifts)){
    const m = /^(\d{4}-\d{2}-\d{2})_(.+)$/.exec(key);
    const t = m && target.get(m[2]);
    if(!m || ymd(new Date(m[1] + 'T00:00')) !== m[1]){ skipped.push({ key, reason: 'bad key' }); continue; }
    if(!t){ skipped.push({ key, reason: 'staff member skipped (unknown or ambiguous name)' }); continue; }
    let entries;
    try{ entries = validateRosterEntries(sourceEntries(raw)); }
    catch(e){ skipped.push({ key, reason: e.message }); continue; }
    const day = addDaysYmd(m[1], offset);
    const current = t.empId ? ctx.roster[`${day}|${t.empId}`] || [] : [];
    const changed = !sameEntries(current, entries);
    if(changed){ changedCells++; if(day < today) pastDayCells++; }
    cells.push({ ...(t.empId ? { empId: t.empId } : { newIndex: t.newIndex }), name: t.name, day, entries, changed });
  }
  cells.sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));

  // Existing shifts whose paid times would change once the planned cells are in place.
  const roster = { ...ctx.roster };
  for(const c of cells) if(c.empId && c.changed) roster[`${c.day}|${c.empId}`] = c.entries;
  const before = calcAll(ctx, ctx.now), after = calcAll({ ...ctx, roster }, ctx.now);
  const repricedShifts = [...before].filter(([id, c]) => { const a = after.get(id); return a.paidIn !== c.paidIn || a.paidOut !== c.paidOut; }).length;

  return {
    offsetDays: offset, warning: offsetWarning(Object.keys(src.shifts), offset),
    firstDay: cells[0]?.day ?? null, lastDay: cells.at(-1)?.day ?? null,
    matched, toCreate, ambiguous, skipped, cells, changedCells, pastDayCells, repricedShifts,
    sample: cells.slice(0, 5).map(c => `${fmtDay(new Date(c.day + 'T00:00'))} · ${c.name} · ${describeEntries(c.entries)}`),
  };
}

// Writes a plan inside the caller's transaction. touch(table, id, opts) registers rows with undo.
export function applyImport(db, plan, { now = Date.now(), pinGen, touch = () => {} } = {}){
  const randomPin = pinGen ?? (() => String(randomInt(10000)).padStart(4, '0'));
  const used = new Set(R.listEmployees(db).map(e => e.pin));
  const created = [], newIds = [];
  for(const c of plan.toCreate){
    let pin;
    for(let i = 0; i < 100000 && (pin == null || pin === '0000' || used.has(pin)); i++) pin = randomPin();
    if(pin == null || pin === '0000' || used.has(pin)) throw new Error('No free 4-digit codes left');
    used.add(pin);
    const id = randomUUID();
    R.createEmployee(db, { id, name: c.name, pin, role: c.role, active: true }, now);
    touch('employees', id, { created: true });
    created.push({ name: c.name, pin });
    newIds.push(id);
  }
  let changed = 0;
  for(const c of plan.cells){
    const empId = c.empId ?? newIds[c.newIndex];
    if(c.empId && !c.changed) continue;
    for(const e of R.getRosterCell(db, empId, c.day)) touch('roster', e.id);
    const { addedIds } = R.replaceRosterCell(db, empId, c.day, c.entries);
    addedIds.forEach(id => touch('roster', id, { created: true }));
    changed++;
  }
  const saved = R.getSettings(db).rosterImport || {};
  const idMap = { ...(saved.idMap || {}) };
  for(const m of plan.matched) idMap[m.srcId] = m.empId;
  plan.toCreate.forEach((c, i) => { idMap[c.srcId] = newIds[i]; });
  touch('settings', 'rosterImport');
  R.setSettings(db, { rosterImport: { offsetDays: plan.offsetDays, idMap } });
  return { created, changedCells: changed };
}
