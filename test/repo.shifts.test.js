import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d, memDb } from './helpers.js';
import * as R from '../src/repo.js';
import { week } from '../src/shared/pay.js';

const seed = () => {
  const db = memDb();
  R.createEmployee(db, { id: 'e1', name: 'e1', pin: '1111', rate1: 20, rate2: 30, active: true }, 0);
  return db;
};

test('shift with breaks round trips', () => {
  const db = seed();
  R.saveShift(db, { id: 's1', empId: 'e1', in: 100, out: null, breaks: [{ start: 300, end: 400 }, { start: 150, end: 200 }] });
  assert.deepEqual(R.getShift(db, 's1'), { id: 's1', empId: 'e1', in: 100, out: null, breaks: [{ start: 150, end: 200 }, { start: 300, end: 400 }] });
  R.saveShift(db, { id: 's1', empId: 'e1', in: 100, out: 500, breaks: [{ start: 150, end: null }] });
  assert.equal(db.get('SELECT COUNT(*) n FROM breaks').n, 1);
  assert.equal(R.getShift(db, 's1').out, 500);
  assert.equal(R.employeeHasShifts(db, 'e1'), true);
});

test('openShiftFor and listShifts', () => {
  const db = seed();
  R.saveShift(db, { id: 'a', empId: 'e1', in: 100, out: 200, breaks: [] });
  R.saveShift(db, { id: 'b', empId: 'e1', in: 300, out: null, breaks: [] });
  assert.equal(R.openShiftFor(db, 'e1').id, 'b');
  assert.deepEqual(R.listShifts(db, { from: 250 }).map(s => s.id), ['b']);
  R.deleteShift(db, 'b');
  assert.equal(R.openShiftFor(db, 'e1'), null);
});

test('adjustments map', () => {
  const db = seed();
  const id = R.addAdjustment(db, { week: '2026-10-26', empId: 'e1', type: 'allowance', label: 'Travel', amount: 50 });
  R.addAdjustment(db, { week: '2026-10-26', empId: 'e1', type: 'deduction', label: 'Uniform', amount: 20 });
  const map = R.listAdjustments(db);
  assert.deepEqual(Object.keys(map), ['2026-10-26|e1']);
  assert.deepEqual(map['2026-10-26|e1'].map(a => a.label), ['Travel', 'Uniform']);
  R.deleteAdjustment(db, id);
  assert.equal(R.listAdjustments(db)['2026-10-26|e1'].length, 1);
});

test('loadData feeds pay.week like a hand-built fixture', () => {
  const db = seed();
  R.setSettings(db, { breakMode: 'policy' });
  for(let i = 0; i < 5; i++) R.saveShift(db, { id: 's' + i, empId: 'e1', in: d(2026,10,26 + i,9), out: d(2026,10,26 + i,15), breaks: [] });
  const [r] = week(R.loadData(db), new Date(d(2026,10,26)));
  assert.equal(r.paid, 27.5);
  assert.equal(r.gross, 585);
});
