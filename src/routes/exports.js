// /api/admin/export/* — mounted behind requireAdmin.
import { Router } from 'express';
import { loadData, listAudit, addAudit } from '../repo.js';
import { buildWeekReport, buildRosterWeek, parseWeekParam } from '../reports/model.js';
import { payrollWorkbook } from '../reports/xlsx.js';
import { payrollPdf, payslipsPdf, rosterPdf, rosterFileName } from '../reports/pdf.js';
import { csvBuild, ymd } from '../shared/format.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee';

export function exportRoutes({ db, clock }){
  const r = Router();
  const audit = (action, detail) => addAudit(db, { ts: clock(), actor: 'Admin', action, detail });
  const reportFor = req => {
    const now = clock();
    return buildWeekReport(loadData(db), parseWeekParam(req.query.week, now), now);
  };
  const send = (res, type, name, buf) => res.attachment(name).type(type).send(buf);

  r.get('/payroll.xlsx', async (req, res) => {
    const rep = reportFor(req);
    const buf = await payrollWorkbook(rep);
    audit('Export payroll xlsx', rep.weekStart);
    send(res, XLSX, `payroll_${rep.weekStart}.xlsx`, buf);
  });

  r.get('/payroll.pdf', async (req, res) => {
    const rep = reportFor(req);
    const buf = await payrollPdf(rep);
    audit('Export payroll pdf', rep.weekStart);
    send(res, 'application/pdf', `payroll_${rep.weekStart}.pdf`, buf);
  });

  r.get('/payslips.pdf', async (req, res) => {
    const rep = reportFor(req), emp = String(req.query.emp ?? 'all');
    const buf = await payslipsPdf(rep, emp === 'all' ? 'all' : [emp]);
    const name = emp === 'all' ? `payslips_${rep.weekStart}.pdf` : `payslip_${slug(rep.rows.find(x => x.empId === emp).name)}_${rep.weekStart}.pdf`;
    audit('Export payslips pdf', `${rep.weekStart} · ${emp}`);
    send(res, 'application/pdf', name, buf);
  });

  r.get('/roster.pdf', async (req, res) => {
    const now = clock(), model = buildRosterWeek(loadData(db), parseWeekParam(req.query.week, now), now);
    const buf = await rosterPdf(model);
    audit('Export roster pdf', model.weekStart);
    send(res, 'application/pdf', rosterFileName(model.weekStart, model.weekEnd), buf);
  });

  r.get('/audit.csv', (req, res) => {
    const rows = listAudit(db).map(a => [new Date(a.ts).toISOString(), a.actor, a.action, a.detail]);
    const csv = csvBuild([['Timestamp', 'Who', 'Action', 'Detail'], ...rows]);
    audit('Export audit csv', `${rows.length} rows`);
    send(res, 'text/csv; charset=utf-8', `audit_${ymd(clock())}.csv`, csv);
  });

  return r;
}
