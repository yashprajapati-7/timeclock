import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d, memDb, fixture } from './helpers.js';
import { importBackup } from '../src/backup.js';
import { loadData } from '../src/repo.js';
import { week, totals } from '../src/shared/pay.js';
import { buildWeekReport, parseWeekParam } from '../src/reports/model.js';

const ws = new Date(d(2026, 10, 26)), now = d(2026, 10, 30, 12);
export async function fixtureReport(){
  const db = memDb();
  await importBackup(db, fixture('backup-v2'), { now });
  return { db, report: buildWeekReport(loadData(db), ws, now) };
}

test('report numbers equal pay.week numbers', async () => {
  const { db, report } = await fixtureReport();
  const T = totals(week(loadData(db), ws, now));
  assert.ok(Math.abs(report.totals.net - T.net) < 1e-9);
  assert.equal(report.weekStart, '2026-10-26');
  assert.equal(report.weekEnd, '2026-11-01');
  assert.equal(report.currency, '₹');
});

test('rows sorted by name, shifts scoped to employee and week', async () => {
  const { report } = await fixtureReport();
  const names = report.rows.map(r => r.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  for(const r of report.rows) assert.ok(r.shifts.every(s => s.empId === r.empId));
  const bob = report.rows.find(r => r.name === 'Bob Jones');
  const overnight = bob.shifts.find(s => s.date === '2026-11-01');
  assert.equal(new Date(overnight.out).getDate(), 2);
  assert.equal(report.shiftsAll.length, 6);
  assert.ok(report.rows.find(r => r.name === 'Alice Smith').adjustments.length === 1);
});

test('empIds filter', async () => {
  const { report: full, db } = await fixtureReport();
  const one = buildWeekReport(loadData(db), ws, now, { empIds: [full.rows[0].empId] });
  assert.equal(one.rows.length, 1);
});

test('parseWeekParam', () => {
  assert.equal(parseWeekParam('2026-10-29'), d(2026, 10, 26));
  assert.throws(() => parseWeekParam('bad'), e => e.status === 400);
  assert.equal(parseWeekParam(undefined, d(2026, 10, 30, 9)), d(2026, 10, 26));
});
