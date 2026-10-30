import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d } from './helpers.js';
import { policyBreak, shift } from '../src/shared/pay.js';

const rules = [{h:4,m:15},{h:5,m:30},{h:7,m:60},{h:10,m:90}];
const S = mode => ({ breakMode: mode, breakRules: rules });

test('policyBreak picks highest matching rule', () => {
  assert.equal(policyBreak(3.99, rules), 0);
  assert.equal(policyBreak(4, rules), 15);
  assert.equal(policyBreak(6.5, rules), 30);
  assert.equal(policyBreak(10, rules), 90);
  assert.equal(policyBreak(6.5, [...rules].reverse()), 30);
});

const day = { in: d(2026,10,27,9), out: d(2026,10,27,17), breaks: [{ start: d(2026,10,27,12), end: d(2026,10,27,12,20) }] };

test('shift break modes', () => {
  const p = shift(day, S('policy'));
  assert.deepEqual([p.total, p.actual, p.policy, p.ded, p.paid], [8, 20, 60, 60, 7]);
  const a = shift(day, S('actual'));
  assert.equal(a.ded, 20);
  assert.ok(Math.abs(a.paid - 7.6667) < 1e-3);
  assert.equal(shift(day, S('greater')).ded, 60);
  const five = { in: d(2026,10,27,9), out: d(2026,10,27,14), breaks: [{ start: d(2026,10,27,11), end: d(2026,10,27,11,45) }] };
  assert.equal(shift(five, S('greater')).ded, 45);
});

test('open shift and open break use now', () => {
  const now = d(2026,10,27,12);
  const c = shift({ in: d(2026,10,27,9), out: null, breaks: [{ start: d(2026,10,27,11,30), end: null }] }, S('actual'), now);
  assert.equal(c.actual, 30);
  assert.equal(c.total, 3);
  assert.equal(c.open, true);
});

test('deduction capped at total', () => {
  const c = shift({ in: d(2026,10,27,9), out: d(2026,10,27,9,1), breaks: [] }, { breakMode: 'policy', breakRules: [{h:0,m:90}] });
  assert.equal(c.ded, 1);
  assert.equal(c.paid, 0);
});
