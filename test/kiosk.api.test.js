import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeTestApp, fixture } from './helpers.js';
import { importBackup } from '../src/backup.js';

const KEYS = ['company','currency','hasEmployees','kioskIdleSec','onBreak','onShift','theme','tierHours'];
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

test('kiosk shows only today\'s roster for that employee and prices punches with rounding', async () => {
  const { makeTestApp: mk, loginAgent: login, d: dd, fakeClock } = await import('./helpers.js');
  const clock = fakeClock(dd(2026, 10, 30, 9, 8));
  const { app, db } = await mk({ clock });
  const a = await login(app);
  const bob = (await a.post('/api/admin/employees').send({ name: 'Bob', pin: '2222', rate1: 20 })).body.id;
  const ann = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '3333', rate1: 20 })).body.id;
  await a.put('/api/admin/settings').send({ roundFrom: '2026-10-26' });
  await a.put(`/api/admin/roster/${bob}/2026-10-30`).send({ entries: [{ type: 'CAFE', start: '09:00', end: '17:00' }] });
  await a.put(`/api/admin/roster/${ann}/2026-10-30`).send({ entries: [{ type: 'BAKERY', start: '05:00', end: '13:00' }] });
  const who = (await request(app).post('/api/kiosk/identify').send({ pin: '2222' })).body;
  assert.deepEqual(who.roster, [{ type: 'CAFE', start: '09:00', end: '17:00' }]);
  assert.ok(!JSON.stringify(who).includes('BAKERY'));
  const inRes = (await request(app).post('/api/kiosk/punch').send({ pin: '2222', type: 'in' })).body;
  assert.equal(inRes.calc.paidIn, dd(2026, 10, 30, 9, 15));
  assert.equal(inRes.calc.lateMin, 8);
  clock.t = dd(2026, 10, 30, 17, 20);
  const out = (await request(app).post('/api/kiosk/punch').send({ pin: '2222', type: 'out' })).body;
  assert.equal(out.calc.paid, 7);
  assert.equal(out.calc.paidOut, dd(2026, 10, 30, 17, 15));
  const after = (await request(app).post('/api/kiosk/identify').send({ pin: '2222' })).body;
  assert.equal(after.todayPaid, 7);
  assert.equal(after.weekPaid, 7);
  void db;
});
