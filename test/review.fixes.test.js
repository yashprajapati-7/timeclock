// Regression tests for the claude-reviewer findings (round 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeTestApp, loginAgent, fixture } from './helpers.js';
import { normalizeBackup, importBackup } from '../src/backup.js';
import { getSettings } from '../src/repo.js';

test('concurrent logins cannot bypass the admin lockout', async () => {
  const { app } = await makeTestApp();
  const tries = Array.from({ length: 40 }, (_, i) => request(app).post('/api/auth/login').send({ pin: i === 35 ? '0000' : String(1000 + i) }));
  const res = await Promise.all(tries);
  assert.notEqual(res[35].status, 200);
  assert.ok(res.filter(r => r.status === 401).length <= 4);
});

test('a correct PIN within the first 5 tries still logs in and resets the counter', async () => {
  const { app } = await makeTestApp();
  for(let i = 0; i < 3; i++) await request(app).post('/api/auth/login').send({ pin: '9' });
  assert.equal((await request(app).post('/api/auth/login').send({ pin: '0000' })).status, 200);
  assert.equal((await request(app).post('/api/auth/login').send({ pin: '9' })).body.remaining, 4);
});

test('undo "Add employee" after a kiosk punch → 409, not 500', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111' });
  await request(app).post('/api/kiosk/punch').send({ pin: '1111', type: 'in' });
  const r = await a.post('/api/admin/undo').type('json');
  assert.equal(r.status, 409);
  assert.equal((await a.get('/api/admin/state')).body.shifts.length, 1);
});

test('undo "Delete employee" after their code was reused → 409', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app), b = await loginAgent(app);
  const id = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111' })).body.id;
  await a.delete(`/api/admin/employees/${id}`).type('json');
  await b.post('/api/admin/employees').send({ name: 'Bea', pin: '1111' });
  assert.equal((await a.post('/api/admin/undo').type('json')).status, 409);
});

test('undo "Add employee" does not cascade-delete another admin\'s adjustment', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app), b = await loginAgent(app);
  const id = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111' })).body.id;
  await b.post('/api/admin/adjustments').send({ week: '2026-10-26', empId: id, type: 'allowance', amount: 5 });
  assert.equal((await a.post('/api/admin/undo').type('json')).status, 409);
  assert.equal(Object.keys((await a.get('/api/admin/state')).body.adj).length, 1);
});

test('backup validation rejects duplicates and bad adjustments with readable 422s', () => {
  const dupPin = fixture('backup-v2'); dupPin.employees[1].pin = dupPin.employees[0].pin;
  assert.throws(() => normalizeBackup(dupPin), e => e.status === 422 && /pin/i.test(e.message));
  const dupEmp = fixture('backup-v2'); dupEmp.employees[1].id = dupEmp.employees[0].id;
  assert.throws(() => normalizeBackup(dupEmp), e => e.status === 422 && /duplicate/i.test(e.message));
  const dupShift = fixture('backup-v2'); dupShift.shifts[1].id = dupShift.shifts[0].id;
  assert.throws(() => normalizeBackup(dupShift), e => e.status === 422 && /duplicate/i.test(e.message));
  const badType = fixture('backup-v2'); badType.adj['2026-10-26|e1'][0].type = 'gift';
  assert.throws(() => normalizeBackup(badType), e => e.status === 422 && /adjustment/i.test(e.message));
  const ghost = fixture('backup-v2'); ghost.adj['2026-10-26|ghost'] = [{ type: 'allowance', label: 'x', amount: 1 }];
  assert.throws(() => normalizeBackup(ghost), e => e.status === 422 && /adjustment/i.test(e.message));
});

test('invalid imported settings fall back to defaults instead of breaking the app', async () => {
  const { db } = await makeTestApp();
  const f = fixture('backup-v2');
  Object.assign(f.settings, { breakRules: 5, theme: 'pink', adminTimeoutMin: 'abc', company: 42 });
  await importBackup(db, f);
  const s = getSettings(db);
  assert.ok(Array.isArray(s.breakRules));
  assert.equal(s.theme, 'auto');
  assert.equal(s.adminTimeoutMin >= 1, true);
  assert.equal(s.company, '42');
});

test('import with duplicate pins answers 422 over HTTP, data unchanged', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  const f = fixture('backup-v2'); f.employees[1].pin = f.employees[0].pin;
  const r = await a.post('/api/admin/import').send(f);
  assert.equal(r.status, 422);
  assert.equal((await a.get('/api/admin/state')).body.employees.length, 0);
});

test('nits: empty settings patch is a no-op; audit limit clamped; impossible dates rejected', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  await a.put('/api/admin/settings').send({});
  assert.equal((await a.get('/api/admin/state')).body.undoLabel, null);
  assert.equal((await a.get('/api/admin/audit?limit=-1')).body.length, 1);
  assert.equal((await a.get('/api/admin/export/payroll.pdf?week=2026-02-31')).status, 400);
});
