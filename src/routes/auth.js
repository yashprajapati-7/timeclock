import { Router } from 'express';
import { HttpError, ValidationError } from '../errors.js';
import { getSettings, setSettings, addAudit } from '../repo.js';
import { hashPin, verifyPin, needsRehash } from '../auth/hash.js';
import { COOKIE, createSession, touchSession, destroySession, purgeExpiredSessions, parseCookies } from '../auth/sessions.js';

// First start (or after erase): admin PIN 0000, flagged so the dashboard nags until it is changed.
export async function ensureAdminPin(db, now = Date.now()){
  if(getSettings(db).adminPinHash) return;
  setSettings(db, { adminPinHash: await hashPin('0000'), defaultPin: true });
  addAudit(db, { ts: now, actor: 'System', action: 'Admin PIN secured' });
}

// Secure whenever the request came in over HTTPS (directly or via a trusted proxy).
const cookieOptions = req => ({ httpOnly: true, sameSite: 'strict', path: '/', secure: req.secure });

export function requireAdmin({ db, clock }){
  return (req, res, next) => {
    const token = parseCookies(req.get('cookie'))[COOKIE];
    const key = touchSession(db, token, clock(), getSettings(db).adminTimeoutMin);
    if(!key) return next(new HttpError(401, 'Admin session expired'));
    req.session = { key, token };
    next();
  };
}

export function authRoutes(ctx){
  const { db, clock, lockouts, undo } = ctx;
  const r = Router();
  const audit = (actor, action, detail) => addAudit(db, { ts: clock(), actor, action, detail });

  r.post('/login', async (req, res) => {
    const ip = req.ip, lock = lockouts.admin.check(ip);
    if(lock.locked) return res.status(429).json({ error: 'Too many attempts', retryAfter: lock.retryAfterSec });
    const st = getSettings(db);
    purgeExpiredSessions(db, clock(), st.adminTimeoutMin);
    const pin = String(req.body?.pin ?? '');
    // Count the attempt BEFORE the async hash check, so concurrent requests cannot all slip past check();
    // a correct PIN refunds it below.
    const f = lockouts.admin.fail(ip);
    if(!await verifyPin(pin, st.adminPinHash)){
      if(f.locked){
        audit('System', 'Admin locked out', '5 wrong admin PINs');
        return res.status(429).json({ error: 'Too many attempts', retryAfter: f.retryAfterSec });
      }
      return res.status(401).json({ error: 'Wrong PIN', remaining: f.remaining });
    }
    lockouts.admin.reset(ip);
    if(needsRehash(st.adminPinHash)) setSettings(db, { adminPinHash: await hashPin(pin) });
    res.cookie(COOKIE, createSession(db, clock()), cookieOptions(req));
    audit('Admin', 'Admin login');
    res.json({ defaultPin: st.defaultPin, adminTimeoutMin: st.adminTimeoutMin });
  });

  const admin = requireAdmin(ctx);

  r.post('/logout', admin, (req, res) => {
    destroySession(db, req.session.token);
    undo.clear(req.session.key);
    audit('Admin', 'Admin logout');
    res.clearCookie(COOKIE, cookieOptions(req));
    res.json({ ok: true });
  });

  r.get('/me', admin, (req, res) => {
    const st = getSettings(db);
    res.json({ defaultPin: st.defaultPin, adminTimeoutMin: st.adminTimeoutMin });
  });

  r.post('/pin', admin, async (req, res) => {
    const current = String(req.body?.current ?? ''), next = String(req.body?.next ?? '');
    if(!await verifyPin(current, getSettings(db).adminPinHash)) throw new ValidationError('Current PIN is wrong');
    if(next.length < 4) throw new ValidationError('New PIN must be at least 4 characters');
    setSettings(db, { adminPinHash: await hashPin(next), defaultPin: false });
    audit('Admin', 'Admin PIN changed');
    res.json({ ok: true });
  });

  return r;
}
