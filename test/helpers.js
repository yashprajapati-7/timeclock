// Shared test helpers. Dates are built in local time so tests pass in any timezone.
export const d = (y, m, day, h = 0, mi = 0) => new Date(y, m - 1, day, h, mi).getTime();
import { openDb, migrate } from '../src/db.js';
export const memDb = () => { const db = openDb(':memory:'); migrate(db); return db; };
import fs from 'node:fs';
export const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ensureAdminPin } from '../src/routes/auth.js';

export function fakeClock(start = d(2026, 10, 30, 12)){
  const c = () => c.t;
  c.t = start;
  c.advance = ms => { c.t += ms; };
  return c;
}
export async function makeTestApp({ clock = fakeClock(), db = memDb(), ...opts } = {}){
  await ensureAdminPin(db, clock());
  return { app: createApp({ db, clock, ...opts }), db, clock };
}
export async function loginAgent(app, pin = '0000'){
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ pin });
  if(res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
// supertest parser that returns the raw response body as a Buffer (for xlsx / pdf downloads).
export const binary = (res, cb) => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); };
