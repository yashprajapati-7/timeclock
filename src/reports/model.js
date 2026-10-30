// One report model feeds both the Excel and the PDF exports, built only from pay.js so numbers match the UI.
import { HttpError } from '../errors.js';
import { week, totals, shift as calcShift } from '../shared/pay.js';
import { ymd, addDays, startOfWeek } from '../shared/format.js';

export function parseWeekParam(str, now = Date.now()){
  if(str == null || str === '') return +startOfWeek(now);
  // Round-trip check rejects impossible dates like 2026-02-31 (which Date would roll into March).
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(str)) || ymd(new Date(str + 'T00:00')) !== str) throw new HttpError(400, 'week must be a real date (YYYY-MM-DD)');
  return +startOfWeek(new Date(str + 'T00:00'));
}

export function buildWeekReport(data, ws, now = Date.now(), { empIds } = {}){
  ws = new Date(ws);
  const key = ymd(ws);
  const shiftRow = s => ({ id: s.id, empId: s.empId, date: ymd(s.in), in: s.in, out: s.out, breaks: s.breaks, calc: calcShift(s, data.settings, now) });
  let rows = week(data, ws, now)
    .filter(r => !empIds || empIds.includes(r.e.id))
    .map(r => ({
      empId: r.e.id, name: r.e.name, days: r.days, total: r.total, ded: r.ded, paid: r.paid,
      h1: r.h1, h2: r.h2, r1: r.r1, r2: r.r2, p1: r.p1, p2: r.p2, gross: r.gross, allow: r.allow, deduct: r.deduct, net: r.net, open: r.open,
      adjustments: data.adj[`${key}|${r.e.id}`] || [],
      shifts: [...r.shifts].sort((a, b) => a.in - b.in).map(shiftRow),
    }));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const names = new Map(data.employees.map(e => [e.id, e.name]));
  return {
    company: data.settings.company, currency: data.settings.currency, tierHours: data.settings.tierHours,
    weekStart: key, weekEnd: ymd(addDays(ws, 6)), generatedAt: now,
    rows, totals: totals(rows),
    shiftsAll: rows.flatMap(r => r.shifts).sort((a, b) => a.in - b.in).map(s => ({ ...s, name: names.get(s.empId) })),
  };
}
