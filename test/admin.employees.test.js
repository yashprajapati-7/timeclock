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
  assert.deepEqual(state.employees.map(({ id, name, pin, rate1, rate2, active }) => ({ id, name, pin, rate1, rate2, active })), [{ id, name: 'Ann', pin: '1111', rate1: 20, rate2: null, active: true }]);
  assert.equal(state.employees[0].payType, 'hourly');
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

test('employees: salary, contact, dates and fixed items via the API; bad email → 422', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  const body = { name: 'Sal', pin: '2222', payType: 'salary', weeklySalary: 900, email: 'Sal@Shop.com', phone: '0400 123 456',
    birthday: '1995-03-04', startDate: '2023-01-09', role: 'Manager',
    fixedItems: [{ type: 'deduction', label: 'Uniform', amount: 5, from: '2026-10-26' }] };
  const id = (await a.post('/api/admin/employees').send(body)).body.id;
  const e = (await a.get('/api/admin/state')).body.employees.find(x => x.id === id);
  assert.deepEqual([e.payType, e.weeklySalary, e.email, e.role, e.fixedItems[0].label], ['salary', 900, 'sal@shop.com', 'Manager', 'Uniform']);
  const bad = await a.put(`/api/admin/employees/${id}`).send({ ...body, email: 'nope@' });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /Email/);
});

test('state carries roster, timezone and mail status; deleting an employee removes their roster (undoable)', async () => {
  const { app, db } = await makeTestApp();
  const a = await loginAgent(app);
  const s = (await a.get('/api/admin/state')).body;
  assert.deepEqual(Object.keys(s).sort(), ['adj', 'employees', 'mailConfigured', 'roster', 'settings', 'shifts', 'undoLabel']);
  assert.equal(s.mailConfigured, false);
  const id = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111' })).body.id;
  db.run("INSERT INTO roster (emp_id, day, type, position) VALUES (?, '2026-10-26', 'OFF', 0)", id);
  assert.equal((await a.delete(`/api/admin/employees/${id}`).type('json')).status, 200);
  assert.equal(db.get('SELECT COUNT(*) n FROM roster').n, 0);
  await a.post('/api/admin/undo').type('json');
  assert.equal(db.get('SELECT COUNT(*) n FROM roster').n, 1);
});

test('fixed pay type is stored and returned (and undo restores it)', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  const id = (await a.post('/api/admin/employees').send({ name: 'Fi', pin: '5555', payType: 'fixed', rate1: 25 })).body.id;
  const emp = async () => (await a.get('/api/admin/state')).body.employees.find(e => e.id === id);
  assert.equal((await emp()).payType, 'fixed');
  let body = { ...(await emp()), payType: 'hourly', rate2: 30 };
  await a.put(`/api/admin/employees/${id}`).send(body);
  assert.equal((await emp()).payType, 'hourly');
  body = { ...(await emp()), payType: 'fixed' };
  await a.put(`/api/admin/employees/${id}`).send(body);
  assert.equal((await emp()).payType, 'fixed');
  await a.post('/api/admin/undo').type('json');
  assert.equal((await emp()).payType, 'hourly');
});
