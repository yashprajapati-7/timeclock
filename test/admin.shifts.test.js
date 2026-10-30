import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d, makeTestApp, loginAgent } from './helpers.js';
import { calcAll } from '../src/shared/pay.js';

const t = (h, m = 0) => d(2026, 10, 27, h, m);

test('shifts, force clock-out, adjustments', async () => {
  const { app, clock } = await makeTestApp();
  const a = await loginAgent(app);
  const emp = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111', rate1: 20 })).body.id;
  const s1 = await a.post('/api/admin/shifts').send({ empId: emp, in: t(9), out: t(17), breaks: [{ start: t(12), end: t(12, 30) }] });
  assert.equal(s1.status, 200);
  const overlap = await a.post('/api/admin/shifts').send({ empId: emp, in: t(16), out: t(18), breaks: [] });
  assert.equal(overlap.status, 422);
  assert.match(overlap.body.error, /Overlaps/);
  assert.equal((await a.post('/api/admin/shifts').send({ empId: emp, in: t(18), out: t(19), breaks: [{ start: t(20), end: t(21) }] })).status, 422);
  assert.equal((await a.put(`/api/admin/shifts/${s1.body.id}`).send({ empId: emp, in: t(9), out: t(17), breaks: [] })).status, 200);
  let state = (await a.get('/api/admin/state')).body;
  assert.equal(state.shifts[0].breaks.length, 0);

  const open = (await a.post('/api/admin/shifts').send({ empId: emp, in: clock() - 3600000, out: null, breaks: [{ start: clock() - 600000, end: null }] })).body.id;
  assert.equal((await a.post(`/api/admin/shifts/${open}/clock-out`).type('json')).status, 200);
  state = (await a.get('/api/admin/state')).body;
  const closed = state.shifts.find(s => s.id === open);
  assert.equal(closed.out, clock());
  assert.equal(closed.breaks[0].end, clock());
  assert.equal((await a.post(`/api/admin/shifts/${open}/clock-out`).type('json')).status, 409);

  const adj = await a.post('/api/admin/adjustments').send({ week: '2026-10-26', empId: emp, type: 'allowance', label: 'Travel', amount: 10 });
  state = (await a.get('/api/admin/state')).body;
  assert.equal(state.adj[`2026-10-26|${emp}`][0].id, adj.body.id);
  assert.equal((await a.delete(`/api/admin/adjustments/${adj.body.id}`).type('json')).status, 200);
  assert.equal((await a.get('/api/admin/state')).body.adj[`2026-10-26|${emp}`], undefined);
  assert.equal((await a.delete(`/api/admin/shifts/${open}`).type('json')).status, 200);
  assert.equal((await a.get('/api/admin/state')).body.shifts.length, 1);
});

test('overtime past the roster is paid to the actual finish (rounded down)', async () => {
  const { app, db } = await makeTestApp();
  const a = await loginAgent(app);
  const emp = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111', rate1: 20 })).body.id;
  await a.put('/api/admin/settings').send({ roundFrom: '2026-10-26' });
  db.run("INSERT INTO roster (emp_id, day, type, start_hm, end_hm, position) VALUES (?, '2026-10-27', 'CAFE', '09:00', '17:00', 0)", emp);
  const id = (await a.post('/api/admin/shifts').send({ empId: emp, in: t(9), out: t(17, 30), breaks: [] })).body.id;
  const paidOut = async () => calcAll((await a.get('/api/admin/state')).body, Date.now()).get(id).paidOut;
  assert.equal(await paidOut(), t(17, 30));
});
