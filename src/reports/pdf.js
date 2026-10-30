// PDF exports with pdfkit. Tables are drawn with plain text + rules (pdfkit's newer doc.table is undocumented in the package).
import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { HttpError } from '../errors.js';
import { DAYS, fmtHM, fmtMin, hm, money } from '../shared/format.js';

const require = createRequire(import.meta.url);
// DejaVu Sans Mono covers ₹ € £, which the built-in PDF fonts (WinAnsi) do not.
const FONT = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSansMono-Bold.ttf');

export function fontHasGlyph(codePoint){
  // fontkit is pdfkit's own dependency: resolve it from pdfkit's location rather than assuming it is hoisted.
  const fontkit = createRequire(require.resolve('pdfkit'))('fontkit');
  return fontkit.openSync(FONT).hasGlyphForCodePoint(codePoint);
}

function newDoc(title, { layout = 'portrait', compress = true } = {}){
  const doc = new PDFDocument({ size: 'A4', layout, margin: 36, bufferPages: true, compress, info: { Title: title, Author: 'Time Clock' } });
  doc.registerFont('Mono', FONT);
  doc.registerFont('Mono-Bold', FONT_BOLD);
  doc.font('Mono');
  return doc;
}

function finish(doc){
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // "Page n of m" footers, written into the bottom margin without triggering a new page.
    const { start, count } = doc.bufferedPageRange();
    for(let i = start; i < start + count; i++){
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Mono').fontSize(7).fillColor('#555')
        .text(`Page ${i + 1} of ${count}`, doc.page.margins.left, doc.page.height - 24, { width: doc.page.width - doc.page.margins.left * 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

function header(doc, report, title, subtitle = ''){
  const x = doc.page.margins.left, w = doc.page.width - x * 2;
  doc.fillColor('#000').font('Mono-Bold').fontSize(14).text(report.company.toUpperCase(), x, doc.page.margins.top, { width: w });
  doc.font('Mono').fontSize(10).text(`${title} · ${report.weekStart} – ${report.weekEnd}${subtitle ? ' · ' + subtitle : ''}`, { width: w });
  doc.fontSize(7).fillColor('#555').text(`Generated ${new Date(report.generatedAt).toLocaleString()}`, { width: w });
  doc.moveDown(0.4);
  doc.moveTo(x, doc.y).lineTo(x + w, doc.y).lineWidth(2).strokeColor('#000').stroke();
  doc.moveDown(0.6).fillColor('#000');
}

// columns: [{ label, width, align }]; rows: arrays of strings; options.bold: set of row indexes.
function table(doc, columns, rows, { fontSize = 7, bold = new Set() } = {}){
  const x0 = doc.page.margins.left, rowH = fontSize + 7, width = columns.reduce((a, c) => a + c.width, 0);
  const drawRow = (cells, y, { head = false, strong = false } = {}) => {
    if(head) doc.rect(x0, y, width, rowH).fill('#000');
    let x = x0;
    doc.font(head || strong ? 'Mono-Bold' : 'Mono').fontSize(fontSize).fillColor(head ? '#fff' : '#000');
    cells.forEach((cell, i) => {
      const c = columns[i];
      doc.text(String(cell ?? ''), x + 2, y + 3.5, { width: c.width - 4, align: c.align ?? 'left', lineBreak: false, ellipsis: true, height: rowH });
      x += c.width;
    });
    doc.moveTo(x0, y + rowH).lineTo(x0 + width, y + rowH).lineWidth(strong ? 1.5 : 0.4).strokeColor('#000').stroke();
  };
  let y = doc.y;
  drawRow(columns.map(c => c.label), y, { head: true });
  y += rowH;
  rows.forEach((cells, i) => {
    if(y + rowH > doc.page.height - doc.page.margins.bottom){
      doc.addPage();
      y = doc.page.margins.top;
      drawRow(columns.map(c => c.label), y, { head: true });
      y += rowH;
    }
    drawRow(cells, y, { strong: bold.has(i) });
    y += rowH;
  });
  doc.x = x0;
  doc.y = y + 6;
}

export function payrollPdf(report, opts = {}){
  const doc = newDoc(`Weekly payroll ${report.weekStart}`, { ...opts, layout: 'landscape' });
  header(doc, report, 'Weekly payroll');
  const cur = report.currency, M = n => money(n, cur), tier = report.tierHours, R = 'right';
  const columns = [
    { label: 'Employee', width: 96 }, ...DAYS.map(d => ({ label: d, width: 30, align: R })),
    { label: 'Worked', width: 36, align: R }, { label: 'Break', width: 36, align: R }, { label: 'Paid', width: 36, align: R },
    { label: `≤${tier}h`, width: 36, align: R }, { label: 'Rate 1', width: 40, align: R },
    { label: `>${tier}h`, width: 36, align: R }, { label: 'Rate 2', width: 40, align: R },
    { label: 'Gross', width: 50, align: R }, { label: '+Allow', width: 44, align: R }, { label: '-Deduct', width: 44, align: R },
    { label: 'Net pay', width: 54, align: R },
  ];
  const line = (name, r) => [name, ...r.days.map(h => h ? fmtHM(h) : '–'), fmtHM(r.total), fmtMin(r.ded), fmtHM(r.paid),
    r.h1.toFixed(2), M(r.r1), r.h2.toFixed(2), M(r.r2), M(r.gross), M(r.allow), M(r.deduct), M(r.net)];
  const rows = report.rows.map(r => line(r.name, r));
  rows.push(line('TOTAL', { ...report.totals, r1: null, r2: null }));
  table(doc, columns, rows, { bold: new Set([rows.length - 1]) });
  doc.font('Mono').fontSize(7).fillColor('#555')
    .text(`Paid hours = worked − break deducted. Rate 1 applies to the first ${tier} paid hours of the week, Rate 2 after that.`);
  return finish(doc);
}

export function payslipsPdf(report, empIds = 'all', opts = {}){
  const rows = empIds === 'all' ? report.rows : report.rows.filter(r => empIds.includes(r.empId));
  if(empIds !== 'all' && rows.length !== empIds.length) return Promise.reject(new HttpError(404, 'Employee not found for this week'));
  if(!rows.length) return Promise.reject(new HttpError(404, 'No employees with data this week'));
  const doc = newDoc(`Payslips ${report.weekStart}`, opts);
  const M = n => money(n, report.currency), x = doc.page.margins.left, R = 'right';
  rows.forEach((r, i) => {
    if(i) doc.addPage();
    header(doc, report, 'Timesheet & payslip', r.name);
    const summary = [
      ['Paid hours', `${fmtHM(r.paid)} (${r.paid.toFixed(2)}h)`],
      [`First ${report.tierHours}h`, `${r.h1.toFixed(2)}h × ${M(r.r1)} = ${M(r.p1)}`],
      [`After ${report.tierHours}h`, `${r.h2.toFixed(2)}h × ${M(r.r2)} = ${M(r.p2)}`],
      ['Gross', M(r.gross)],
      ...r.adjustments.map(a => [a.type === 'allowance' ? `+ ${a.label}` : `− ${a.label}`, (a.type === 'allowance' ? '' : '-') + M(Number(a.amount))]),
    ];
    table(doc, [{ label: 'Pay summary', width: 260 }, { label: '', width: 200, align: R }], [...summary, ['NET PAY', M(r.net)]],
      { fontSize: 9, bold: new Set([summary.length]) });
    doc.moveDown(0.5);
    table(doc, [
      { label: 'Date', width: 80 }, { label: 'In', width: 50 }, { label: 'Out', width: 60 }, { label: 'Breaks', width: 140 },
      { label: 'Worked', width: 60, align: R }, { label: 'Deducted', width: 60, align: R }, { label: 'Paid', width: 60, align: R },
    ], r.shifts.map(s => [s.date, hm(s.in), s.out ? hm(s.out) + (new Date(s.out).getDate() !== new Date(s.in).getDate() ? ' +1d' : '') : 'OPEN',
      s.breaks.map(b => `${hm(b.start)}–${b.end ? hm(b.end) : '…'}`).join(', ') || '—',
      fmtHM(s.calc.total), fmtMin(s.calc.ded), fmtHM(s.calc.paid)]), { fontSize: 8 });
    doc.moveDown(3);
    const y = doc.y;
    doc.moveTo(x, y).lineTo(x + 200, y).lineWidth(0.8).stroke();
    doc.moveTo(x + 280, y).lineTo(x + 480, y).stroke();
    doc.font('Mono').fontSize(8).text('Employee signature', x, y + 4);
    doc.text('Manager signature', x + 280, y + 4);
  });
  return finish(doc);
}
