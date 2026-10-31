import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { HttpError, ValidationError } from '../errors.js';
import * as R from '../repo.js';
import { validatePin, validateEmployee, validateShift, validateSettings, validateAdjustment } from '../validate.js';
import { normalizeBackup, importBackup, exportBackup } from '../backup.js';
import { ensureAdminPin } from './auth.js';
import { clamp, fmtDay, hm, money, ymd } from '../shared/format.js';
import { snapshotBefore } from '../snapshot.js';

export function adminRoutes({ db, clock, undo, mailer, backupDir }){
  const r = Router();
  const audit = (action, detail = '') => R.addAudit(db, { ts: clock(), actor: 'Admin', action, detail });
  const mustGet = (getter, id, what) => { const x = getter(db, id); if(!x) throw new HttpError(404, `${what} not found`); return x; };
  const shiftLabel = s => `${R.getEmployee(db, s.empId)?.name ?? '(deleted)'} · ${fmtDay(s.in)} ${hm(s.in)}–${s.out ? hm(s.out) : 'open'}`;
  // Run an undoable mutation for this admin session and log it.
  const change = (req, action, fn) => undo.run(req.session.key, action, touch => {
    const detail = fn(touch);
    audit(action, detail);
    return detail;
  });

  r.get('/state', (req, res) => {
    res.json({ settings: R.publicSettings(db), employees: R.listEmployees(db), shifts: R.listShifts(db),
      adj: R.listAdjustments(db), roster: R.listRoster(db), undoLabel: undo.label(req.session.key),
      mailConfigured: !!mailer?.configured });
  });

  r.get('/audit', (req, res) => {
    res.json(R.listAudit(db, { q: String(req.query.q ?? ''), limit: clamp(Math.trunc(Number(req.query.limit)) || 300, 1, 5000) }));
  });

  // ----- Employees -----
  r.post('/employees', (req, res) => {
    const e = validateEmployee(req.body);
    validatePin(e.pin, R.listEmployees(db));
    const id = randomUUID();
    change(req, 'Add employee', touch => {
      R.createEmployee(db, { id, ...e }, clock());
      touch('employees', id, { created: true });
      return e.name;
    });
    res.json({ id });
  });

  r.put('/employees/:id', (req, res) => {
    mustGet(R.getEmployee, req.params.id, 'Employee');
    const e = validateEmployee(req.body);
    validatePin(e.pin, R.listEmployees(db), req.params.id);
    change(req, 'Edit employee', touch => {
      touch('employees', req.params.id);
      R.updateEmployee(db, req.params.id, e);
      return e.name;
    });
    res.json({ ok: true });
  });

  r.delete('/employees/:id', (req, res) => {
    const e = mustGet(R.getEmployee, req.params.id, 'Employee');
    if(R.employeeHasShifts(db, e.id)) throw new HttpError(409, 'This employee has shift history; set them Inactive instead');
    change(req, 'Delete employee', touch => {
      for(const a of db.all('SELECT id FROM adjustments WHERE emp_id = ?', e.id)) touch('adjustments', a.id);
      for(const r of db.all('SELECT id FROM roster WHERE emp_id = ?', e.id)) touch('roster', r.id);
      touch('employees', e.id);
      R.deleteEmployee(db, e.id);
      return e.name;
    });
    res.json({ ok: true });
  });

  // ----- Settings -----
  r.put('/settings', (req, res) => {
    const patch = validateSettings(req.body);
    const keys = Object.keys(patch);
    if(!keys.length) return res.json({ ok: true });
    if(keys.length === 1 && keys[0] === 'theme'){      // theme toggles are not undoable (as before)
      R.setSettings(db, patch);
      audit('Theme', patch.theme);
    } else change(req, 'Update settings', touch => {
      keys.forEach(k => touch('settings', k));
      R.setSettings(db, patch);
      return keys.join(', ');
    });
    res.json({ ok: true });
  });

  // ----- Shifts -----
  const checkedShift = (body, id) => {
    const input = { empId: body?.empId, in: body?.in, out: body?.out ?? null, breaks: body?.breaks ?? [], otApproved: body?.otApproved };
    if(!R.getEmployee(db, input.empId)) throw new ValidationError('Choose an employee');
    const others = R.listShifts(db, { empId: input.empId }).filter(s => s.id !== id);
    return validateShift(input, others);
  };

  r.post('/shifts', (req, res) => {
    const s = { id: randomUUID(), ...checkedShift(req.body) };
    change(req, 'Add shift', touch => { R.saveShift(db, s); touch('shifts', s.id, { created: true }); return shiftLabel(s); });
    res.json({ id: s.id });
  });

  r.put('/shifts/:id', (req, res) => {
    mustGet(R.getShift, req.params.id, 'Shift');
    const s = { id: req.params.id, ...checkedShift(req.body, req.params.id) };
    change(req, 'Edit shift', touch => { touch('shifts', s.id); R.saveShift(db, s); return shiftLabel(s); });
    res.json({ ok: true });
  });

  r.delete('/shifts/:id', (req, res) => {
    const s = mustGet(R.getShift, req.params.id, 'Shift');
    change(req, 'Delete shift', touch => { touch('shifts', s.id); R.deleteShift(db, s.id); return shiftLabel(s); });
    res.json({ ok: true });
  });

  r.post('/shifts/:id/clock-out', (req, res) => {
    const s = mustGet(R.getShift, req.params.id, 'Shift');
    if(s.out != null) throw new HttpError(409, 'Shift is already closed');
    const now = clock();
    change(req, 'Force clock-out', touch => {
      touch('shifts', s.id);
      for(const b of s.breaks) if(b.end == null) b.end = now;
      R.saveShift(db, { ...s, out: now });
      return `${R.getEmployee(db, s.empId)?.name ?? '(deleted)'} at ${hm(now)}`;
    });
    res.json({ ok: true });
  });

  // ----- Adjustments -----
  r.post('/adjustments', (req, res) => {
    const a = validateAdjustment(req.body);
    const emp = mustGet(R.getEmployee, a.empId, 'Employee');
    const currency = R.getSettings(db).currency;
    let id;
    change(req, 'Add adjustment', touch => {
      id = R.addAdjustment(db, a);
      touch('adjustments', id, { created: true });
      return `${emp.name}: ${a.type} "${a.label}" ${money(a.amount, currency)}`;
    });
    res.json({ id });
  });

  r.delete('/adjustments/:id', (req, res) => {
    const a = mustGet(R.getAdjustment, req.params.id, 'Adjustment');
    const currency = R.getSettings(db).currency;
    change(req, 'Remove adjustment', touch => {
      touch('adjustments', a.id);
      R.deleteAdjustment(db, a.id);
      return `${R.getEmployee(db, a.emp_id)?.name ?? ''}: ${a.type} "${a.label}" ${money(a.amount, currency)}`;
    });
    res.json({ ok: true });
  });

  // ----- Undo -----
  r.post('/undo', (req, res) => res.json({ undone: undo.undo(req.session.key) }));

  // ----- Backup / import / erase (not undoable; they clear every undo stack) -----
  r.get('/backup', (req, res) => {
    audit('Backup downloaded');
    res.attachment(`timeclock_backup_${ymd(clock())}.json`).type('application/json').send(JSON.stringify(exportBackup(db), null, 1));
  });

  r.post('/import', async (req, res) => {
    normalizeBackup(req.body);                     // 422 before touching anything
    snapshotBefore(db, backupDir, 'import', clock());   // a failed safety copy stops the import (500)
    const counts = await importBackup(db, req.body, { now: clock() });
    // importBackup clears sessions; keep the importing admin signed in.
    db.run('INSERT INTO sessions (token_hash, created_at, last_seen) VALUES (?, ?, ?)', [req.session.key, clock(), clock()]);
    undo.clearAll();
    res.json(counts);
  });

  r.post('/erase', async (req, res) => {
    if(req.body?.confirm !== 'ERASE') throw new ValidationError('Type ERASE to confirm');
    snapshotBefore(db, backupDir, 'erase', clock());
    db.tx(() => {
      for(const t of ['breaks', 'adjustments', 'roster', 'shifts', 'employees', 'settings', 'audit']) db.run(`DELETE FROM ${t}`);
    });
    await ensureAdminPin(db, clock());
    audit('Erase all data');
    undo.clearAll();
    res.json({ ok: true });
  });

  return r;
}
