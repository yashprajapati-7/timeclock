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

const rosterAll = (start, end) => Object.fromEntries([0, 1, 2, 3, 4].map(i => [`2026-10-${26 + i}|e1`, [{ type: 'CAFE', start, end }]]));

test('week uses rounded paid hours and counts late starts', () => {
  const data = tierFixture();
  data.settings = { ...data.settings, rounding: true, roundGraceMin: 6, roundStepMin: 15, roundFrom: '2026-10-26' };
  data.roster = rosterAll('09:00', '15:00');
  data.shifts[0].in = d(2026,10,26,9,10);
  const [r] = week(data, ws);
  assert.equal(r.paid, 27.25);
  assert.equal(r.late, 1);
  assert.equal(r.lateMin, 10);
});

test('a week before roundFrom is identical to having no roster', () => {
  const base = tierFixture();
  base.shifts[0].in = d(2026,10,26,9,10);
  const withRoster = { ...base, roster: rosterAll('09:00', '15:00'), settings: { ...base.settings, rounding: true, roundGraceMin: 6, roundStepMin: 15, roundFrom: '2026-11-02' } };
  const strip = rows => rows.map(({ e, shifts, ...r }) => r);
  assert.deepEqual(strip(week(withRoster, ws)), strip(week(base, ws)));
});

test('salary pays the fixed weekly amount regardless of hours', () => {
  const data = { settings, adj: {}, employees: [emp('s1', { payType: 'salary', weeklySalary: 800 })],
    shifts: [sh('x', 's1', d(2026,10,27,9), d(2026,10,27,12))] };
  const [r] = week(data, ws);
  assert.deepEqual([r.p1, r.p2, r.gross, r.net, r.paid, r.salary], [0, 0, 800, 800, 3, 800]);
});

test('salary is not paid before the start date; hourly rows have salary null', () => {
  const data = { settings, adj: {}, shifts: [],
    employees: [emp('s1', { payType: 'salary', weeklySalary: 800, startDate: '2026-11-03' }), emp('h1')] };
  const rows = week(data, ws);
  assert.equal(rows.find(r => r.e.id === 's1').gross, 0);
  assert.equal(rows.find(r => r.e.id === 'h1').salary, null);
  assert.equal(week(data, new Date(d(2026,11,2))).find(r => r.e.id === 's1').gross, 800);
});

test('fixed items apply within their weeks and only when there is pay', () => {
  const items = [{ type: 'allowance', label: 'Phone', amount: 10, from: '2026-10-26', to: null },
    { type: 'deduction', label: 'Uniform', amount: 4, from: '2026-10-19', to: '2026-10-19' }];
  const data = tierFixture();
  data.employees[0].fixedItems = items;
  const [r] = week(data, ws);
  assert.equal(r.allow, 10);
  assert.equal(r.deduct, 0);
  assert.equal(r.net, r.gross + 10);
  assert.deepEqual(r.fixed.map(f => f.label), ['Phone']);
  const before = week(data, new Date(d(2026,10,19)));       // no shifts that week → no pay → no fixed items
  assert.equal(before[0].allow, 0);
  data.adj['2026-10-26|e1'] = [{ type: 'allowance', label: 'Travel', amount: 5 }];
  assert.equal(week(data, ws)[0].allow, 15);
  const sal = { settings, adj: {}, shifts: [], employees: [emp('s1', { payType: 'salary', weeklySalary: 500, fixedItems: items })] };
  assert.equal(week(sal, ws)[0].net, 510);                   // salaried: fixed items apply even with no hours
});

test('fixed rate pays one rate for every hour, before and after the tier', () => {
  const f = tierFixture();
  f.employees = [emp('e1', { payType: 'fixed', rate1: 25, rate2: 99 })];
  const [r] = week(f, ws);
  assert.ok(r.paid > 24);
  assert.equal(r.r2, 25);
  assert.ok(Math.abs(r.gross - r.paid * 25) < 1e-9);
});

test('hasPay: only rows with hours, salary or adjustments', async () => {
  const { hasPay } = await import('../src/shared/pay.js');
  assert.equal(hasPay({ paid: 0, salary: null, allow: 0, deduct: 0 }), false);
  for(const r of [{ paid: 0.5 }, { salary: 900 }, { allow: 20 }, { deduct: 5 }])
    assert.equal(hasPay({ paid: 0, salary: null, allow: 0, deduct: 0, ...r }), true);
});

test('anomalies() is gone (the alerts panel was removed)', async () => {
  assert.equal('anomalies' in await import('../src/shared/pay.js'), false);
});
