// Pure break & pay calculation shared by the browser (/shared/pay.js) and the server.
// `data` is always { settings, employees, shifts, adj } in the legacy shape.
import { H, MIN, num, ymd, addDays, dayIndex, fmtHM, fmtDay } from './format.js';

export function policyBreak(hours, rules){
  let m = 0;
  for(const r of [...rules].sort((a, b) => a.h - b.h)) if(hours >= r.h) m = num(r.m);
  return m;
}

export function shift(sh, st, now = Date.now()){
  const end = sh.out ?? now;
  const totalMin = Math.max(0, Math.round((end - sh.in) / MIN));
  const actual = sh.breaks.reduce((a, b) => a + Math.max(0, Math.round(((b.end ?? now) - b.start) / MIN)), 0);
  const policy = policyBreak(totalMin / 60, st.breakRules);
  const ded = Math.min(totalMin, st.breakMode === 'policy' ? policy : st.breakMode === 'actual' ? actual : Math.max(policy, actual));
  return { total: totalMin / 60, actual, policy, ded, paid: (totalMin - ded) / 60, open: sh.out == null };
}

export function week(data, ws, now = Date.now()){
  const a = +ws, b = +addDays(ws, 7), key = ymd(ws), tier = num(data.settings.tierHours);
  const rows = [];
  for(const e of data.employees){
    const shifts = data.shifts.filter(x => x.empId === e.id && x.in >= a && x.in < b);
    const adj = data.adj[`${key}|${e.id}`] || [];
    if(!shifts.length && !adj.length && e.active === false) continue;
    const days = Array(7).fill(0); let total = 0, ded = 0, paid = 0, open = false;
    for(const sh of shifts){
      const c = shift(sh, data.settings, now);
      days[dayIndex(sh.in)] += c.paid;
      total += c.total; ded += c.ded; paid += c.paid; open ||= c.open;
    }
    const h1 = Math.min(paid, tier), h2 = Math.max(0, paid - tier);
    const r1 = num(e.rate1), r2 = num(e.rate2);
    const p1 = h1 * r1, p2 = h2 * r2, gross = p1 + p2;
    const sum = type => adj.filter(x => x.type === type).reduce((acc, x) => acc + num(x.amount), 0);
    const allow = sum('allowance'), deduct = sum('deduction');
    rows.push({ e, shifts, days, total, ded, paid, h1, h2, r1, r2, p1, p2, gross, allow, deduct, net: gross + allow - deduct, open });
  }
  return rows;
}

export function totals(rows){
  const keys = ['total','ded','paid','h1','h2','p1','p2','gross','allow','deduct','net'];
  const T = Object.fromEntries(keys.map(k => [k, 0])); T.days = Array(7).fill(0);
  for(const r of rows){ keys.forEach(k => T[k] += r[k]); r.days.forEach((d, i) => T.days[i] += d); }
  return T;
}

// Things an admin should look at: forgotten clock-outs, long breaks, overlaps, missing rates.
export function anomalies(data, ws, now = Date.now()){
  const out = [], maxH = num(data.settings.maxShiftHours) || 14;
  const name = id => data.employees.find(e => e.id === id)?.name ?? '(deleted)';
  const openBreak = sh => sh.breaks.find(b => b.end == null);
  if(data.settings.defaultPin) out.push({ level:'high', msg:'Admin PIN is still the default (0000). Change it in Settings.', tab:'settings' });
  for(const sh of data.shifts){
    if(sh.out == null && now - sh.in > maxH * H)
      out.push({ level:'high', msg:`${name(sh.empId)} has been clocked in for ${fmtHM((now - sh.in) / H)}. Missed clock-out?`, shiftId: sh.id });
    const b = openBreak(sh);
    if(b && now - b.start > 2 * H)
      out.push({ level:'med', msg:`${name(sh.empId)} has been on break for ${fmtHM((now - b.start) / H)}.`, shiftId: sh.id });
  }
  const a = +ws, b = +addDays(ws, 7), byEmp = {};
  for(const sh of data.shifts) if(sh.in >= a && sh.in < b) (byEmp[sh.empId] ||= []).push(sh);
  for(const list of Object.values(byEmp)){
    list.sort((x, y) => x.in - y.in);
    for(let i = 1; i < list.length; i++)
      if((list[i - 1].out ?? Infinity) > list[i].in)
        out.push({ level:'high', msg:`${name(list[i].empId)}: overlapping shifts on ${fmtDay(list[i].in)}.`, shiftId: list[i].id });
  }
  for(const e of data.employees)
    if(e.active !== false && (e.rate1 === '' || e.rate1 == null)) out.push({ level:'low', msg:`${e.name} has no pay rate set.`, empId: e.id });
  return out;
}
