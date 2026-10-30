import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d, memDb, fixture } from './helpers.js';
import { importBackup } from '../src/backup.js';
import { loadData } from '../src/repo.js';
import { buildWeekReport } from '../src/reports/model.js';
import { payrollPdf, payslipsPdf, fontHasGlyph } from '../src/reports/pdf.js';

const ws = new Date(d(2026, 10, 26)), now = d(2026, 10, 30, 12);
const pages = buf => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
const isPdf = buf => buf.subarray(0, 5).toString() === '%PDF-' && buf.toString('latin1').trimEnd().endsWith('%%EOF');

async function report(){
  const db = memDb();
  await importBackup(db, fixture('backup-v2'), { now });
  return buildWeekReport(loadData(db), ws, now);
}

test('payroll and payslips are valid PDFs; one payslip page per employee', async () => {
  const r = await report();
  assert.ok(isPdf(await payrollPdf(r, { compress: false })));
  const slips = await payslipsPdf(r, 'all', { compress: false });
  assert.ok(isPdf(slips));
  assert.equal(pages(slips), r.rows.length);
  assert.equal(pages(await payslipsPdf(r, [r.rows[0].empId], { compress: false })), 1);
});

test('large payroll spans multiple pages', async () => {
  const r = await report();
  const row = r.rows[0];
  r.rows = Array.from({ length: 40 }, (_, i) => ({ ...row, empId: 'x' + i, name: `Person ${i}` }));
  assert.ok(pages(await payrollPdf(r, { compress: false })) > 1);
});

test('font renders ₹ and unknown employee → 404', async () => {
  assert.equal(fontHasGlyph(0x20B9), true);
  const r = await report();
  await assert.rejects(payslipsPdf(r, ['ghost']), e => e.status === 404);
});
