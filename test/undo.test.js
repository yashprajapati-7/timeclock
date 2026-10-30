import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { d, makeTestApp, loginAgent } from './helpers.js';

const t = (h, m = 0) => d(2026, 10, 27, h, m);
const setup = async () => {
  const x = await makeTestApp();
  const a = await loginAgent(x.app);
  const emp = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111', rate1: 20 })).body.id;
  return { ...x, a, emp, state: async () => (await a.get('/api/admin/state')).body, undo: () => a.post('/api/admin/undo').type('json') };
};

test('undo delete shift restores shift and breaks', async () => {
  const { a, emp, state, undo } = await setup();
  const id = (await a.post('/api/admin/shifts').send({ empId: emp, in: t(9), out: t(17), breaks: [{ start: t(12), end: t(13) }] })).body.id;
  const before = (await state()).shifts;
  await a.delete(`/api/admin/shifts/${id}`).type('json');
  assert.equal((await state()).undoLabel, 'Delete shift');
  assert.deepEqual((await undo()).body, { undone: 'Delete shift' });
  assert.deepEqual((await state()).shifts, before);
});

test('undo edit employee, add adjustment, settings, add employee', async () => {
  const { a, emp, state, undo } = await setup();
  await a.put(`/api/admin/employees/${emp}`).send({ name: 'Zed', pin: '9999' });
  await undo();
  const e = (await state()).employees[0];
  assert.deepEqual([e.name, e.pin], ['Ann', '1111']);
  await a.post('/api/admin/adjustments').send({ week: '2026-10-26', empId: emp, type: 'allowance', amount: 5 });
  await undo();
  assert.deepEqual((await state()).adj, {});
  const rules = (await state()).settings.breakRules;
  await a.put('/api/admin/settings').send({ breakRules: [{ h: 1, m: 5 }] });
  await undo();
  assert.deepEqual((await state()).settings.breakRules, rules);
  await undo();
  assert.equal((await state()).employees.length, 0);
  assert.deepEqual((await undo()).body, { undone: null });
});

test('stacks are per session, cleared on logout, capped at 30', async () => {
  const { app, a, emp } = await setup();
  const b = await loginAgent(app);
  await a.put(`/api/admin/employees/${emp}`).send({ name: 'Zed', pin: '1111' });
  assert.deepEqual((await b.post('/api/admin/undo').type('json')).body, { undone: null });
  await a.post('/api/auth/logout').type('json');
  const a2 = await loginAgent(app);
  assert.equal((await a2.get('/api/admin/state')).body.undoLabel, null);
  for(let i = 0; i < 31; i++) await a2.put(`/api/admin/employees/${emp}`).send({ name: 'N' + i, pin: '1111' });
  let n = 0;
  while((await a2.post('/api/admin/undo').type('json')).body.undone) n++;
  assert.equal(n, 30);
});

test('conflict: kiosk punch after admin edit → 409, punch kept', async () => {
  const { app, a, emp, clock, state, undo } = await setup();
  await request(app).post('/api/kiosk/punch').send({ pin: '1111', type: 'in' });
  const sh = (await state()).shifts[0];
  await a.put(`/api/admin/shifts/${sh.id}`).send({ empId: emp, in: sh.in - 600000, out: null, breaks: [] });
  clock.advance(60000);           // stay inside the 5-minute admin idle timeout
  await request(app).post('/api/kiosk/punch').send({ pin: '1111', type: 'out' });
  const res = await undo();
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Data changed since this action; cannot undo' });
  const after = await state();
  assert.equal(after.shifts[0].out, clock());
  assert.equal(after.undoLabel, 'Edit shift');
});

test('undo restores the new employee fields', async () => {
  const { a, emp, state, undo } = await setup();
  const full = { name: 'Ann', pin: '1111', rate1: 20, email: 'ann@x.co', phone: '0400 111 222', birthday: '1990-01-01',
    fixedItems: [{ type: 'allowance', label: 'Phone', amount: 10, from: '2026-10-26' }] };
  await a.put(`/api/admin/employees/${emp}`).send(full);
  await a.put(`/api/admin/employees/${emp}`).send({ ...full, email: 'other@x.co', fixedItems: [] });
  await undo();
  const e = (await state()).employees[0];
  assert.equal(e.email, 'ann@x.co');
  assert.equal(e.fixedItems.length, 1);
});
