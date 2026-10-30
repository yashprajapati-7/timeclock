// Public kiosk API. Responses only ever describe the employee who typed their own code.
import { Router } from 'express';
import { getSettings, findEmployeeByPin, listShifts, addAudit, loadData } from '../repo.js';
import { punch } from '../punch.js';
import { week, shift as calcShift } from '../shared/pay.js';
import { startOfWeek, ymd } from '../shared/format.js';

export function kioskRoutes({ db, clock, lockouts }){
  const r = Router();

  r.get('/info', (req, res) => {
    const st = getSettings(db);
    const open = db.all('SELECT s.id, EXISTS(SELECT 1 FROM breaks b WHERE b.shift_id = s.id AND b.end_at IS NULL) onBreak FROM shifts s WHERE s.clock_out IS NULL');
    const onBreak = open.filter(s => s.onBreak).length;
    res.json({
      company: st.company, theme: st.theme, currency: st.currency, tierHours: st.tierHours, kioskIdleSec: st.kioskIdleSec,
      hasEmployees: !!db.get('SELECT 1 x FROM employees LIMIT 1'), defaultPin: st.defaultPin,
      onShift: open.length - onBreak, onBreak,
    });
  });

  // Resolves the code to an active employee, applying the per-IP keypad lockout.
  function identify(req, res){
    const ip = req.ip, lock = lockouts.kiosk.check(ip);
    if(lock.locked){ res.status(429).json({ error: 'Too many attempts', retryAfter: lock.retryAfterSec }); return null; }
    const emp = findEmployeeByPin(db, String(req.body?.pin ?? ''));
    if(!emp){
      const f = lockouts.kiosk.fail(ip);
      if(f.locked){
        addAudit(db, { ts: clock(), actor: 'Kiosk', action: 'Keypad locked', detail: '5 wrong codes' });
        res.status(429).json({ error: 'Too many attempts', retryAfter: f.retryAfterSec });
      } else res.status(401).json({ error: 'Code not recognised', remaining: f.remaining });
      return null;
    }
    lockouts.kiosk.reset(ip);
    return emp;
  }

  r.post('/identify', (req, res) => {
    const emp = identify(req, res);
    if(!emp) return;
    const now = clock(), data = loadData(db), today = ymd(now);
    const open = data.shifts.find(s => s.empId === emp.id && s.out == null);
    const todayPaid = listShifts(db, { empId: emp.id }).filter(s => ymd(s.in) === today).reduce((a, s) => a + calcShift(s, data.settings, now).paid, 0);
    const weekPaid = week(data, startOfWeek(now), now).find(row => row.e.id === emp.id)?.paid ?? 0;
    res.json({ employee: { id: emp.id, name: emp.name }, shift: open ? { in: open.in, breaks: open.breaks } : null, todayPaid, weekPaid });
  });

  r.post('/punch', (req, res) => {
    const emp = identify(req, res);
    if(!emp) return;
    const p = punch(db, emp, String(req.body?.type ?? ''), clock());
    res.json({ type: p.type, name: emp.name, at: p.at, calc: p.calc });
  });

  return r;
}
