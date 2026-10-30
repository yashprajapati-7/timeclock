// The only module that uses exceljs (4.4.0 is unmaintained; keep it swappable).
// Text is always written as plain string values, so names like "=HYPERLINK(...)" can never become formulas.
import ExcelJS from 'exceljs';
import { DAYS, hm } from '../shared/format.js';

export const PAYROLL_HEADER = tier => ['Employee', ...DAYS.map(d => `${d} paid hrs`), 'Worked hrs', 'Break deducted hrs', 'Paid hrs',
  `Hrs first ${tier}`, 'Rate 1', `Hrs after ${tier}`, 'Rate 2', 'Salary', 'Allowances', 'Deductions', 'Net pay'];

const HOURS = '0.00';
const moneyFmt = sym => { const s = `"${String(sym).replace(/"/g, '')}"`; return `${s}#,##0.00;-${s}#,##0.00`; };
const headerStyle = row => row.eachCell(c => {
  c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } };
  c.alignment = { vertical: 'middle', wrapText: true };
});

function payrollSheet(wb, report){
  const header = PAYROLL_HEADER(report.tierHours), money = moneyFmt(report.currency);
  const ws = wb.addWorksheet('Payroll', {
    views: [{ state: 'frozen', ySplit: 2 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.mergeCells(1, 1, 1, header.length);
  ws.getCell(1, 1).value = `${report.company} · Weekly payroll ${report.weekStart} – ${report.weekEnd}`;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  headerStyle(ws.addRow(header));
  // Column kinds after "Employee": 7 days + 3 hour totals + (hrs, rate, hrs, rate) + 4 money
  const kinds = [...Array(10).fill('h'), 'h', 'm', 'h', 'm', 'm', 'm', 'm', 'm'];
  ws.columns.forEach((col, i) => {
    col.width = i === 0 ? 24 : 12;
    if(i > 0) col.numFmt = kinds[i - 1] === 'h' ? HOURS : money;
  });
  for(const r of report.rows)
    ws.addRow([r.name, ...r.days, r.total, r.ded / 60, r.paid, r.h1, r.r1, r.h2, r.r2, r.salary, r.allow, r.deduct, r.net]);
  const first = 3, last = 2 + report.rows.length, T = report.totals;
  const salaryTotal = report.rows.reduce((a, r) => a + (r.salary ?? 0), 0);
  const cached = [...T.days, T.total, T.ded / 60, T.paid, T.h1, null, T.h2, null, salaryTotal, T.allow, T.deduct, T.net];
  const total = ws.addRow(['TOTAL', ...cached.map((result, i) => {
    if(result == null || !report.rows.length) return result ?? null;
    const L = ws.getColumn(i + 2).letter;
    return { formula: `SUM(${L}${first}:${L}${last})`, result };
  })]);
  total.font = { bold: true };
  total.eachCell(c => { c.border = { top: { style: 'medium' } }; });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: header.length } };
}

function shiftsSheet(wb, report){
  const ws = wb.addWorksheet('Shifts', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Employee', width: 24 }, { header: 'Date', width: 12 }, { header: 'In', width: 8 }, { header: 'Out', width: 10 },
    { header: 'Breaks', width: 26 }, { header: 'Worked hrs', width: 11, style: { numFmt: HOURS } },
    { header: 'Break taken min', width: 14 }, { header: 'Break by rule min', width: 15 }, { header: 'Deducted min', width: 13 },
    { header: 'Paid hrs', width: 10, style: { numFmt: HOURS } },
    { header: 'Rostered', width: 18 }, { header: 'Paid in', width: 9 }, { header: 'Paid out', width: 9 },
    { header: 'Late min', width: 9 }, { header: 'Overtime min', width: 13 },
  ];
  headerStyle(ws.getRow(1));
  for(const s of report.shiftsAll)
    ws.addRow([s.name, s.date, hm(s.in), s.out ? hm(s.out) : 'OPEN',
      s.breaks.map(b => `${hm(b.start)}–${b.end ? hm(b.end) : '…'}`).join('; '),
      s.calc.total, s.calc.actual, s.calc.policy, s.calc.ded, s.calc.paid,
      s.rosterLabel, hm(s.calc.paidIn), hm(s.calc.paidOut), s.calc.lateMin, s.calc.overMin]);
  ws.autoFilter = { from: 'A1', to: 'O1' };
}

function adjustmentsSheet(wb, report){
  const ws = wb.addWorksheet('Adjustments');
  ws.columns = [{ header: 'Employee', width: 24 }, { header: 'Type', width: 12 }, { header: 'Description', width: 30 },
    { header: 'Amount', width: 12, style: { numFmt: moneyFmt(report.currency) } }];
  headerStyle(ws.getRow(1));
  for(const r of report.rows){
    for(const a of r.adjustments) ws.addRow([r.name, a.type, a.label, Number(a.amount)]);
    for(const f of r.fixed || []) ws.addRow([r.name, `${f.type} (fixed)`, f.label, Number(f.amount)]);
  }
}

export async function payrollWorkbook(report){
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Time Clock';
  wb.created = new Date(report.generatedAt);
  payrollSheet(wb, report);
  shiftsSheet(wb, report);
  adjustmentsSheet(wb, report);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
