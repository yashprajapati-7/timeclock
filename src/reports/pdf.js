// PDF exports with pdfkit. Tables are drawn with plain text + rules (pdfkit's newer doc.table is undocumented in the package).
import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { HttpError } from '../errors.js';
import { DAYS, fmtHM, fmtMin, hm, money, rosterLabel } from '../shared/format.js';
export { rosterLabel };

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

// ----- Text content (pure, so tests can check it without parsing the PDF) -----
export function payrollLine(r, report){
  const M = n => money(n, report.currency);
  return [r.name, ...r.days.map(h => h ? fmtHM(h) : '–'), fmtHM(r.total), fmtMin(r.ded), fmtHM(r.paid),
    r.h1.toFixed(2), M(r.r1), r.h2.toFixed(2), M(r.r2), r.salary == null ? '' : M(r.salary), M(r.allow), M(r.deduct), M(r.net)];
}
export function payslipSummary(r, report){
  const M = n => money(n, report.currency), tier = report.tierHours;
  const signed = (type, amount) => (type === 'allowance' ? '' : '-') + M(Number(amount));
  return [
    ['Paid hours', `${fmtHM(r.paid)} (${r.paid.toFixed(2)}h)${r.late ? ` · late ${r.late}×` : ''}`],
    ...(r.payType === 'salary'
      ? [['Weekly salary', M(r.salary ?? 0)]]
      : [[`First ${tier}h`, `${r.h1.toFixed(2)}h × ${M(r.r1)} = ${M(r.p1)}`], [`After ${tier}h`, `${r.h2.toFixed(2)}h × ${M(r.r2)} = ${M(r.p2)}`]]),
    ['Gross pay', M(r.gross)],
    ...(r.fixed || []).map(f => [`${f.type === 'allowance' ? '+' : '−'} ${f.label} (fixed)`, signed(f.type, f.amount)]),
    ...r.adjustments.map(a => [`${a.type === 'allowance' ? '+' : '−'} ${a.label}`, signed(a.type, a.amount)]),
  ];
}
export function timesheetRow(s){
  const c = s.calc, rounded = c.paidIn !== s.in || c.paidOut !== (s.out ?? c.paidOut);
  const tags = [c.lateMin > 0 && c.paidIn > s.in ? 'LATE' : '', c.capped ? `OVER ${c.capped}m` : '', c.earlyMin ? 'EARLY' : ''].filter(Boolean).join(' ');
  return [s.date, hm(s.in), s.out ? hm(s.out) + (new Date(s.out).getDate() !== new Date(s.in).getDate() ? ' +1d' : '') : 'OPEN',
    rounded || tags ? `${hm(c.paidIn)}–${hm(c.paidOut)}${tags ? ' ' + tags : ''}` : '—',
    s.breaks.map(b => `${hm(b.start)}–${b.end ? hm(b.end) : '…'}`).join(', ') || '—',
    fmtHM(c.total), fmtMin(c.ded), fmtHM(c.paid)];
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
    { label: 'Salary', width: 50, align: R }, { label: '+Allow', width: 44, align: R }, { label: '-Deduct', width: 44, align: R },
    { label: 'Net pay', width: 54, align: R },
  ];
  const rows = report.rows.map(r => payrollLine(r, report));
  const salary = report.rows.reduce((a, r) => a + (r.salary ?? 0), 0);
  rows.push(payrollLine({ ...report.totals, name: 'TOTAL', r1: 0, r2: 0, salary }, report));
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
    const summary = payslipSummary(r, report);
    table(doc, [{ label: 'Pay summary', width: 260 }, { label: '', width: 200, align: R }], [...summary, ['NET PAY', M(r.net)]],
      { fontSize: 9, bold: new Set([summary.length]) });
    doc.moveDown(0.5);
    table(doc, [
      { label: 'Date', width: 64 }, { label: 'In', width: 38 }, { label: 'Out', width: 50 }, { label: 'Paid time', width: 110 },
      { label: 'Breaks', width: 84 }, { label: 'Worked', width: 50, align: R }, { label: 'Deducted', width: 54, align: R }, { label: 'Paid', width: 50, align: R },
    ], r.shifts.map(timesheetRow), { fontSize: 8 });
    doc.moveDown(3);
    const y = doc.y;
    doc.moveTo(x, y).lineTo(x + 200, y).lineWidth(0.8).stroke();
    doc.moveTo(x + 280, y).lineTo(x + 480, y).stroke();
    doc.font('Mono').fontSize(8).text('Employee signature', x, y + 4);
    doc.text('Manager signature', x + 280, y + 4);
  });
  return finish(doc);
}

// ----- Roster week (A4 landscape grid, colour-coded like the old roster app) -----
const ROSTER_COLORS = {
  CAFE: ['#EFF8F3', '#1A5C36'], BAKERY: ['#FCE7F3', '#9D174D'], 'BAKERY YC': ['#FCE7F3', '#9D174D'],
  TRAINING: ['#EDE9FE', '#5B21B6'], DELIVERY: ['#FFF3E0', '#B45309'], BAKE: ['#FEF9EE', '#92400E'], OFF: ['#E8E8E8', '#555555'],
};

export function rosterPdf(model, opts = {}){
  const doc = newDoc(`Roster ${model.weekStart}`, { ...opts, layout: 'landscape' });
  header(doc, { ...model, weekStart: model.weekStart, weekEnd: model.weekEnd }, 'Roster');
  const x0 = doc.page.margins.left, nameW = 110, hoursW = 50;
  const dayW = (doc.page.width - x0 * 2 - nameW - hoursW) / 7, headH = 22, bottom = () => doc.page.height - doc.page.margins.bottom;
  const drawHead = y => {
    doc.rect(x0, y, nameW + dayW * 7 + hoursW, headH).fill('#000');
    doc.font('Mono-Bold').fontSize(8).fillColor('#fff').text('STAFF', x0 + 4, y + 7, { width: nameW - 8, lineBreak: false });
    model.days.forEach((dd, i) => doc.text(`${DAYS[i]} ${dd.slice(8)}/${dd.slice(5, 7)}`, x0 + nameW + dayW * i, y + 7, { width: dayW, align: 'center', lineBreak: false }));
    doc.text('HRS', x0 + nameW + dayW * 7, y + 7, { width: hoursW - 4, align: 'right', lineBreak: false });
    doc.fillColor('#000');
    return y + headH;
  };
  let y = drawHead(doc.y);
  for(const r of model.rows){
    const lines = Math.max(1, ...r.cells.map(c => c.length));
    const rowH = 8 + lines * 11;
    if(y + rowH > bottom()){ doc.addPage(); y = drawHead(doc.page.margins.top); }
    doc.font('Mono-Bold').fontSize(8).fillColor('#000').text(r.name, x0 + 4, y + 5, { width: nameW - 8, lineBreak: false, ellipsis: true });
    r.cells.forEach((entries, i) => {
      const cx = x0 + nameW + dayW * i;
      entries.forEach((e, j) => {
        const [bg, fg] = ROSTER_COLORS[e.type] ?? ['#F5F5F5', '#333333'];
        const ey = y + 3 + j * 11;
        doc.rect(cx + 2, ey, dayW - 4, 10).fill(bg);
        doc.save().rect(cx + 2, ey, dayW - 4, 10).clip();
        doc.font('Mono-Bold').fontSize(7).fillColor(fg).text(rosterLabel(e), cx + 3, ey + 2, { width: dayW - 6, align: 'center', lineBreak: false });
        doc.restore();
      });
    });
    doc.font('Mono').fontSize(8).fillColor('#000').text(r.total ? r.total.toFixed(1) : '–', x0 + nameW + dayW * 7, y + 5, { width: hoursW - 4, align: 'right', lineBreak: false });
    doc.moveTo(x0, y + rowH).lineTo(x0 + nameW + dayW * 7 + hoursW, y + rowH).lineWidth(0.4).strokeColor('#000').stroke();
    y += rowH;
  }
  if(y + 16 > bottom()){ doc.addPage(); y = doc.page.margins.top; }
  doc.font('Mono-Bold').fontSize(8).fillColor('#000').text('STAFF ON', x0 + 4, y + 5, { width: nameW, lineBreak: false });
  model.staffPerDay.forEach((n, i) => doc.text(String(n), x0 + nameW + dayW * i, y + 5, { width: dayW, align: 'center', lineBreak: false }));
  doc.text(model.total.toFixed(1), x0 + nameW + dayW * 7, y + 5, { width: hoursW - 4, align: 'right', lineBreak: false });
  return finish(doc);
}
