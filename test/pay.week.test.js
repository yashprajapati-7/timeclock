import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d } from './helpers.js';
import { week, totals } from '../src/shared/pay.js';

const ws = new Date(d(2026,10,26));
const settings = { tierHours: 24, breakMode: 'policy', breakRules: [{h:4,m:15},{h:5,m:30},{h:7,m:60},{h:10,m:90}] };
const emp = (id, extra = {}) => ({ id, name: id, pin: '1111', rate1: 20, rate2: 30, active: true, ...extra });
const sh = (id, empId, from, to, breaks = []) => ({ id, empId, in: from, out: to, breaks });
export const tierFixture = () => ({
  settings, adj: {},
  employees: [emp('e1')],
  shifts: [0,1,2,3,4].map(i => sh('s' + i, 'e1', d(2026,10,26 + i,9), d(2026,10,26 + i,15))),
});

test('tier split', () => {
  const [r] = week(tierFixture(), ws);
  assert.equal(r.paid, 27.5);
  assert.equal(r.h1, 24);
  assert.equal(r.h2, 3.5);
  assert.equal(r.gross, 585);
});

test('overnight shift counts on its start day and week only', () => {
  const data = { settings, adj: {}, employees: [emp('e1')], shifts: [sh('s', 'e1', d(2026,11,1,22), d(2026,11,2,6))] };
  const [r] = week(data, ws);
  assert.ok(r.days[6] > 0);
  assert.equal(week(data, new Date(d(2026,11,2)))[0].paid, 0);
});

test('shift starting at next Monday 00:00 excluded', () => {
  const data = { settings, adj: {}, employees: [emp('e1')], shifts: [sh('s', 'e1', d(2026,11,2), d(2026,11,2,4))] };
  assert.equal(week(data, ws)[0].shifts.length, 0);
});

test('adjustments', () => {
  const data = tierFixture();
  data.adj['2026-10-26|e1'] = [{ type: 'allowance', label: 'x', amount: 50 }, { type: 'deduction', label: 'y', amount: 20 }];
  const [r] = week(data, ws);
  assert.equal(r.net, r.gross + 30);
});

test('inactive employees', () => {
  const data = { settings, adj: {}, employees: [emp('a', { active: false }), emp('b', { active: false })], shifts: [sh('s', 'b', d(2026,10,27,9), d(2026,10,27,10))] };
  assert.deepEqual(week(data, ws).map(r => r.e.id), ['b']);
});

test('missing rates are zero', () => {
  const data = tierFixture();
  data.employees[0].rate1 = ''; data.employees[0].rate2 = null;
  const [r] = week(data, ws);
  assert.equal(r.r1, 0);
  assert.equal(r.p1, 0);
});

test('totals sums rows', () => {
  const data = tierFixture();
  data.employees.push(emp('e2'));
  data.shifts.push(sh('x', 'e2', d(2026,10,26,9), d(2026,10,26,12)));
  const rows = week(data, ws), T = totals(rows);
  assert.equal(T.net, rows[0].net + rows[1].net);
  assert.equal(T.days[0], rows[0].days[0] + rows[1].days[0]);
});

test('open shift uses now', () => {
  const data = { settings, adj: {}, employees: [emp('e1')], shifts: [sh('s', 'e1', d(2026,10,27,9), null)] };
  const [r] = week(data, ws, d(2026,10,27,12));
  assert.equal(r.open, true);
  assert.equal(r.total, 3);
});
