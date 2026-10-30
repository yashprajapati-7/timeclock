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
const realDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(new Date(s + 'T00:00')) === s;
const isMonday = s => realDate(s) && ymd(startOfWeek(new Date(s + 'T00:00'))) === s;
const optDate = (v, label, { past = false } = {}) => {
  if(v === '' || v == null) return null;
  const s = String(v);
  if(!realDate(s)) fail(`${label} must be a real date (YYYY-MM-DD)`);
  if(past && s > ymd(Date.now())) fail(`${label} cannot be in the future`);
  return s;
};

function validateFixedItems(list){
  if(list == null) return [];
  if(!Array.isArray(list)) fail('Fixed items must be a list');
  if(list.length > 20) fail('At most 20 fixed allowances/deductions');
  return list.map((it, i) => {
    const n = `Fixed item ${i + 1}`;
    if(!['allowance', 'deduction'].includes(it?.type)) fail(`${n}: type must be allowance or deduction`);
    const label = String(it.label ?? '').trim();
    if(!label || label.length > 60) fail(`${n}: enter a description (max 60 characters)`);
    const amount = Number(it.amount);
    if(!Number.isFinite(amount) || amount <= 0) fail(`${n}: amount must be more than 0`);
    if(!isMonday(String(it.from ?? ''))) fail(`${n}: "from" week must be a Monday`);
    const to = it.to == null || it.to === '' ? null : String(it.to);
    if(to != null && (!isMonday(to) || to < it.from)) fail(`${n}: "until" week must be a Monday on or after "from"`);
    return { type: it.type, label, amount, from: it.from, to };
  });
}

export function validateEmployee(b = {}){
  const name = String(b.name ?? '').trim();
  if(!name) fail('Enter a name');
  const payType = b.payType ?? 'hourly';
  if(!['hourly', 'fixed', 'salary'].includes(payType)) fail('Pay type must be hourly, fixed or salary');
  const weeklySalary = payType === 'salary' ? rateOf(b.weeklySalary, 'Weekly salary') : null;
  if(payType === 'salary' && weeklySalary == null) fail('Weekly salary is required for salaried staff');
  const email = String(b.email ?? '').trim().toLowerCase();
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail('Email address looks wrong');
  const phone = String(b.phone ?? '').trim();
  if(phone && !/^\+?[\d\s()-]{6,20}$/.test(phone)) fail('Phone number looks wrong');
  const role = String(b.role ?? '').trim();
  if(role.length > 40) fail('Role is too long (max 40 characters)');
  return {
    name, pin: String(b.pin ?? '').trim(), rate1: rateOf(b.rate1, 'Rate 1'), rate2: rateOf(b.rate2, 'Rate 2'), active: b.active !== false,
    role, payType, weeklySalary, email, phone,
    birthday: optDate(b.birthday, 'Birthday', { past: true }), startDate: optDate(b.startDate, 'Start date'),
    fixedItems: validateFixedItems(b.fixedItems),
  };
}

// Roster cell: up to 4 entries; timed types need valid, different HH:MM start/end.
export const ROSTER_TYPES = ['CAFE', 'BAKERY', 'TRAINING', 'OFF', 'DELIVERY', 'BAKE', 'BAKERY YC'];
export const TIMED_TYPES = ['CAFE', 'BAKERY', 'TRAINING'];
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function validateRosterEntries(entries){
  if(!Array.isArray(entries)) fail('Roster entries must be a list');
  if(entries.length > 4) fail('At most 4 roster entries per day');
  return entries.map(e => {
    if(!ROSTER_TYPES.includes(e?.type)) fail(`Unknown roster type: ${e?.type}`);
    if(!TIMED_TYPES.includes(e.type)) return { type: e.type, start: null, end: null };
    if(!HM.test(String(e.start)) || !HM.test(String(e.end))) fail('Start and end must be times like 09:00 (HH:MM)');
    if(e.start === e.end) fail('Start and end cannot be the same time');
    return { type: e.type, start: e.start, end: e.end };
  });
}

// Port of the legacy shift form checks; `others` = the employee's other shifts.
export function validateShift({ empId, in: tin, out: tout = null, breaks = [], otApproved = false }, others = []){
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
  return { empId, in: tin, out: tout ?? null, breaks: out, otApproved: !!otApproved };
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
      case 'rounding': out[k] = !!v; break;
      case 'roundGraceMin': out[k] = Math.min(30, Math.max(0, Math.round(num(v)))); break;
      case 'roundStepMin':
        if(![1, 5, 10, 15, 30].includes(Number(v))) fail('Rounding step must be 1, 5, 10, 15 or 30 minutes');
        out[k] = Number(v); break;
      case 'roundFrom':
        if(v === '' || v == null){ out[k] = null; break; }
        if(!isMonday(String(v))) fail('"Rounding starts" must be a Monday (YYYY-MM-DD)');
        out[k] = String(v); break;
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
