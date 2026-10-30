// /api/admin/payslips/* — mounted behind requireAdmin. Sends payslip PDFs by email, one per employee, and audits each attempt.
import { Router } from 'express';
import { HttpError } from '../errors.js';
import { loadData, listAudit, addAudit } from '../repo.js';
import { buildWeekReport, parseWeekParam } from '../reports/model.js';
import { payslipsPdf } from '../reports/pdf.js';
import { money } from '../shared/format.js';

const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee';

export function mailRoutes({ db, clock, mailer }){
  const r = Router();
  const running = new Set();   // weeks with an email run in progress (guards double clicks and retries)

  r.post('/email', async (req, res) => {
    if(!mailer?.configured) throw new HttpError(503, 'Email is not set up: set BREVO_API_KEY and MAIL_FROM on the server');
    const now = clock(), rep = buildWeekReport(loadData(db), parseWeekParam(req.body?.week, now), now);
    const emp = String(req.body?.emp ?? 'all');
    const targets = emp === 'all' ? rep.rows : rep.rows.filter(x => x.empId === emp);
    if(!targets.length) throw new HttpError(404, 'Employee not found for this week');
    if(running.has(rep.weekStart)) throw new HttpError(409, 'Payslips for this week are already being emailed');
    running.add(rep.weekStart);
    const results = [];
    try{
      for(const row of targets){
        const base = { empId: row.empId, name: row.name };
        if(!row.email){ results.push({ ...base, status: 'skipped', error: 'No email address' }); continue; }
        let line;
        try{
          const pdf = await payslipsPdf(rep, [row.empId]);
          const { messageId } = await mailer.send({
            to: row.email, toName: row.name,
            subject: `${rep.company} payslip ${rep.weekStart} – ${rep.weekEnd}`,
            text: `Hi ${row.name},\n\nYour payslip for the week ${rep.weekStart} – ${rep.weekEnd} is attached.\nNet pay: ${money(row.net, rep.currency)}\n\n${rep.company}`,
            attachments: [{ name: `payslip_${slug(row.name)}_${rep.weekStart}.pdf`, content: pdf }],
          });
          results.push({ ...base, status: 'sent' });
          line = `sent${messageId ? ' ' + messageId : ''}`;
        }catch(e){
          if(e instanceof HttpError && e.status === 503) throw e;
          results.push({ ...base, status: 'failed', error: e.message });
          line = `failed: ${e.message}`;
        }
        addAudit(db, { ts: clock(), actor: 'Admin', action: 'Email payslip', detail: `${row.name} · ${rep.weekStart} · ${line}` });
      }
    }finally{ running.delete(rep.weekStart); }
    res.json({ week: rep.weekStart, results });
  });

  // When payslips for a week were last emailed successfully (shown before "Email all").
  r.get('/email-status', (req, res) => {
    const week = new Date(parseWeekParam(req.query.week, clock()));
    const key = ` · ${week.getFullYear()}-${String(week.getMonth() + 1).padStart(2, '0')}-${String(week.getDate()).padStart(2, '0')} · sent`;
    const last = listAudit(db, { q: key, limit: 1 }).find(a => a.action === 'Email payslip');
    res.json({ lastSent: last?.ts ?? null, configured: !!mailer?.configured, running: running.has(key.slice(3, 13)) });
  });

  return r;
}
