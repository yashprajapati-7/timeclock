// Behind a hosting proxy (Railway): lockouts must be per real client IP, and the cookie Secure on HTTPS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ensureAdminPin } from '../src/routes/auth.js';
import { loadConfig } from '../src/config.js';
import { memDb, fakeClock } from './helpers.js';

const proxied = async () => {
  const db = memDb(), clock = fakeClock();
  await ensureAdminPin(db, clock());
  return createApp({ db, clock, trustProxy: 1 });
};
const login = (app, ip, pin, proto = 'http') =>
  request(app).post('/api/auth/login').set('X-Forwarded-For', ip).set('X-Forwarded-Proto', proto).send({ pin });

test('TRUST_PROXY env is read', () => {
  assert.equal(loadConfig({}).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: '1' }).trustProxy, 1);
});

test('one attacker cannot lock out everyone behind the proxy', async () => {
  const app = await proxied();
  for(let i = 0; i < 5; i++) await login(app, '203.0.113.9', '9');
  assert.equal((await login(app, '203.0.113.9', '0000')).status, 429);
  assert.equal((await login(app, '198.51.100.7', '0000')).status, 200);
});

test('cookie is Secure on HTTPS and not on plain HTTP', async () => {
  const app = await proxied();
  assert.match((await login(app, '198.51.100.7', '0000', 'https')).headers['set-cookie'].join(';'), /;\s*Secure/i);
  assert.doesNotMatch((await login(app, '198.51.100.8', '0000', 'http')).headers['set-cookie'].join(';'), /;\s*Secure/i);
});
