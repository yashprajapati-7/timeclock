// Reports with salary, fixed items, roster rounding and no Gross column (plan Tasks 25–27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { d, memDb } from './helpers.js';
import * as R from '../src/repo.js';
import { buildWeekReport } from '../src/reports/model.js';
import { payrollWorkbook, PAYROLL_HEADER } from '../src/reports/xlsx.js';
import { payrollLine, payslipSummary, timesheetRow, payslipDays, payrollPdf, payslipsPdf } from '../src/reports/pdf.js';

const NOW = d(2026, 10, 30, 20);
function report(){
  const db = memDb();
  R.setSettings(db, { roundFrom: '2026-10-26', breakMode: 'policy' });
  R.createEmployee(db, { id: 'sal', name: 'Sal', pin: '1111', active: true, payType: 'salary', weeklySalary: 800,
    fixedItems: [{ type: 'allowance', label: 'Phone', amount: 10, from: '2026-10-26' }] }, 0);
  R.createEmployee(db, { id: 'bob', name: 'Bob', pin: '2222', rate1: 20, rate2: 30, active: true }, 1);
  R.replaceRosterCell(db, 'bob', '2026-10-27', [{ type: 'CAFE', start: '09:00', end: '17:00' }]);
  R.saveShift(db, { id: 'b1', empId: 'bob', in: d(2026, 10, 27, 9, 8), out: d(2026, 10, 27, 17, 20), breaks: [] });
  return buildWeekReport(R.loadData(db), d(2026, 10, 26), NOW);
}

test('model exposes salary, fixed items, late counts and paid in/out', () => {
  const rep = report();
  const sal = rep.rows.find(r => r.empId === 'sal'), bob = rep.rows.find(r => r.empId === 'bob');
  assert.deepEqual([sal.payType, sal.salary, sal.net, sal.fixed.length], ['salary', 800, 810, 1]);
  assert.equal(bob.salary, null);
  assert.deepEqual([bob.late, bob.lateMin], [1, 8]);
  const s = bob.shifts[0];
  assert.equal(s.calc.paidIn, d(2026, 10, 27, 9, 15));
  assert.equal(s.calc.paidOut, d(2026, 10, 27, 17, 15));
  assert.equal(s.calc.overMin, 20);
  assert.equal(s.rosterLabel, 'CAFE 09:00–17:00');
});

test('Excel: Salary replaces Gross; shifts show paid times; fixed items listed', async () => {
  const rep = report();
  assert.ok(!PAYROLL_HEADER(24).includes('Gross'));
  assert.ok(PAYROLL_HEADER(24).includes('Salary'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await payrollWorkbook(rep));
  const pay = wb.getWorksheet('Payroll');
  const col = PAYROLL_HEADER(24).indexOf('Salary') + 1;
  const salRow = pay.getRows(3, rep.rows.length).find(r => r.getCell(1).value === 'Sal');
  assert.equal(salRow.getCell(col).value, 800);
  const shifts = wb.getWorksheet('Shifts');
  const head = shifts.getRow(1).values.slice(1);
  assert.ok(head.includes('Paid in') && head.includes('Paid out') && head.includes('Late min') && head.includes('Overtime min'));
  assert.equal(shifts.getRow(2).getCell(head.indexOf('Paid in') + 1).value, '09:15');
  const adj = [];
  wb.getWorksheet('Adjustments').eachRow(r => adj.push(r.values.slice(1)));
  assert.ok(adj.some(r => r[0] === 'Sal' && r[1] === 'allowance (fixed)' && r[2] === 'Phone' && r[3] === 10));
});

test('PDF lines: payroll has Salary not Gross; payslip keeps Gross pay and shows salary, fixed items and paid times', async () => {
  const rep = report();
  const cur = rep.currency;
  const sal = rep.rows.find(r => r.empId === 'sal'), bob = rep.rows.find(r => r.empId === 'bob');
  assert.ok(payrollLine(sal, rep).includes(`${cur}800.00`));
  const salSlip = payslipSummary(sal, rep).map(([k]) => k);
  assert.ok(salSlip.includes('Weekly salary'));
  assert.ok(salSlip.includes('Gross pay'));
  assert.ok(salSlip.some(k => k === '+ Phone (fixed)'));
  assert.ok(!salSlip.some(k => /First 24h/.test(k)));
  assert.ok(payslipSummary(bob, rep).some(([k]) => /First 24h/.test(k)));
  assert.match(timesheetRow(bob.shifts[0]).join(' | '), /09:15–17:15 LATE OT 20m/);
  assert.equal((await payrollPdf(rep)).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await payslipsPdf(rep)).subarray(0, 5).toString(), '%PDF-');
});

test('roster PDF: cell labels like the old app, valid PDF, route 200/400/401', async () => {
  const { rosterLabel, rosterPdf } = await import('../src/reports/pdf.js');
  const { buildRosterWeek } = await import('../src/reports/model.js');
  assert.equal(rosterLabel({ type: 'CAFE', start: '09:00', end: '17:00' }), '9A–5P');
  assert.equal(rosterLabel({ type: 'BAKERY', start: '05:00', end: '13:30' }), 'Bakery 5A–1:30P');
  assert.equal(rosterLabel({ type: 'TRAINING', start: '10:00', end: '14:00' }), 'TRN 10A–2P');
  assert.equal(rosterLabel({ type: 'BAKERY YC' }), 'BKY YC');
  assert.equal(rosterLabel({ type: 'OFF' }), 'OFF');
  const db = memDb();
  R.createEmployee(db, { id: 'a', name: 'Aka', pin: '1111', active: true }, 0);
  R.replaceRosterCell(db, 'a', '2026-10-27', [{ type: 'CAFE', start: '09:00', end: '17:00' }]);
  const model = buildRosterWeek(R.loadData(db), d(2026, 10, 26), NOW);
  assert.equal(model.rows[0].total, 7);
  assert.equal((await rosterPdf(model)).subarray(0, 5).toString(), '%PDF-');
  const { makeTestApp, loginAgent, binary } = await import('./helpers.js');
  const { default: request } = await import('supertest');
  const { app } = await makeTestApp();
  assert.equal((await request(app).get('/api/admin/export/roster.pdf')).status, 401);
  const ag = await loginAgent(app);
  const ok = await ag.get('/api/admin/export/roster.pdf?week=2026-10-26').buffer(true).parse(binary);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'application/pdf');
  assert.equal((await ag.get('/api/admin/export/roster.pdf?week=bad')).status, 400);
});

test('roster PDF: staff page has no hours; a separate admin overview page lists everyone\'s hours', async () => {
  const { rosterPdf, rosterOverviewRows } = await import('../src/reports/pdf.js');
  const { buildRosterWeek } = await import('../src/reports/model.js');
  const db = memDb();
  R.createEmployee(db, { id: 'a', name: 'Aka', pin: '1111', active: true }, 0);
  R.createEmployee(db, { id: 'b', name: 'Bea', pin: '2222', active: true }, 1);
  R.replaceRosterCell(db, 'a', '2026-10-27', [{ type: 'CAFE', start: '09:00', end: '17:00' }]);
  R.replaceRosterCell(db, 'a', '2026-10-28', [{ type: 'OFF' }]);
  R.replaceRosterCell(db, 'b', '2026-10-26', [{ type: 'BAKERY', start: '05:00', end: '09:00' }]);
  const model = buildRosterWeek(R.loadData(db), d(2026, 10, 26), NOW);
  const rows = rosterOverviewRows(model);
  assert.deepEqual(rows[0], ['Aka', '–', '7.0', '–', '–', '–', '–', '–', '7.0', '1']);
  assert.deepEqual(rows[1], ['Bea', '3.8', '–', '–', '–', '–', '–', '–', '3.8', '0']);
  assert.deepEqual(rows.at(-1), ['TOTAL', '3.8', '7.0', '–', '–', '–', '–', '–', '10.8', '']);
  const pdf = (await rosterPdf(model, { compress: false })).toString('latin1');
  assert.equal(pdf.match(/\/Type \/Page\b(?!s)/g).length, 2);
});

test('roster PDF uses the GJ06 layout: week title, day headings and cell text like the old app', async () => {
  const { gj06Label, gj06WeekTitle, gj06DayHead, rosterFileName } = await import('../src/reports/pdf.js');
  assert.equal(gj06Label({ type: 'CAFE', start: '09:30', end: '16:30' }), '9:30A–4:30P');
  assert.equal(gj06Label({ type: 'BAKERY', start: '07:00', end: '12:00' }), 'Bakery 7A–12P');
  assert.equal(gj06Label({ type: 'TRAINING', start: '10:00', end: '14:00' }), 'Training 10A–2P');
  assert.equal(gj06Label({ type: 'OFF' }), 'Off');
  assert.equal(gj06Label({ type: 'BAKERY YC' }), 'Bakery YC');
  assert.equal(gj06Label({ type: 'DELIVERY' }), 'Delivery');
  assert.equal(gj06WeekTitle('2026-11-02', '2026-11-08'), 'WEEK 02/11/26 - 08/11/26');
  assert.deepEqual(['2026-11-02', '2026-11-05', '2026-11-08'].map((d, i) => gj06DayHead(d, [0, 3, 6][i])), [['MON', '2 Nov'], ['THUR', '5 Nov'], ['SUNDAY', '8 Nov']]);
  assert.equal(rosterFileName('2026-11-02', '2026-11-08'), 'GJ06_Roster_WEEK_02-11-26_-_08-11-26.pdf');
});

test('payslip timesheet lists all 7 days: worked, OFF, rostered but absent, nothing', () => {
  const db = memDb();
  R.setSettings(db, { roundFrom: '2026-10-26', breakMode: 'policy' });
  R.createEmployee(db, { id: 'bob', name: 'Bob', pin: '2222', rate1: 20, rate2: 30, active: true }, 0);
  R.replaceRosterCell(db, 'bob', '2026-10-27', [{ type: 'CAFE', start: '09:00', end: '17:00' }]);
  R.replaceRosterCell(db, 'bob', '2026-10-28', [{ type: 'OFF' }]);
  R.replaceRosterCell(db, 'bob', '2026-10-29', [{ type: 'BAKERY', start: '05:00', end: '13:00' }]);
  R.saveShift(db, { id: 'b1', empId: 'bob', in: d(2026, 10, 27, 9, 8), out: d(2026, 10, 27, 17), breaks: [] });
  const rep = buildWeekReport(R.loadData(db), d(2026, 10, 26), NOW);
  const rows = payslipDays(rep.rows[0], rep);
  assert.equal(rows.length, 7);
  assert.match(rows[0][0], /^Mon 26\/10/);
  assert.equal(rows[0][1], '—');
  assert.equal(rows[1][1], '9A–5P');
  assert.equal(rows[1][2], '09:08');
  assert.match(rows[1][4], /LATE/);
  assert.equal(rows[2][1], 'OFF');
  assert.equal(rows[2][2], 'OFF');
  assert.equal(rows[3][2], 'ABSENT');
});

test('payslip has no signature lines; payroll PDF has no instruction footnote', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/reports/pdf.js', import.meta.url), 'utf8');
  assert.ok(!/signature/i.test(src));
  assert.ok(!src.includes('Paid hours = worked'));
});

test('payslip does not mark today or later rostered days ABSENT', () => {
  const weekDays = [26, 27, 28, 29, 30, 31].map(n => `2026-10-${n}`).concat('2026-11-01');
  const report = { weekDays, generatedAt: d(2026, 10, 28, 12) };
  const r = { roster: Array(7).fill([{ type: 'CAFE', start: '09:00', end: '17:00' }]), shifts: [] };
  assert.deepEqual(payslipDays(r, report).map(x => x[2]), ['ABSENT', 'ABSENT', '—', '—', '—', '—', '—']);
});
