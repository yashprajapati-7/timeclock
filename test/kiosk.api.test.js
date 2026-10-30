import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeTestApp, fixture } from './helpers.js';
import { importBackup } from '../src/backup.js';

const KEYS = ['company','currency','defaultPin','hasEmployees','kioskIdleSec','onBreak','onShift','theme','tierHours'];
const seeded = async () => {
  const t = await makeTestApp();
  await importBackup(t.db, fixture('backup-v2'), { now: t.clock() });
  return t;
};

test('info exposes only the allow-list', async () => {
  const { app } = await seeded();
  const res = await request(app).get('/api/kiosk/info');
  assert.deepEqual(Object.keys(res.body).sort(), KEYS);
  for(const pin of ['1111', '2222', '3333']) assert.ok(!JSON.stringify(res.body).includes(pin));
});

test('identify: wrong, inactive, lockout, success', async () => {
  const { app } = await seeded();
  const wrong = await request(app).post('/api/kiosk/identify').send({ pin: '9999' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.remaining, 4);
  assert.equal((await request(app).post('/api/kiosk/identify').send({ pin: '3333' })).status, 401);   // inactive
  const ok = await request(app).post('/api/kiosk/identify').send({ pin: '2222' });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body.employee).sort(), ['id', 'name']);
  assert.ok(!JSON.stringify(ok.body).includes('rate'));
  for(let i = 0; i < 4; i++) await request(app).post("/api/kiosk/identify").send({ pin: "9999" });   // success above reset the counter
  assert.equal((await request(app).post('/api/kiosk/identify').send({ pin: '9999' })).status, 429);
  assert.equal((await request(app).post('/api/kiosk/identify').send({ pin: '2222' })).status, 429);
});

test('punch flow updates counts', async () => {
  const { app, clock } = await seeded();
  const info = async () => (await request(app).get('/api/kiosk/info')).body;
  const base = await info();                                  // fixture has Alice open (on break)
  const p = (type) => request(app).post('/api/kiosk/punch').send({ pin: '2222', type });
  assert.equal((await p('in')).status, 200);
  assert.equal((await info()).onShift, base.onShift + 1);
  clock.advance(60000);
  await p('bs');
  assert.equal((await info()).onBreak, base.onBreak + 1);
  clock.advance(60000);
  await p('be');
  assert.equal((await info()).onBreak, base.onBreak);
  const out = await p('out');
  assert.equal(out.body.name, 'Bob Jones');
  assert.equal((await p('out')).status, 409);
});

test('text/plain punch → 415 and no shift', async () => {
  const { app, db } = await seeded();
  const before = db.get('SELECT COUNT(*) n FROM shifts').n;
  const res = await request(app).post('/api/kiosk/punch').set('Content-Type', 'text/plain').send('{"pin":"2222","type":"in"}');
  assert.equal(res.status, 415);
  assert.equal(db.get('SELECT COUNT(*) n FROM shifts').n, before);
});

test('isolation: admin endpoints need a session', async () => {
  const { app } = await seeded();
  for(const p of ['/api/admin/state', '/api/admin/audit', '/api/admin/backup', '/api/admin/export/payroll.xlsx'])
    assert.equal((await request(app).get(p)).status, 401, p);
});
