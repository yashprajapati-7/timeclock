// PDF exports with pdfkit. Tables are drawn with plain text + rules (pdfkit's newer doc.table is undocumented in the package).
import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../errors.js';
import { DAYS, fmtHM, fmtMin, hm, money, rosterLabel, ymd } from '../shared/format.js';
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
      : r.payType === 'fixed' ? [['All hours', `${r.paid.toFixed(2)}h × ${M(r.r1)} = ${M(r.p1 + r.p2)}`]]
      : [[`First ${tier}h`, `${r.h1.toFixed(2)}h × ${M(r.r1)} = ${M(r.p1)}`], [`After ${tier}h`, `${r.h2.toFixed(2)}h × ${M(r.r2)} = ${M(r.p2)}`]]),
    ['Gross pay', M(r.gross)],
    ...(r.fixed || []).map(f => [`${f.type === 'allowance' ? '+' : '−'} ${f.label} (fixed)`, signed(f.type, f.amount)]),
    ...r.adjustments.map(a => [`${a.type === 'allowance' ? '+' : '−'} ${a.label}`, signed(a.type, a.amount)]),
  ];
}
export function timesheetRow(s){
  const c = s.calc, rounded = c.paidIn !== s.in || c.paidOut !== (s.out ?? c.paidOut);
  const tags = [c.lateMin > 0 && c.paidIn > s.in ? 'LATE' : '', c.overMin ? `OT ${c.overMin}m` : '', c.earlyMin ? 'EARLY' : ''].filter(Boolean).join(' ');
  return [s.date, hm(s.in), s.out ? hm(s.out) + (new Date(s.out).getDate() !== new Date(s.in).getDate() ? ' +1d' : '') : 'OPEN',
    rounded || tags ? `${hm(c.paidIn)}–${hm(c.paidOut)}${tags ? ' ' + tags : ''}` : '—',
    s.breaks.map(b => `${hm(b.start)}–${b.end ? hm(b.end) : '…'}`).join(', ') || '—',
    fmtHM(c.total), fmtMin(c.ded), fmtHM(c.paid)];
}

// Payslip timesheet: one line per day Mon–Sun (each shift on its own line), with the roster, OFF and no-shows shown.
export function payslipDays(r, report){
  return report.weekDays.flatMap((day, i) => {
    const name = `${DAYS[i]} ${day.slice(8)}/${day.slice(5, 7)}`, entries = r.roster?.[i] ?? [];
    const planned = entries.map(rosterLabel).join(', ') || '—', shifts = r.shifts.filter(s => s.date === day);
    if(shifts.length) return shifts.map(s => [name, planned, ...timesheetRow(s).slice(1)]);
    const off = entries.length && entries.every(e => e.type === 'OFF'), timed = entries.some(e => e.start);
    const future = day >= ymd(report.generatedAt);         // not over yet: not an absence
    return [[name, planned, off ? 'OFF' : timed && !future ? 'ABSENT' : '—', '', '', '', '', '', '']];
  });
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
  return finish(doc);
}

export function payslipsPdf(report, empIds = 'all', opts = {}){
  const rows = empIds === 'all' ? report.rows : report.rows.filter(r => empIds.includes(r.empId));
  if(empIds !== 'all' && rows.length !== empIds.length) return Promise.reject(new HttpError(404, 'Employee not found for this week'));
  if(!rows.length) return Promise.reject(new HttpError(404, 'No employees with data this week'));
  const doc = newDoc(`Payslips ${report.weekStart}`, opts);
  const M = n => money(n, report.currency), R = 'right';
  rows.forEach((r, i) => {
    if(i) doc.addPage();
    header(doc, report, 'Timesheet & payslip', r.name);
    const summary = payslipSummary(r, report);
    table(doc, [{ label: 'Pay summary', width: 260 }, { label: '', width: 200, align: R }], [...summary, ['NET PAY', M(r.net)]],
      { fontSize: 9, bold: new Set([summary.length]) });
    doc.moveDown(0.5);
    table(doc, [
      { label: 'Day', width: 56 }, { label: 'Roster', width: 76 }, { label: 'In', width: 38 }, { label: 'Out', width: 44 }, { label: 'Paid time', width: 96 },
      { label: 'Breaks', width: 62 }, { label: 'Worked', width: 46, align: R }, { label: 'Deducted', width: 48, align: R }, { label: 'Paid', width: 46, align: R },
    ], payslipDays(r, report), { fontSize: 8 });
  });
  return finish(doc);
}

// ----- Roster week: page 1 copies the old GJ06 roster app's PDF (jsPDF, mm units), page 2 is the admin overview -----
const LOGO = fileURLToPath(new URL('./gj06-logo.jpg', import.meta.url));
const SANS = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const SANS_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');
const GJ06_DAYS = ['MON', 'TUE', 'WED', 'THUR', 'FRI', 'SAT', 'SUNDAY'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const t12 = hhmm => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'A' : 'P'}`; };
export function gj06Label(e){
  const span = e.start ? `${t12(e.start)}–${t12(e.end)}` : '';
  return { CAFE: span, BAKERY: `Bakery ${span}`, TRAINING: `Training ${span}`, DELIVERY: 'Delivery', BAKE: 'Bake', 'BAKERY YC': 'Bakery YC', OFF: 'Off' }[e.type] ?? e.type;
}
const dmy = d => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
export const gj06WeekTitle = (from, to) => `WEEK ${dmy(from)} - ${dmy(to)}`;
export const gj06DayHead = (day, i) => [GJ06_DAYS[i], `${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`];
export const rosterFileName = (from, to) => `GJ06_Roster_${gj06WeekTitle(from, to).replace(/\s/g, '_').replace(/\//g, '-')}.pdf`;

// Admin-only overview page: rostered hours per day, week total and days off for each staff member.
const hrs = h => h ? h.toFixed(1) : '–';
export function rosterOverviewRows(model){
  return [
    ...model.rows.map(r => [r.name, ...r.days.map(hrs), hrs(r.total), String(r.offDays)]),
    ['TOTAL', ...model.days.map((_, i) => hrs(model.rows.reduce((a, r) => a + r.days[i], 0))), hrs(model.total), ''],
  ];
}

// The roster PDF is sent to staff, so it is one page with no hours (hours: rosterHoursPdf).
export function rosterPdf(model, opts = {}){
  const doc = newDoc(`Roster ${model.weekStart}`, { ...opts, layout: 'landscape' });
  doc.registerFont('Sans', SANS);
  doc.registerFont('Sans-Bold', SANS_BOLD);
  const mm = v => v * 72 / 25.4;
  // jsPDF places text by its baseline; pdfkit by the top of the line box.
  const say = (str, x, baseline, size, { bold = true, align = 'left', w = 0, color = '#000' } = {}) => {
    doc.font(bold ? 'Sans-Bold' : 'Sans').fontSize(size).fillColor(color);
    const top = baseline - size * 0.76;
    if(align === 'center') doc.text(str, x - w / 2, top, { width: w, align: 'center', lineBreak: false });
    else doc.text(str, x, top, { lineBreak: false });
  };
  const pW = mm(297), pH = mm(210), mL = mm(8), mT = mm(8), uW = pW - mL * 2;
  const margin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;      // the grid runs to 9 mm from the edge; stop pdfkit adding a page for the last row
  try{ doc.image(LOGO, mL, mT, { width: mm(22), height: mm(15) }); }catch{ /* no logo: layout stays the same */ }
  doc.lineWidth(mm(0.5)).strokeColor('#000');
  const hx = pW / 2 - mm(25), hy = mT;
  doc.rect(hx, hy, mm(50), mm(8)).stroke();
  say('Roaster for;', pW / 2, hy + mm(5.5), 10, { align: 'center', w: mm(50) });
  doc.rect(pW / 2 - mm(38), hy + mm(10), mm(76), mm(8)).stroke();
  say(gj06WeekTitle(model.weekStart, model.weekEnd), pW / 2, hy + mm(15.5), 9, { align: 'center', w: mm(76) });

  const rows = model.rows, tT = mT + mm(22), nW = mm(22), dW = (uW - nW) / 7;
  const rH = (pH - tT - mm(9)) / (rows.length + 1);     // 9 mm at the bottom leaves room for the page number
  const colLines = (y, h) => { doc.moveTo(mL + nW, y).lineTo(mL + nW, y + h); for(let i = 1; i < 7; i++) doc.moveTo(mL + nW + i * dW, y).lineTo(mL + nW + i * dW, y + h); };
  doc.rect(mL, tT, uW, rH).fill('#000');
  say('NAME', mL + mm(2), tT + rH * 0.65, 7, { color: '#fff' });
  model.days.forEach((day, i) => {
    const [name, date] = gj06DayHead(day, i), cx = mL + nW + i * dW + dW / 2;
    say(name, cx, tT + rH * 0.38, 7, { align: 'center', w: dW, color: '#fff' });
    say(date, cx, tT + rH * 0.76, 5.5, { bold: false, align: 'center', w: dW, color: '#fff' });
  });
  doc.lineWidth(mm(0.4)).strokeColor('#000').rect(mL, tT, uW, rH).stroke();
  colLines(tT, rH); doc.stroke();
  rows.forEach((r, ri) => {
    const ry = tT + rH * (ri + 1);
    if(ri % 2 === 0) doc.rect(mL, ry, uW, rH).fill('#FAFAFA');
    say(r.name.toUpperCase(), mL + mm(2), ry + rH * 0.65, 7);
    r.cells.forEach((entries, ci) => {
      const cx = mL + nW + ci * dW + dW / 2, lh = mm(3.4);
      entries.forEach((e, si) => say(gj06Label(e), cx, ry + rH * 0.5 + (si - (entries.length - 1) / 2) * lh,
        e.type === 'TRAINING' ? 4.5 : 5.5, { bold: ['CAFE', 'BAKERY'].includes(e.type), align: 'center', w: dW }));
    });
    doc.lineWidth(mm(0.2)).strokeColor('#B4B4B4').rect(mL, ry, uW, rH).stroke();
    colLines(ry, rH); doc.stroke();
  });
  doc.lineWidth(mm(0.6)).strokeColor('#000').rect(mL, tT, uW, rH * (rows.length + 1)).stroke();
  doc.page.margins.bottom = margin;
  return finish(doc);
}

// Admin-only hours overview: a separate download, so the roster PDF can be sent to staff as it is.
export function rosterHoursPdf(model, opts = {}){
  const doc = newDoc(`Roster hours ${model.weekStart}`, { ...opts, layout: 'landscape' });
  header(doc, model, 'Roster hours', 'admin only');
  const ovDayW = 64, overview = rosterOverviewRows(model);
  table(doc, [
    { label: 'Staff', width: 192 }, ...model.days.map((dd, i) => ({ label: `${DAYS[i]} ${dd.slice(8)}/${dd.slice(5, 7)}`, width: ovDayW, align: 'right' })),
    { label: 'Total hrs', width: 70, align: 'right' }, { label: 'Days off', width: 60, align: 'right' },
  ], overview, { fontSize: 9, bold: new Set([overview.length - 1]) });
  doc.font('Mono').fontSize(8).fillColor('#555')
    .text('Hours are rostered hours after the unpaid-break rules, not clocked hours.', doc.page.margins.left, doc.y);
  return finish(doc);
}
