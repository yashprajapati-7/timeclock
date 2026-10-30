import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { d, memDb, fixture } from './helpers.js';
import { importBackup } from '../src/backup.js';
import { loadData } from '../src/repo.js';
import { buildWeekReport } from '../src/reports/model.js';
import { payrollWorkbook, PAYROLL_HEADER } from '../src/reports/xlsx.js';

const ws = new Date(d(2026, 10, 26)), now = d(2026, 10, 30, 12);
async function load(mutate = f => f){
  const db = memDb();
  await importBackup(db, mutate(fixture('backup-v2')), { now });
  const report = buildWeekReport(loadData(db), ws, now);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await payrollWorkbook(report));
  return { report, wb };
}

test('workbook structure and numbers', async () => {
  const { report, wb } = await load();
  assert.deepEqual(wb.worksheets.map(s => s.name), ['Payroll', 'Shifts', 'Adjustments']);
  const pay = wb.getWorksheet('Payroll');
  assert.deepEqual(pay.getRow(2).values.slice(1), PAYROLL_HEADER(24));
  const alice = report.rows.find(r => r.name === 'Alice Smith');
  const row = pay.getRows(3, report.rows.length).find(r => r.getCell(1).value === 'Alice Smith');
  const netCell = row.getCell(PAYROLL_HEADER(24).length);
  assert.equal(typeof netCell.value, 'number');
  assert.ok(Math.abs(netCell.value - alice.net) < 1e-9);
  assert.match(netCell.numFmt, /₹/);
  const total = pay.getRow(3 + report.rows.length).getCell(PAYROLL_HEADER(24).length).value;
  assert.match(total.formula, /^SUM\(/);
  assert.ok(Math.abs(total.result - report.totals.net) < 1e-9);
  assert.equal(pay.views[0].state, 'frozen');
  assert.equal(wb.getWorksheet('Shifts').rowCount, report.shiftsAll.length + 1);
  assert.equal(wb.getWorksheet('Adjustments').rowCount, 3);
});

test('text that looks like a formula is stored as plain text', async () => {
  const { wb } = await load(f => {
    f.employees[0].name = '=HYPERLINK("x")';
    f.adj['2026-10-26|e1'][0].label = '@cmd';
    return f;
  });
  const pay = wb.getWorksheet('Payroll');
  const cells = [];
  pay.eachRow(r => r.eachCell(c => cells.push(c)));
  const evil = cells.find(c => String(c.value).includes('HYPERLINK'));
  assert.equal(evil.value, '=HYPERLINK("x")');
  assert.equal(evil.formula, undefined);
  const adj = [];
  wb.getWorksheet('Adjustments').eachRow(r => r.eachCell(c => adj.push(c)));
  assert.ok(adj.some(c => c.value === '@cmd' && c.formula === undefined));
});
