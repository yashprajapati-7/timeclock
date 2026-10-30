import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d } from './helpers.js';
import { anomalies } from '../src/shared/pay.js';

const ws = new Date(d(2026,10,26));
const base = (over = {}) => ({
  settings: { maxShiftHours: 14, defaultPin: false, breakRules: [], breakMode: 'actual', tierHours: 24 },
  employees: [{ id: 'e1', name: 'Alice', pin: '1111', rate1: 20, rate2: 30, active: true }],
  shifts: [], adj: {}, ...over,
});

test('default pin alert', () => {
  const data = base(); data.settings.defaultPin = true;
  const a = anomalies(data, ws, d(2026,10,27));
  assert.equal(a[0].level, 'high');
  assert.equal(a[0].tab, 'settings');
});

test('long open shift and long break', () => {
  const now = d(2026,10,28,12);
  const data = base({ shifts: [{ id: 's1', empId: 'e1', in: d(2026,10,27,20), out: null, breaks: [{ start: d(2026,10,28,9), end: null }] }] });
  const a = anomalies(data, ws, now);
  const high = a.find(x => x.level === 'high'), med = a.find(x => x.level === 'med');
  assert.equal(high.shiftId, 's1');
  assert.match(high.msg, /Alice/);
  assert.equal(med.shiftId, 's1');
});

test('13h open shift with max 14 → no alert', () => {
  const data = base({ shifts: [{ id: 's1', empId: 'e1', in: d(2026,10,27,0), out: null, breaks: [] }] });
  assert.equal(anomalies(data, ws, d(2026,10,27,13)).length, 0);
});

test('overlapping shifts', () => {
  const data = base({ shifts: [
    { id: 'a', empId: 'e1', in: d(2026,10,27,9), out: d(2026,10,27,17), breaks: [] },
    { id: 'b', empId: 'e1', in: d(2026,10,27,16), out: d(2026,10,27,18), breaks: [] },
  ] });
  const a = anomalies(data, ws, d(2026,10,28));
  assert.equal(a.length, 1);
  assert.equal(a[0].shiftId, 'b');
});

test('missing rate', () => {
  const data = base(); data.employees[0].rate1 = null;
  const a = anomalies(data, ws, d(2026,10,27));
  assert.equal(a[0].level, 'low');
  assert.equal(a[0].empId, 'e1');
});
