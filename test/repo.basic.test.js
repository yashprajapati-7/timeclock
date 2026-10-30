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
  assert.deepEqual(R.getEmployee(db, 'e1'), { id: 'e1', name: 'Ann', pin: '1111', rate1: 20, rate2: null, active: true });
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
