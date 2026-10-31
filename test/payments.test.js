// Payments tab: a record of cash / bank payments given to staff, per pay week. Fixed-rate staff are paid in cash only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, loginAgent, memDb } from './helpers.js';
import { validatePayment } from '../src/validate.js';
import { exportBackup, importBackup, normalizeBackup } from '../src/backup.js';
import * as R from '../src/repo.js';
import { ROOT } from '../src/config.js';

const WEEK = '2026-10-26';
const pay = (empId, extra = {}) => ({ empId, week: WEEK, paidOn: '2026-10-30', method: 'cash', amount: 250, note: '', ...extra });

async function setup(){
  const t = await makeTestApp();
  const a = await loginAgent(t.app);
  const ann = (await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111', rate1: 25, rate2: 30 })).body.id;
  const fay = (await a.post('/api/admin/employees').send({ name: 'Fay', pin: '2222', rate1: 22, rate2: 22, payType: 'fixed' })).body.id;
  return { ...t, a, ann, fay };
}

test('validatePayment: Monday week, real date, cash or bank, positive amount; fixed rate is cash only', () => {
  const hourly = { id: 'h', payType: 'hourly' }, fixed = { id: 'f', payType: 'fixed' };
  assert.deepEqual(validatePayment(pay('h', { method: 'bank', amount: '120.5', note: '  rent  ' }), hourly),
    { empId: 'h', week: WEEK, paidOn: '2026-10-30', method: 'bank', amount: 120.5, note: 'rent' });
  assert.throws(() => validatePayment(pay('h', { week: '2026-10-27' }), hourly), /Monday/);
  assert.throws(() => validatePayment(pay('h', { paidOn: '2026-02-31' }), hourly), /date/);
  assert.throws(() => validatePayment(pay('h', { method: 'cheque' }), hourly), /cash or bank/);
  assert.throws(() => validatePayment(pay('h', { amount: 0 }), hourly), /amount/i);
  assert.throws(() => validatePayment(pay('f', { method: 'bank' }), fixed), /cash/);
  assert.equal(validatePayment(pay('f'), fixed).method, 'cash');
});

test('record cash and bank payments, list them in /state, remove and undo', async () => {
  const { a, ann, fay } = await setup();
  assert.equal((await a.post('/api/admin/payments').send(pay(ann, { amount: 300 }))).status, 200);
  const bank = await a.post('/api/admin/payments').send(pay(ann, { method: 'bank', amount: 200, paidOn: '2026-11-02', note: 'transfer' }));
  assert.equal(bank.status, 200);
  assert.equal((await a.post('/api/admin/payments').send(pay(fay, { method: 'bank' }))).status, 422);
  assert.equal((await a.post('/api/admin/payments').send(pay('nobody'))).status, 404);

  let st = (await a.get('/api/admin/state')).body;
  assert.equal(st.payments.length, 2);
  assert.deepEqual(st.payments.map(p => [p.method, p.amount, p.paidOn]), [['cash', 300, '2026-10-30'], ['bank', 200, '2026-11-02']]);
  assert.equal(st.payments[1].note, 'transfer');
  assert.equal(st.payments[1].week, WEEK);

  assert.equal((await a.delete(`/api/admin/payments/${bank.body.id}`).type('json')).status, 200);
  assert.equal((await a.get('/api/admin/state')).body.payments.length, 1);
  assert.equal((await a.post('/api/admin/undo').type('json')).body.undone, 'Remove payment');
  st = (await a.get('/api/admin/state')).body;
  assert.equal(st.payments.length, 2);
  assert.ok((await a.get('/api/admin/audit?q=payment')).body.some(x => /Ann: bank \$200\.00/.test(x.detail) || /Ann: bank/.test(x.detail)));
  assert.equal((await a.delete('/api/admin/payments/9999').type('json')).status, 404);
});

test('an employee with payment history cannot be deleted', async () => {
  const { a, ann } = await setup();
  await a.post('/api/admin/payments').send(pay(ann));
  assert.equal((await a.delete(`/api/admin/employees/${ann}`).type('json')).status, 409);
});

test('payments survive backup → restore, and erase clears them', async () => {
  const { a, ann, db } = await setup();
  await a.post('/api/admin/payments').send(pay(ann, { method: 'bank', note: 'x' }));
  const json = exportBackup(db);
  assert.equal(json.payments.length, 1);
  const db2 = memDb();
  await importBackup(db2, JSON.parse(JSON.stringify(json)));
  assert.deepEqual(R.listPayments(db2).map(p => [p.empId, p.method, p.amount, p.note]), [[ann, 'bank', 250, 'x']]);
  assert.throws(() => normalizeBackup({ ...json, payments: [{ ...json.payments[0], empId: 'ghost' }] }), /payment/);
  assert.deepEqual(normalizeBackup({ ...json, payments: undefined }).payments, []);
  assert.equal((await a.post('/api/admin/erase').send({ confirm: 'ERASE' })).status, 200);
  assert.equal(R.listPayments(db).length, 0);
});

test('UI: Payments tab with its own colour, record dialog, fixed rate cash only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(src, /\['payments',\s*'Payments'\]/);
  for(const s of ['/api/admin/payments', 'payRecord', 'payDel', "'cash'", "'bank'"]) assert.ok(src.includes(s), s);
  assert.match(css, /#app\.admin\[data-tab="payments"\]\{--accent:var\(--c-payments\)\}/);
});
