// API sequences exactly as public/app.js performs them, asserting the fields the UI reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { makeTestApp, loginAgent, fixture } from './helpers.js';

const binary = (res, cb) => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); };

test('kiosk sequence identify → in → bs → be → out', async () => {
  const { app, clock } = await makeTestApp();
  const a = await loginAgent(app);
  await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111', rate1: 20 });
  const k = request(app);
  let who = (await k.post('/api/kiosk/identify').send({ pin: '1111' })).body;
  assert.equal(who.employee.name, 'Ann');
  assert.equal(who.shift, null);
  for(const type of ['in', 'bs', 'be', 'out']){
    const r = (await k.post('/api/kiosk/punch').send({ pin: '1111', type })).body;
    assert.equal(r.type, type);
    assert.equal(typeof r.at, 'number');
    assert.equal(typeof r.calc.paid, 'number');
    if(type === 'in'){
      who = (await k.post('/api/kiosk/identify').send({ pin: '1111' })).body;
      assert.equal(typeof who.shift.in, 'number');
      assert.deepEqual(who.shift.breaks, []);
      assert.equal(typeof who.todayPaid, 'number');
      assert.equal(typeof who.weekPaid, 'number');
    }
    clock.advance(30 * 60000);
  }
});

test('admin session: login messages, state shape, idle expiry', async () => {
  const { app, clock } = await makeTestApp();
  const wrong = await request(app).post('/api/auth/login').send({ pin: '1' });
  assert.equal(wrong.body.remaining, 4);
  const a = await loginAgent(app);
  const s = (await a.get('/api/admin/state')).body;
  assert.deepEqual(Object.keys(s).sort(), ['adj', 'employees', 'settings', 'shifts', 'undoLabel']);
  clock.advance(6 * 60000);
  assert.equal((await a.get('/api/admin/state')).status, 401);
  await loginAgent(app);
});

test('CRUD as the UI does it', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  const emp = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111', rate1: '20', rate2: '30', active: true })).body.id;
  await a.post('/api/admin/shifts').send({ empId: emp, in: Date.UTC(2026, 9, 27, 9), out: Date.UTC(2026, 9, 27, 17), breaks: [] });
  const adj = (await a.post('/api/admin/adjustments').send({ week: '2026-10-26', empId: emp, type: 'allowance', label: 'Travel', amount: 5 })).body.id;
  await a.put('/api/admin/settings').send({ company: 'Acme', currency: '€', tierHours: '30', theme: 'dark', breakMode: 'actual',
    breakRules: [{ h: 4, m: 15 }], kioskIdleSec: '20', adminTimeoutMin: '5', maxShiftHours: '14' });
  let s = (await a.get('/api/admin/state')).body;
  assert.equal(s.employees[0].pin, '1111');
  assert.equal(s.adj[`2026-10-26|${emp}`][0].id, adj);
  assert.equal(s.settings.theme, 'dark');
  assert.equal(s.settings.tierHours, 30);
  await a.delete(`/api/admin/adjustments/${adj}`).type('json');
  s = (await a.get('/api/admin/state')).body;
  assert.deepEqual(s.adj, {});
  const clash = await a.post('/api/admin/shifts').send({ empId: emp, in: Date.UTC(2026, 9, 27, 16), out: Date.UTC(2026, 9, 27, 18), breaks: [] });
  assert.equal(clash.status, 422);
  assert.equal(typeof clash.body.error, 'string');
  assert.match((await a.post('/api/admin/employees').send({ name: 'B', pin: '1111' })).body.error, /already used/);
});

test('delete shift → undo → audit shows Undo', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  const emp = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111' })).body.id;
  const id = (await a.post('/api/admin/shifts').send({ empId: emp, in: 1000, out: 2000, breaks: [] })).body.id;
  await a.delete(`/api/admin/shifts/${id}`).type('json');
  assert.equal((await a.get('/api/admin/state')).body.undoLabel, 'Delete shift');
  assert.equal((await a.post('/api/admin/undo').type('json')).body.undone, 'Delete shift');
  const audit = (await a.get('/api/admin/audit?limit=300&q=undo')).body;
  assert.equal(audit[0].action, 'Undo');
});

test('restore then export with the exact URLs app.js builds', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  await a.post('/api/admin/import').send(fixture('backup-v2'));
  const x = await a.get('/api/admin/export/payroll.xlsx?week=2026-10-26').buffer(true).parse(binary);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  assert.equal(wb.worksheets[0].name, 'Payroll');
  for(const url of ['/api/admin/export/payroll.pdf?week=2026-10-26', '/api/admin/export/payslips.pdf?week=2026-10-26&emp=all',
    '/api/admin/export/payslips.pdf?week=2026-10-26&emp=e1', '/api/admin/export/audit.csv', '/api/admin/backup'])
    assert.equal((await a.get(url)).status, 200, url);
});
