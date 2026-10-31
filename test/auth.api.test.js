import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { makeTestApp, loginAgent } from './helpers.js';
import { setSettings, getSettings } from '../src/repo.js';

test('login with default PIN sets a strict HttpOnly cookie', async () => {
  const { app } = await makeTestApp();
  const res = await request(app).post('/api/auth/login').send({ pin: '0000' });
  assert.equal(res.status, 200);
  const cookie = res.headers['set-cookie'].join(';');
  assert.match(cookie, /tc_admin=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const agent = await loginAgent(app);
  assert.deepEqual((await agent.get('/api/auth/me')).body, { defaultPin: true, adminTimeoutMin: 5 });
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('wrong PIN, lockout and unlock', async () => {
  const { app, clock } = await makeTestApp();
  const wrong = await request(app).post('/api/auth/login').send({ pin: '9' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.remaining, 4);
  for(let i = 0; i < 3; i++) await request(app).post('/api/auth/login').send({ pin: '9' });
  const locked = await request(app).post('/api/auth/login').send({ pin: '9' });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.retryAfter, 60);
  assert.equal((await request(app).post('/api/auth/login').send({ pin: '0000' })).status, 429);
  clock.advance(60001);
  assert.equal((await request(app).post('/api/auth/login').send({ pin: '0000' })).status, 200);
});

test('idle expiry and logout', async () => {
  const { app, clock } = await makeTestApp();
  const agent = await loginAgent(app);
  clock.advance(4 * 60000);
  assert.equal((await agent.get('/api/auth/me')).status, 200);
  clock.advance(5 * 60000 + 1000);
  assert.equal((await agent.get('/api/auth/me')).status, 401);
  const b = await loginAgent(app);
  assert.equal((await b.post('/api/auth/logout').type('json')).status, 200);
  assert.equal((await b.get('/api/auth/me')).status, 401);
});

test('PIN change', async () => {
  const { app } = await makeTestApp();
  const agent = await loginAgent(app);
  assert.equal((await agent.post('/api/auth/pin').send({ current: '1', next: '5678' })).status, 422);
  assert.equal((await agent.post('/api/auth/pin').send({ current: '0000', next: '12' })).status, 422);
  assert.equal((await agent.post('/api/auth/pin').send({ current: '0000', next: '5678' })).status, 200);
  assert.equal((await agent.get('/api/auth/me')).body.defaultPin, false);
  assert.equal((await request(app).post('/api/auth/login').send({ pin: '0000' })).status, 401);
  await loginAgent(app, '5678');
});

test('legacy sha256 hash logs in and is rehashed', async () => {
  const { app, db } = await makeTestApp();
  setSettings(db, { adminPinHash: 'salt|sha256:' + createHash('sha256').update('salt:4321').digest('hex') });
  await loginAgent(app, '4321');
  assert.match(getSettings(db).adminPinHash, /^scrypt\$/);
});

test('non-JSON mutation → 415', async () => {
  const { app } = await makeTestApp();
  const res = await request(app).post('/api/auth/login').set('Content-Type', 'text/plain').send('{"pin":"0000"}');
  assert.equal(res.status, 415);
});

test('expired session rows are purged at login', async () => {
  const { app, db, clock } = await makeTestApp();
  await loginAgent(app);
  clock.advance(10 * 60000);
  await loginAgent(app);
  assert.equal(db.get('SELECT COUNT(*) n FROM sessions').n, 1);
});

test('PIN change revokes other admin sessions and keeps the current one', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app), b = await loginAgent(app);
  assert.equal((await a.post('/api/auth/pin').send({ current: '0000', next: '4321' })).status, 200);
  assert.equal((await b.get('/api/auth/me')).status, 401);
  assert.equal((await a.get('/api/auth/me')).status, 200);
});
