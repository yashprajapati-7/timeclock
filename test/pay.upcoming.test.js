import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upcoming } from '../src/shared/pay.js';

const now = new Date(2026, 9, 30, 10).getTime();     // Fri 30 Oct 2026
const emp = (id, extra) => ({ id, name: id, active: true, ...extra });

test('birthdays and anniversaries within 7 days, sorted', () => {
  const list = upcoming([
    emp('today', { birthday: '1990-10-30' }),
    emp('in7', { birthday: '1995-11-06' }),
    emp('in8', { birthday: '1995-11-07' }),
    emp('anniv', { startDate: '2024-11-02' }),
    emp('new', { startDate: '2026-10-28' }),
    emp('gone', { birthday: '1990-10-31', active: false }),
  ], now);
  assert.deepEqual(list.map(x => [x.empId, x.kind, x.inDays]), [['today', 'birthday', 0], ['anniv', 'anniversary', 3], ['in7', 'birthday', 7]]);
  assert.equal(list.find(x => x.kind === 'anniversary').years, 2);
});

test('year wrap and 29 February', () => {
  const dec = new Date(2026, 11, 28).getTime();
  assert.equal(upcoming([emp('a', { birthday: '2000-01-02' })], dec)[0].inDays, 5);
  const feb = new Date(2027, 1, 25).getTime();
  const leap = upcoming([emp('l', { birthday: '2004-02-29' })], feb)[0];
  assert.equal(leap.date, '2027-02-28');
});
