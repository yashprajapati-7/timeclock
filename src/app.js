import express from 'express';
import path from 'node:path';
import { ROOT } from './config.js';
import { HttpError } from './errors.js';
import { createLockout } from './auth/lockout.js';
import { authRoutes, requireAdmin } from './routes/auth.js';
import { kioskRoutes } from './routes/kiosk.js';
import { adminRoutes } from './routes/admin.js';
import { exportRoutes } from './routes/exports.js';
import { rosterRoutes } from './routes/roster.js';
import { mailRoutes } from './routes/mail.js';
import { createUndo } from './undo.js';

// Every state-changing API call must be JSON: with SameSite=Strict cookies this is the CSRF defence.
function requireJson(req, res, next){
  // Header check rather than req.is(): req.is() returns null for body-less requests (DELETE, logout, undo).
  const type = String(req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if(['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && type !== 'application/json')
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  next();
}

export function createApp({ db, clock = Date.now, trustProxy = false, mailer = null, fetch: fetchImpl = globalThis.fetch, rosterImportUrl }){
  const ctx = {
    db, clock,
    lockouts: { admin: createLockout({ max: 5, ms: 60000, clock }), kiosk: createLockout({ max: 5, ms: 30000, clock }) },
    undo: createUndo(db, clock),
    mailer, fetch: fetchImpl, rosterImportUrl,
  };
  const app = express();
  app.disable('x-powered-by');
  // Behind a proxy, req.ip / req.secure must come from X-Forwarded-* so lockouts are per client and cookies Secure on HTTPS.
  app.set('trust proxy', trustProxy);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });
  app.use('/api', requireJson, express.json({ limit: '10mb' }));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/kiosk', kioskRoutes(ctx));
  app.use('/api/admin', requireAdmin(ctx));
  app.use('/api/admin/export', exportRoutes(ctx));
  app.use('/api/admin/roster', rosterRoutes(ctx));
  app.use('/api/admin/payslips', mailRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));
  // Static UI + the shared pure modules the browser imports. Paths come from ROOT, never the cwd.
  const noCache = { setHeaders: res => res.set('Cache-Control', 'no-cache') };
  app.use('/shared', express.static(path.join(ROOT, 'src', 'shared'), noCache));
  app.use(express.static(path.join(ROOT, 'public'), noCache));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    // Deliberate HttpErrors (e.g. 502 "old roster app unreachable", 503 "email not set up") keep their message;
    // unexpected crashes are logged and stay generic.
    const expose = status < 500 || err instanceof HttpError;
    if(!expose) console.error(err);
    res.status(status).json({ error: expose ? err.message : 'Server error' });
  });
  return app;
}
