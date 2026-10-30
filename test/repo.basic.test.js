import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memDb } from './helpers.js';
import * as R from '../src/repo.js';

test('settings defaults and patch', () => {
  const db = memDb();
  assert.deepEqual(R.getSettings(db), R.DEFAULT_SETTINGS);
  R.setSettings(db, { tierHours: 30, theme: 'dark' });
  const s = R.getSettings(db);
  assert.equal(s.tierHours, 30);
  assert.equal(s.theme, 'dark');
  assert.equal(s.breakMode, 'greater');
  assert.ok(!R.PUBLIC_SETTINGS.includes('adminPinHash'));
});

test('employee round trip, duplicate pin, find by pin', () => {
  const db = memDb();
  R.createEmployee(db, { id: 'e1', name: 'Ann', pin: '1111', rate1: 20, rate2: null, active: true }, 0);
  assert.deepEqual(R.getEmployee(db, 'e1'), { id: 'e1', name: 'Ann', pin: '1111', rate1: 20, rate2: null, active: true,
    role: '', payType: 'hourly', weeklySalary: null, email: '', phone: '', birthday: null, startDate: null, fixedItems: [] });
  assert.throws(() => R.createEmployee(db, { id: 'e2', name: 'B', pin: '1111', active: true }, 0));
  R.updateEmployee(db, 'e1', { name: 'Ann B', pin: '1111', rate1: 21, rate2: 30, active: false });
  assert.equal(R.findEmployeeByPin(db, '1111'), undefined);
  assert.equal(R.listEmployees(db)[0].name, 'Ann B');
  assert.equal(R.employeeHasShifts(db, 'e1'), false);
  R.deleteEmployee(db, 'e1');
  assert.equal(R.listEmployees(db).length, 0);
});

test('audit search and limit', () => {
  const db = memDb();
  R.addAudit(db, { ts: 1, actor: 'Ann', action: 'Clock in', detail: '' });
  R.addAudit(db, { ts: 2, actor: 'Admin', action: 'Add employee', detail: 'Bob' });
  R.addAudit(db, { ts: 3, actor: 'Ann', action: 'Clock out', detail: '' });
  assert.deepEqual(R.listAudit(db, { q: 'CLOCK' }).map(a => a.ts), [3, 1]);
  assert.equal(R.listAudit(db, { limit: 1 })[0].ts, 3);
});

test('employee round-trips the new fields; old-style create gets defaults', () => {
  const db = memDb();
  const full = { id: 'e9', name: 'Sal', pin: '9999', rate1: null, rate2: null, active: true, role: 'Barista', payType: 'salary',
    weeklySalary: 800, email: 'a@b.co', phone: '0400 000 000', birthday: '1999-11-02', startDate: '2024-11-04',
    fixedItems: [{ type: 'allowance', label: 'Phone', amount: 10, from: '2026-10-26' }] };
  R.createEmployee(db, full, 0);
  assert.deepEqual(R.getEmployee(db, 'e9'), full);
  R.updateEmployee(db, 'e9', { ...full, payType: 'hourly', weeklySalary: null, fixedItems: [] });
  assert.equal(R.getEmployee(db, 'e9').payType, 'hourly');
  assert.deepEqual(R.getEmployee(db, 'e9').fixedItems, []);
  R.createEmployee(db, { id: 'e1', name: 'Old', pin: '1111', active: true }, 0);
  const old = R.getEmployee(db, 'e1');
  assert.equal(old.payType, 'hourly');
  assert.deepEqual(old.fixedItems, []);
  assert.equal(old.email, '');
  assert.equal(old.birthday, null);
});
