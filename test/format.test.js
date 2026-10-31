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
  for(const n of ['-3.5', '12.50']) assert.equal(F.safeText(n), n);
  for(const bad of ['-1+A1', "-2-cmd|' /C calc'!A0", '\t=1+1', '\r=1+1']) assert.equal(F.safeText(bad), "'" + bad);
});

test('csvBuild quotes, escapes and adds BOM', () => {
  const out = F.csvBuild([['a', 'b"c'], ['=x', 1]]);
  assert.equal(out, '﻿"a","b""c"\r\n"\'=x","1"');
});

test('rounding helpers work on local wall-clock minutes', () => {
  const t = (h, m, s = 0) => new Date(2026, 9, 27, h, m, s).getTime();
  assert.equal(F.floorMin(t(9, 6, 59)), t(9, 6));
  assert.equal(F.ceilStep(t(9, 8), 15), t(9, 15));
  assert.equal(F.ceilStep(t(9, 15), 15), t(9, 15));
  assert.equal(F.ceilStep(t(9, 16), 15), t(9, 30));
  assert.equal(F.ceilStep(t(23, 50), 15), new Date(2026, 9, 28, 0, 0).getTime());
  assert.equal(F.floorStep(t(16, 40), 15), t(16, 30));
  assert.equal(F.floorStep(t(16, 30), 15), t(16, 30));
});

test('atLocal builds local wall-clock times, including across DST changes', () => {
  assert.equal(F.atLocal('2026-10-27', '09:30'), new Date(2026, 9, 27, 9, 30).getTime());
  // Sydney DST starts 2026-10-04 and ends 2027-04-04; wall-clock 06:00 must stay 06:00 locally.
  for(const day of ['2026-10-04', '2027-04-04']){
    const ts = F.atLocal(day, '06:00'), d = new Date(ts);
    assert.equal(F.ymd(ts), day);
    assert.equal(d.getHours(), 6);
    assert.equal(d.getMinutes(), 0);
  }
  assert.equal(F.addDaysYmd('2026-10-31', 1), '2026-11-01');
  assert.equal(F.addDaysYmd('2026-11-01', -1), '2026-10-31');
});

test('parseShortTime accepts the roster shorthand and 24h times', () => {
  assert.equal(F.parseShortTime('9.30', 'AM'), '09:30');
  assert.equal(F.parseShortTime('9.5', 'PM'), '21:50');
  assert.equal(F.parseShortTime('9', 'AM'), '09:00');
  assert.equal(F.parseShortTime('12', 'AM'), '00:00');
  assert.equal(F.parseShortTime('12', 'PM'), '12:00');
  assert.equal(F.parseShortTime('17:00'), '17:00');
  assert.equal(F.parseShortTime('7:05', 'PM'), '19:05');
  assert.equal(F.parseShortTime('13', 'PM'), null);
  assert.equal(F.parseShortTime('9.75', 'AM'), null);
  assert.equal(F.parseShortTime('', 'AM'), null);
  assert.equal(F.fmt12('09:00'), '9A');
  assert.equal(F.fmt12('17:30'), '5:30P');
  assert.equal(F.fmt12('00:00'), '12A');
});
