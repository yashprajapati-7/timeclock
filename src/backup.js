// Backup format = the legacy app's "Download backup" JSON (v1 or v2).
import { ValidationError } from './errors.js';
import { DEFAULT_SETTINGS, PUBLIC_SETTINGS, getSettings, setSettings, listEmployees, listShifts, listAdjustments,
  listAudit, createEmployee, saveShift, addAdjustment, addAudit } from './repo.js';
import { hashPin } from './auth/hash.js';

const isNum = v => typeof v === 'number' && Number.isFinite(v);

export function normalizeBackup(json){
  if(!json || typeof json !== 'object' || !Array.isArray(json.employees) || !Array.isArray(json.shifts))
    throw new ValidationError('Not a valid backup: employees and shifts lists are required');
  const d = structuredClone(json);
  if(!d.v || d.v < 2){ d.v = 2; d.audit = []; }     // v1 → v2: audit trail; plaintext adminPin kept for rehash
  d.settings ||= {}; d.adj ||= {}; d.audit = Array.isArray(d.audit) ? d.audit : [];
  const problems = [], empIds = new Set();
  d.employees.forEach((e, i) => {
    if(!e || typeof e.id !== 'string' || !e.id) problems.push(`employee #${i + 1}: missing id`);
    else empIds.add(e.id);
    if(!e?.name) problems.push(`employee #${i + 1}: missing name`);
    if(!/^\d{4}$/.test(String(e?.pin ?? ''))) problems.push(`employee #${i + 1}: pin must be 4 digits`);
  });
  d.shifts.forEach((s, i) => {
    if(!s || typeof s.id !== 'string') problems.push(`shift #${i + 1}: missing id`);
    if(!empIds.has(s?.empId)) problems.push(`shift #${i + 1}: unknown employee`);
    if(!isNum(s?.in)) problems.push(`shift #${i + 1}: clock-in is not a timestamp`);
    if(s?.out != null && (!isNum(s.out) || s.out <= s.in)) problems.push(`shift #${i + 1}: clock-out must be after clock-in`);
    if(!Array.isArray(s?.breaks)) problems.push(`shift #${i + 1}: breaks must be a list`);
    else if(s.breaks.some(b => !isNum(b?.start) || (b.end != null && !isNum(b.end)))) problems.push(`shift #${i + 1}: bad break time`);
  });
  for(const [key, list] of Object.entries(d.adj)){
    if(!/^\d{4}-\d{2}-\d{2}\|.+$/.test(key) || !Array.isArray(list)) problems.push(`adjustment key ${key}: invalid`);
  }
  if(problems.length) throw new ValidationError(`Not a valid backup: ${problems.slice(0, 5).join('; ')}`, problems);
  return d;
}

// Combine legacy hash fields into the single stored adminPinHash, or hash a v1 plaintext PIN.
async function adminHashFrom(st){
  if(st.adminPinHash && st.adminSalt) return `${st.adminSalt}|${st.adminPinHash}`;
  // Our own exports already hold the combined form (scrypt$… or <salt>|sha256:…).
  if(st.adminPinHash && /^scrypt\$|\|/.test(st.adminPinHash)) return st.adminPinHash;
  return hashPin(st.adminPin != null ? String(st.adminPin) : '0000');
}

export async function importBackup(db, json, { now = Date.now() } = {}){
  const d = normalizeBackup(json);
  const pinHash = await adminHashFrom(d.settings);
  const defaultPin = d.settings.defaultPin ?? (d.settings.adminPin == null || String(d.settings.adminPin) === '0000');
  db.tx(() => {
    for(const t of ['breaks', 'adjustments', 'shifts', 'employees', 'settings', 'audit', 'sessions']) db.run(`DELETE FROM ${t}`);
    d.employees.forEach((e, i) => createEmployee(db, e, i));
    for(const s of d.shifts) saveShift(db, s);
    for(const [key, list] of Object.entries(d.adj)){
      const [week, empId] = [key.slice(0, 10), key.slice(11)];
      list.forEach((a, i) => addAdjustment(db, { week, empId, type: a.type, label: String(a.label ?? '—'), amount: Number(a.amount) || 0, position: i }));
    }
    for(const a of [...d.audit].reverse()) addAudit(db, a);
    const settings = Object.fromEntries(PUBLIC_SETTINGS.filter(k => k in d.settings).map(k => [k, d.settings[k]]));
    setSettings(db, { ...settings, defaultPin, adminPinHash: pinHash });
    addAudit(db, { ts: now, actor: 'System', action: 'Backup restored', detail: `${d.employees.length} employees, ${d.shifts.length} shifts` });
  });
  return { employees: d.employees.length, shifts: d.shifts.length, adjustments: Object.values(d.adj).flat().length, audit: d.audit.length };
}

export function exportBackup(db){
  const s = getSettings(db);
  const adj = Object.fromEntries(Object.entries(listAdjustments(db)).map(([k, list]) => [k, list.map(({ type, label, amount }) => ({ type, label, amount }))]));
  return {
    v: 2,
    settings: { ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, s[k]])), adminPinHash: s.adminPinHash },
    employees: listEmployees(db), shifts: listShifts(db), adj, audit: listAudit(db),
  };
}
