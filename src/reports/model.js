// One report model feeds both the Excel and the PDF exports, built only from pay.js so numbers match the UI.
import { HttpError } from '../errors.js';
import { week, totals, calcAll, rosterWeek } from '../shared/pay.js';
import { ymd, addDays, startOfWeek } from '../shared/format.js';

export function parseWeekParam(str, now = Date.now()){
  if(str == null || str === '') return +startOfWeek(now);
  // Round-trip check rejects impossible dates like 2026-02-31 (which Date would roll into March).
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(str)) || ymd(new Date(str + 'T00:00')) !== str) throw new HttpError(400, 'week must be a real date (YYYY-MM-DD)');
  return +startOfWeek(new Date(str + 'T00:00'));
}

export function buildWeekReport(data, ws, now = Date.now(), { empIds } = {}){
  ws = new Date(ws);
  const key = ymd(ws), weekDays = [0, 1, 2, 3, 4, 5, 6].map(i => ymd(addDays(ws, i)));
  const calcs = calcAll(data, now, { from: +ws, to: +addDays(ws, 7) });
  const label = e => e ? (e.start ? `${e.type} ${e.start}–${e.end}` : e.type) : '';
  const shiftRow = s => { const calc = calcs.get(s.id);
    return { id: s.id, empId: s.empId, date: ymd(s.in), in: s.in, out: s.out, breaks: s.breaks, otApproved: !!s.otApproved, calc, rosterLabel: label(calc.roster) }; };
  let rows = week(data, ws, now)
    .filter(r => !empIds || empIds.includes(r.e.id))
    .map(r => ({
      empId: r.e.id, name: r.e.name, days: r.days, total: r.total, ded: r.ded, paid: r.paid,
      h1: r.h1, h2: r.h2, r1: r.r1, r2: r.r2, p1: r.p1, p2: r.p2, gross: r.gross, allow: r.allow, deduct: r.deduct, net: r.net, open: r.open,
      payType: r.e.payType ?? 'hourly', salary: r.salary, fixed: r.fixed, late: r.late, lateMin: r.lateMin, email: r.e.email ?? '',
      adjustments: data.adj[`${key}|${r.e.id}`] || [],
      roster: weekDays.map(day => (data.roster || {})[`${day}|${r.e.id}`] || []),
      shifts: [...r.shifts].sort((a, b) => a.in - b.in).map(shiftRow),
    }));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const names = new Map(data.employees.map(e => [e.id, e.name]));
  return {
    company: data.settings.company, currency: data.settings.currency, tierHours: data.settings.tierHours,
    weekStart: key, weekEnd: ymd(addDays(ws, 6)), weekDays, generatedAt: now,
    rows, totals: totals(rows),
    shiftsAll: rows.flatMap(r => r.shifts).sort((a, b) => a.in - b.in).map(s => ({ ...s, name: names.get(s.empId) })),
  };
}

// Week roster grid for the roster PDF (hours use the same break rules as pay).
export function buildRosterWeek(data, ws, now = Date.now()){
  const w = rosterWeek(data, new Date(ws));
  return { company: data.settings.company, weekStart: w.days[0], weekEnd: w.days[6], generatedAt: now,
    days: w.days, rows: [...w.rows].sort((a, b) => a.name.localeCompare(b.name)), staffPerDay: w.staffPerDay, total: w.total };
}
