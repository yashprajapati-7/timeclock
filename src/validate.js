// Pure validators for admin input. Each throws ValidationError (422) with a message fit for a toast.
import { ValidationError } from './errors.js';
import { num, fmtDay, fmtTime, startOfWeek, ymd } from './shared/format.js';
import { DEFAULT_SETTINGS } from './repo.js';

const fail = msg => { throw new ValidationError(msg); };
const isTime = v => typeof v === 'number' && Number.isFinite(v);

export function validatePin(pin, employees, exceptId){
  if(!/^\d{4}$/.test(String(pin ?? ''))) fail('Code must be exactly 4 digits');
  if(employees.some(e => e.pin === pin && e.id !== exceptId)) fail('That code is already used by another employee');
}

const rateOf = (v, label) => {
  if(v === '' || v == null) return null;
  const n = Number(v);
  if(!Number.isFinite(n) || n < 0) fail(`${label} must be a number ≥ 0`);
  return n;
};
export function validateEmployee(b = {}){
  const name = String(b.name ?? '').trim();
  if(!name) fail('Enter a name');
  return { name, pin: String(b.pin ?? '').trim(), rate1: rateOf(b.rate1, 'Rate 1'), rate2: rateOf(b.rate2, 'Rate 2'), active: b.active !== false };
}

// Port of the legacy shift form checks; `others` = the employee's other shifts.
export function validateShift({ empId, in: tin, out: tout = null, breaks = [] }, others = []){
  if(!empId) fail('Choose an employee');
  if(!isTime(tin)) fail('Clock-in time is required');
  if(tout != null && (!isTime(tout) || tout <= tin)) fail('Clock-out must be after clock-in');
  if(!Array.isArray(breaks)) fail('Breaks must be a list');
  const out = [];
  for(const b of breaks){
    if(!isTime(b?.start)) continue;
    const end = b.end == null ? null : b.end;
    if(end != null && (!isTime(end) || end <= b.start)) fail('A break ends before it starts');
    if(b.start < tin || (tout != null && (b.start >= tout || (end != null && end > tout)))) fail('Breaks must be inside the shift');
    out.push({ start: b.start, end: end ?? tout ?? null });
  }
  out.sort((a, b) => a.start - b.start);
  for(let i = 1; i < out.length; i++)
    if((out[i - 1].end ?? Infinity) > out[i].start) fail('Breaks overlap each other');
  const clash = others.find(x => x.in < (tout ?? Infinity) && (x.out ?? Infinity) > tin);
  if(clash) fail(`Overlaps another shift for this employee (${fmtDay(clash.in)} ${fmtTime(clash.in)})`);
  return { empId, in: tin, out: tout ?? null, breaks: out };
}

const ENUMS = { breakMode: ['policy', 'actual', 'greater'], theme: ['auto', 'light', 'dark'] };
export function validateSettings(patch = {}){
  const out = {};
  for(const [k, v] of Object.entries(patch)){
    if(!(k in DEFAULT_SETTINGS) || k === 'defaultPin') fail(`Unknown setting: ${k}`);
    switch(k){
      case 'company': out[k] = String(v ?? '').trim() || 'Time Clock'; break;
      case 'currency': out[k] = String(v ?? '').slice(0, 4); break;
      case 'tierHours': out[k] = Math.max(0, num(v)); break;
      case 'kioskIdleSec': out[k] = Math.max(5, num(v)); break;
      case 'adminTimeoutMin': out[k] = Math.max(1, num(v)); break;
      case 'maxShiftHours': out[k] = Math.max(1, num(v)); break;
      case 'breakMode': case 'theme':
        if(!ENUMS[k].includes(v)) fail(`Invalid ${k}`);
        out[k] = v; break;
      case 'breakRules':
        if(!Array.isArray(v)) fail('Break rules must be a list');
        out[k] = v.map(r => ({ h: num(r?.h), m: Math.max(0, num(r?.m)) })).filter(r => r.h > 0).sort((a, b) => a.h - b.h);
        break;
    }
  }
  return out;
}

export function validateAdjustment(b = {}){
  const week = String(b.week ?? '');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(week) || ymd(startOfWeek(new Date(week + 'T00:00'))) !== week) fail('Week must be a Monday (YYYY-MM-DD)');
  if(!b.empId) fail('Choose an employee');
  if(!['allowance', 'deduction'].includes(b.type)) fail('Invalid adjustment type');
  const amount = num(b.amount);
  if(amount <= 0) fail('Enter an amount');
  return { week, empId: b.empId, type: b.type, label: String(b.label ?? '').trim() || '—', amount };
}
