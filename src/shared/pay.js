// Pure break & pay calculation shared by the browser (/shared/pay.js) and the server.
// `data` is always { settings, employees, shifts, adj, roster? } in the legacy shape.
// Roster rules: raw punches are never changed; *paid* in/out times are derived from the roster at calculation time.
import { H, MIN, num, ymd, addDays, dayIndex, fmtHM, fmtDay, atLocal, addDaysYmd, floorMin, ceilStep, floorStep } from './format.js';

export const TIMED = ['CAFE', 'BAKERY', 'TRAINING'];
export const MATCH_EARLY_MIN = 120;

export function policyBreak(hours, rules){
  let m = 0;
  for(const r of [...rules].sort((a, b) => a.h - b.h)) if(hours >= r.h) m = num(r.m);
  return m;
}

// ----- Roster matching -----
// Rostered span on the local wall clock; an end at or before the start finishes the next day.
export function rosterSpan(entry, day){
  const S = atLocal(day, entry.start);
  const E = entry.end <= entry.start ? atLocal(addDaysYmd(day, 1), entry.end) : atLocal(day, entry.end);
  return { S, E };
}

const roundingFrom = st => st.rounding === false || !st.roundFrom ? null : atLocal(st.roundFrom, '00:00');

// Map(shiftId → {entry, day, S, E, first, last}) for one employee's shifts.
// A shift matches the timed entry (that day, the day before or after) whose start is nearest its clock-in,
// within S−120 min ≤ in < E; an entry on the clock-in's own day also matches any earlier clock-in (paid from S).
// Several shifts inside one entry form a chain: the first gets the start rule, the last the finish rule.
export function matchRoster(empShifts, roster = {}, empId, st){
  const out = new Map(), from = roundingFrom(st);
  if(from == null) return out;
  for(const sh of [...empShifts].sort((a, b) => a.in - b.in)){
    if(sh.in < from) continue;
    const day = ymd(sh.in);
    // Nearest entry whose match range holds the clock-in; only if none does, the earliest later entry that day.
    let best = null, early = null;
    for(const dd of [addDaysYmd(day, -1), day, addDaysYmd(day, 1)]){
      for(const entry of roster[`${dd}|${empId}`] || []){
        if(!TIMED.includes(entry.type) || !entry.start || !entry.end) continue;
        const { S, E } = rosterSpan(entry, dd);
        if(S - MATCH_EARLY_MIN * MIN <= sh.in && sh.in < E){
          const dist = Math.abs(S - sh.in);
          if(!best || dist < best.dist || (dist === best.dist && S < best.S)) best = { entry, day: dd, S, E, dist };
        } else if(dd === day && sh.in < S && (!early || S < early.S)) early = { entry, day: dd, S, E, dist: 0 };
      }
    }
    best ??= early;
    if(best){
      const { dist, ...m } = best;
      out.set(sh.id, { ...m, first: true, last: true });
    }
  }
  // Chains: shifts sharing one entry — only the earliest keeps the start rule, only the latest the finish rule.
  const byEntry = new Map();
  for(const [id, m] of out){ const k = `${m.day}|${m.entry.start}|${m.entry.end}|${m.entry.type}`; (byEntry.get(k) ?? byEntry.set(k, []).get(k)).push(id); }
  const inOf = new Map(empShifts.map(s => [s.id, s.in]));
  for(const ids of byEntry.values()){
    if(ids.length < 2) continue;
    ids.sort((a, b) => inOf.get(a) - inOf.get(b));
    ids.forEach((id, i) => { const m = out.get(id); m.first = i === 0; m.last = i === ids.length - 1; });
  }
  return out;
}

// Paid in/out for one shift given its roster match (no match → actual times).
export function paidSpan(sh, match, st, now = Date.now()){
  const outRaw = sh.out ?? now;
  const res = { paidIn: sh.in, paidOut: outRaw, lateMin: 0, earlyMin: 0, capped: 0 };
  if(!match) return res;
  const g = num(st.roundGraceMin) * MIN, step = num(st.roundStepMin) || 15;
  const inM = floorMin(sh.in), outM = floorMin(outRaw), { S, E } = match;
  if(match.first){
    if(inM <= S + g) res.paidIn = S;
    else { res.paidIn = ceilStep(inM, step); res.lateMin = Math.round((inM - S) / MIN); }
  }
  if(match.last){
    if(outM >= E - g && outM <= E + g) res.paidOut = E;
    else if(outM > E + g){
      if(sh.otApproved) res.paidOut = Math.max(E, floorStep(outM, step));
      else { res.paidOut = E; res.capped = Math.round((outM - E) / MIN); }
    } else if(sh.out != null){
      res.paidOut = floorStep(outM, step);
      res.earlyMin = Math.round((E - outM) / MIN);
    }
  }
  if(res.paidOut < res.paidIn) res.paidOut = res.paidIn;
  return res;
}

// One shift's numbers. total = actual time worked; span = paid span; paid = span − break deduction.
export function shift(sh, st, now = Date.now(), match){
  const end = sh.out ?? now;
  const totalMin = Math.max(0, Math.round((end - sh.in) / MIN));
  const p = paidSpan(sh, match, st, now);
  const spanMin = Math.max(0, Math.round((p.paidOut - p.paidIn) / MIN));
  // Breaks count only where they fall inside the paid span (with no roster that is the whole shift).
  const actual = sh.breaks.reduce((a, b) => {
    const s = Math.max(b.start, p.paidIn), e = Math.min(b.end ?? now, p.paidOut);
    return a + Math.max(0, Math.round((e - s) / MIN));
  }, 0);
  const policy = policyBreak(spanMin / 60, st.breakRules);
  const ded = Math.min(spanMin, st.breakMode === 'policy' ? policy : st.breakMode === 'actual' ? actual : Math.max(policy, actual));
  return { total: totalMin / 60, actual, policy, ded, paid: (spanMin - ded) / 60, open: sh.out == null,
    paidIn: p.paidIn, paidOut: p.paidOut, span: spanMin / 60, lateMin: p.lateMin, earlyMin: p.earlyMin, capped: p.capped,
    roster: match?.entry ?? null };
}

// Map(shiftId → shift calc) for every shift (optionally only those clocking in within [from, to)).
export function calcAll(data, now = Date.now(), { from = -Infinity, to = Infinity } = {}){
  const byEmp = new Map();
  for(const sh of data.shifts) if(sh.in >= from && sh.in < to) (byEmp.get(sh.empId) ?? byEmp.set(sh.empId, []).get(sh.empId)).push(sh);
  const out = new Map();
  for(const [empId, list] of byEmp){
    const matches = matchRoster(list, data.roster, empId, data.settings);
    for(const sh of list) out.set(sh.id, shift(sh, data.settings, now, matches.get(sh.id)));
  }
  return out;
}

export function week(data, ws, now = Date.now()){
  const a = +ws, b = +addDays(ws, 7), key = ymd(ws), tier = num(data.settings.tierHours);
  const calcs = calcAll(data, now, { from: a, to: b });
  const rows = [];
  for(const e of data.employees){
    const shifts = data.shifts.filter(x => x.empId === e.id && x.in >= a && x.in < b);
    const adj = data.adj[`${key}|${e.id}`] || [];
    if(!shifts.length && !adj.length && e.active === false) continue;
    const days = Array(7).fill(0); let total = 0, ded = 0, paid = 0, open = false, late = 0, lateMin = 0;
    for(const sh of shifts){
      const c = calcs.get(sh.id);
      days[dayIndex(sh.in)] += c.paid;
      total += c.total; ded += c.ded; paid += c.paid; open ||= c.open;
      if(c.lateMin > num(data.settings.roundGraceMin)){ late++; lateMin += c.lateMin; }
    }
    const h1 = Math.min(paid, tier), h2 = Math.max(0, paid - tier);
    const r1 = num(e.rate1), r2 = e.payType === 'fixed' ? r1 : num(e.rate2);   // fixed rate: one rate for all hours
    // Salaried staff get their fixed weekly amount (from their start date on); hours are tracked but not priced.
    const salaried = e.payType === 'salary';
    const salary = salaried ? (!e.startDate || e.startDate <= ymd(addDays(ws, 6)) ? num(e.weeklySalary) : 0) : null;
    const p1 = salaried ? 0 : h1 * r1, p2 = salaried ? 0 : h2 * r2, gross = salaried ? salary : p1 + p2;
    // Recurring items apply in their weeks, but only when there is pay that week (no allowance for a week off).
    const fixed = (e.fixedItems || []).filter(f => f.from <= key && (!f.to || key <= f.to) && (paid > 0 || salary > 0));
    const sum = (type, list) => list.filter(x => x.type === type).reduce((acc, x) => acc + num(x.amount), 0);
    const allow = sum('allowance', adj) + sum('allowance', fixed), deduct = sum('deduction', adj) + sum('deduction', fixed);
    rows.push({ e, shifts, days, total, ded, paid, h1, h2, r1, r2, p1, p2, gross, salary, fixed, allow, deduct,
      net: gross + allow - deduct, open, late, lateMin });
  }
  return rows;
}

export function totals(rows){
  const keys = ['total','ded','paid','h1','h2','p1','p2','gross','allow','deduct','net'];
  const T = Object.fromEntries(keys.map(k => [k, 0])); T.days = Array(7).fill(0);
  for(const r of rows){ keys.forEach(k => T[k] += r[k]); r.days.forEach((d, i) => T.days[i] += d); }
  return T;
}

// Birthdays and work anniversaries from today to `days` ahead (active staff only).
export function upcoming(employees, now = Date.now(), days = 7){
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const out = [];
  const next = (dateStr) => {
    const [, m, d] = dateStr.split('-').map(Number);
    for(const y of [today.getFullYear(), today.getFullYear() + 1]){
      let dt = new Date(y, m - 1, d);
      if(dt.getMonth() !== m - 1) dt = new Date(y, m - 1, 28);       // 29 Feb → 28 Feb in non-leap years
      if(dt >= today) return dt;
    }
  };
  for(const e of employees){
    if(e.active === false) continue;
    for(const [kind, field] of [['birthday', 'birthday'], ['anniversary', 'startDate']]){
      if(!e[field]) continue;
      const dt = next(e[field]), inDays = Math.round((dt - today) / 86400000);
      const years = dt.getFullYear() - Number(e[field].slice(0, 4));
      if(inDays > days || (kind === 'anniversary' && years < 1)) continue;
      out.push({ empId: e.id, name: e.name, kind, date: ymd(dt), inDays, ...(kind === 'anniversary' ? { years } : {}) });
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
}

// Rostered hours per person and staff per day for one week (break rules applied to each day's total).
export function rosterWeek(data, ws){
  const days = Array.from({ length: 7 }, (_, i) => ymd(addDays(ws, i)));
  const rows = [], staffPerDay = Array(7).fill(0);
  for(const e of data.employees){
    const cells = days.map(dd => (data.roster || {})[`${dd}|${e.id}`] || []);
    if(e.active === false && !cells.some(c => c.length)) continue;
    const hours = cells.map(entries => {
      const mins = entries.filter(x => TIMED.includes(x.type) && x.start && x.end)
        .reduce((acc, x) => { const { S, E } = rosterSpan(x, '2000-01-03'); return acc + (E - S) / MIN; }, 0);
      return mins ? (mins - policyBreak(mins / 60, data.settings.breakRules)) / 60 : 0;
    });
    hours.forEach((h, i) => { if(h > 0) staffPerDay[i]++; });
    rows.push({ empId: e.id, name: e.name, cells, days: hours, total: hours.reduce((x, y) => x + y, 0),
      offDays: cells.filter(c => c.some(x => x.type === 'OFF')).length });
  }
  return { days, rows, staffPerDay, total: rows.reduce((acc, r) => acc + r.total, 0) };
}

// Things an admin should look at: forgotten clock-outs, long breaks, overlaps, missing rates, unpaid overtime.
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
  // Roster-related: unpaid overtime, and clock-ins on a rostered day that match no rostered entry.
  const from = roundingFrom(data.settings);
  if(from != null){
    const calcs = calcAll(data, now, { from: a, to: b });
    for(const sh of data.shifts){
      const c = calcs.get(sh.id);
      if(!c) continue;
      if(c.capped > 0)
        out.push({ level:'med', msg:`${name(sh.empId)} stayed ${c.capped} min past the rostered end on ${fmtDay(sh.in)} (not paid unless approved).`, shiftId: sh.id });
      const rostered = ((data.roster || {})[`${ymd(sh.in)}|${sh.empId}`] || []).some(x => TIMED.includes(x.type));
      if(!c.roster && rostered && sh.in >= from)
        out.push({ level:'med', msg:`${name(sh.empId)} clocked in outside their rostered time on ${fmtDay(sh.in)}.`, shiftId: sh.id });
    }
  }
  for(const e of data.employees){
    if(e.active === false) continue;
    if(e.payType === 'salary'){
      if(e.weeklySalary == null || e.weeklySalary === '') out.push({ level:'low', msg:`${e.name} is salaried but has no weekly salary set.`, empId: e.id });
    } else if(e.rate1 === '' || e.rate1 == null) out.push({ level:'low', msg:`${e.name} has no pay rate set.`, empId: e.id });
  }
  return out;
}
