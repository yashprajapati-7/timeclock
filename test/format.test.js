import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d } from './helpers.js';
import * as F from '../src/shared/format.js';

test('fmtHM / fmtMin', () => {
  assert.equal(F.fmtHM(7.5), '7:30');
  assert.equal(F.fmtHM(-0.25), '-0:15');
  assert.equal(F.fmtHM(0), '0:00');
  assert.equal(F.fmtMin(90), '1:30');
});

test('week helpers', () => {
  assert.equal(+F.startOfWeek(d(2026, 10, 28, 15)), d(2026, 10, 26));
  assert.equal(+F.startOfWeek(d(2026, 11, 1, 23)), d(2026, 10, 26));
  assert.equal(F.dayIndex(d(2026, 11, 1)), 6);
  assert.equal(F.ymd(d(2026, 1, 5)), '2026-01-05');
  assert.equal(+F.addDays(d(2026, 10, 26), 7), d(2026, 11, 2));
});

test('money / num', () => {
  assert.equal(F.money(-3.5, '₹'), '-₹3.50');
  assert.equal(F.num('abc'), 0);
  assert.equal(F.num('2.5'), 2.5);
});

test('safeText guards formulas but leaves numbers', () => {
  assert.equal(F.safeText('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(F.safeText('-5'), '-5');
  assert.equal(F.safeText('@x'), "'@x");
  assert.equal(F.safeText('+1 call'), "'+1 call");
  assert.equal(F.safeText('Bob'), 'Bob');
});

test('csvBuild quotes, escapes and adds BOM', () => {
  const out = F.csvBuild([['a', 'b"c'], ['=x', 1]]);
  assert.equal(out, '﻿"a","b""c"\r\n"\'=x","1"');
});
