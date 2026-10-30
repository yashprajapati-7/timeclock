import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, loginAgent } from './helpers.js';

test('employee CRUD, settings, no hash leak', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  const created = await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111', rate1: '20', rate2: '' });
  assert.equal(created.status, 200);
  const id = created.body.id;
  let state = (await a.get('/api/admin/state')).body;
  assert.deepEqual(state.employees, [{ id, name: 'Ann', pin: '1111', rate1: 20, rate2: null, active: true }]);
  assert.equal((await a.get('/api/admin/audit?q=add employee')).body[0].detail, 'Ann');
  const dup = await a.post('/api/admin/employees').send({ name: 'B', pin: '1111' });
  assert.equal(dup.status, 422);
  assert.match(dup.body.error, /already used/);
  assert.equal((await a.put(`/api/admin/employees/${id}`).send({ name: 'Ann B', pin: '1112', active: false })).status, 200);
  assert.equal((await a.put('/api/admin/employees/nope').send({ name: 'X', pin: '9999' })).status, 404);
  await a.post('/api/admin/shifts').send({ empId: id, in: 1000, out: 2000, breaks: [] });
  assert.equal((await a.delete(`/api/admin/employees/${id}`).type('json')).status, 409);
  assert.equal((await a.put('/api/admin/settings').send({ breakMode: 'policy' })).status, 200);
  state = (await a.get('/api/admin/state')).body;
  assert.equal(state.settings.breakMode, 'policy');
  assert.equal((await a.put('/api/admin/settings').send({ adminPinHash: 'x' })).status, 422);
  assert.ok(!JSON.stringify(state).includes('adminPinHash'));
  const b = (await a.post('/api/admin/employees').send({ name: 'Del', pin: '5555' })).body.id;
  assert.equal((await a.delete(`/api/admin/employees/${b}`).type('json')).status, 200);
});
