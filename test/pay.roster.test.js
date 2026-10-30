// Roster-based paid times (plan Tasks 9–12, 16): exact rounding tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d } from './helpers.js';
import { matchRoster, paidSpan, shift, calcAll, rosterSpan, rosterWeek, anomalies } from '../src/shared/pay.js';
import { atLocal } from '../src/shared/format.js';

const DAY = '2026-10-27';
const t = (h, m = 0, s = 0) => new Date(2026, 9, 27, h, m, s).getTime();
const ST = { rounding: true, roundGraceMin: 6, roundStepMin: 15, roundFrom: '2026-10-26',
  breakMode: 'policy', breakRules: [{ h: 4, m: 15 }, { h: 5, m: 30 }, { h: 7, m: 60 }, { h: 10, m: 90 }] };
const cafe = (start, end) => ({ type: 'CAFE', start, end });
const roster = (day, ...entries) => ({ [`${day}|e1`]: entries });
const sh = (id, inTs, outTs, extra = {}) => ({ id, empId: 'e1', in: inTs, out: outTs, breaks: [], ...extra });
const match1 = (s, r, st = ST) => matchRoster([s], r, 'e1', st).get(s.id);
const paid = (inTs, outTs, extra = {}, r = roster(DAY, cafe('09:00', '17:00')), st = ST, now) => {
  const s = sh('x', inTs, outTs, extra);
  return paidSpan(s, match1(s, r, st), st, now);
};

test('rosterSpan builds local wall-clock times; overnight ends next day (DST safe)', () => {
  assert.deepEqual(rosterSpan(cafe('09:00', '17:00'), DAY), { S: t(9), E: t(17) });
  // Sydney DST ends 2027-04-04 03:00 → 02:00; a 22:00–06:00 entry on 04-03 must end at local 06:00 on 04-04.
  const { S, E } = rosterSpan(cafe('22:00', '06:00'), '2027-04-03');
  assert.equal(S, atLocal('2027-04-03', '22:00'));
  assert.equal(E, atLocal('2027-04-04', '06:00'));
  assert.equal(new Date(E).getHours(), 6);
});

test('match: nearest entry, window, split shift, chain, overnight, OFF', () => {
  const r = roster(DAY, cafe('09:00', '17:00'));
  assert.ok(match1(sh('a', t(8, 30), t(17)), r));
  const split = roster(DAY, cafe('09:00', '13:00'), cafe('17:00', '21:00'));
  assert.equal(match1(sh('b', t(16, 50), t(21)), split).entry.start, '17:00');
  const chain = matchRoster([sh('c1', t(9, 1), t(12)), sh('c2', t(12, 30), t(17, 2))], r, 'e1', ST);
  assert.equal(chain.get('c1').first, true);
  assert.equal(chain.get('c1').last, false);
  assert.equal(chain.get('c2').first, false);
  assert.equal(chain.get('c2').last, true);
  const night = roster(DAY, cafe('22:00', '06:00'));
  assert.equal(match1(sh('n', t(21, 58), null), night).E, new Date(2026, 9, 28, 6).getTime());
  assert.equal(match1(sh('o', t(9), t(17)), roster(DAY, { type: 'OFF' })), undefined);
});

test('early clock-in far before the roster still matches the same day entry (paid from start)', () => {
  const p = paid(t(6, 30), t(17));
  assert.equal(p.paidIn, t(9));
});

test('no rounding before roundFrom, when switched off, or without roster', () => {
  const r = roster('2026-10-20', cafe('09:00', '17:00'));
  const s = sh('old', new Date(2026, 9, 20, 9, 20).getTime(), new Date(2026, 9, 20, 17, 0).getTime());
  assert.equal(match1(s, r), undefined);                                  // before roundFrom 2026-10-26
  assert.equal(match1(s, r, { ...ST, roundFrom: null }), undefined);       // not yet in effect
  assert.equal(match1(sh('x', t(9, 20), t(17)), roster(DAY, cafe('09:00', '17:00')), { ...ST, rounding: false }), undefined);
  const p = paidSpan(sh('y', t(9, 20), t(17)), undefined, ST);
  assert.deepEqual([p.paidIn, p.paidOut, p.lateMin], [t(9, 20), t(17), 0]);
});

test('start rounding table (roster 9:00)', () => {
  const cases = [[[8, 54], [9, 0], 0], [[9, 6], [9, 0], 0], [[9, 6, 59], [9, 0], 0], [[9, 7], [9, 15], 7], [[9, 8], [9, 15], 8],
    [[9, 15], [9, 15], 15], [[9, 20], [9, 30], 20], [[9, 40], [9, 45], 40], [[8, 30], [9, 0], 0]];
  for(const [inHm, want, late] of cases){
    const p = paid(t(...inHm), t(17));
    assert.equal(p.paidIn, t(...want), `in ${inHm.join(':')}`);
    assert.equal(p.lateMin, late, `late ${inHm.join(':')}`);
  }
});

test('finish rounding table (roster end 17:00)', () => {
  assert.equal(paid(t(9), t(16, 55)).paidOut, t(17));
  assert.equal(paid(t(9), t(17, 6)).paidOut, t(17));
  const over = paid(t(9), t(17, 25));
  assert.deepEqual([over.paidOut, over.capped], [t(17), 25]);
  assert.equal(paid(t(9), t(17, 25), { otApproved: true }).paidOut, t(17, 15));
  const early = paid(t(9), t(16, 40));
  assert.deepEqual([early.paidOut, early.earlyMin], [t(16, 30), 20]);
  assert.equal(paid(t(9), null, {}, undefined, ST, t(18)).paidOut, t(17));      // open shift past end stops at 17:00
  assert.equal(paid(t(9), null, {}, undefined, ST, t(12)).paidOut, t(12));      // still working: no "early" rounding
  assert.equal(paid(t(9), null, {}, undefined, ST, t(12)).earlyMin, 0);
  const zero = paid(t(16, 50), t(16, 52));
  assert.equal(zero.paidOut - zero.paidIn, 0);
  const night = paid(t(22), new Date(2026, 9, 28, 6, 4).getTime(), {}, roster(DAY, cafe('22:00', '06:00')));
  assert.equal(night.paidOut, new Date(2026, 9, 28, 6).getTime());
});

test('DST start day (2026-10-04): wall-clock rostered times are respected', () => {
  const r = { '2026-10-04|e1': [cafe('09:00', '17:00')] };
  const st = { ...ST, roundFrom: '2026-09-28' };
  const s = sh('dst', atLocal('2026-10-04', '09:03'), atLocal('2026-10-04', '17:04'));
  const p = paidSpan(s, matchRoster([s], r, 'e1', st).get('dst'), st);
  assert.equal(p.paidIn, atLocal('2026-10-04', '09:00'));
  assert.equal(p.paidOut, atLocal('2026-10-04', '17:00'));
});

test('shift() uses the paid span: 9:20–17:30 rostered 9–17', () => {
  const s = sh('s', t(9, 20), t(17, 30));
  const c = shift(s, ST, Date.now(), match1(s, roster(DAY, cafe('09:00', '17:00'))));
  assert.equal(c.total, 8 + 10 / 60);          // actual worked 8:10
  assert.equal(c.span, 7.5);                    // paid span 9:30–17:00
  assert.equal(c.ded, 60);
  assert.equal(c.paid, 6.5);
  assert.equal(c.lateMin, 20);
  assert.equal(c.capped, 30);
  assert.equal(c.roster.start, '09:00');
});

test('break deduction on the paid span for each break mode', () => {
  const r = roster(DAY, cafe('09:00', '17:00'));
  // Worked 8:30–17:40 (late break 16:50–17:30 partly outside the paid span 9:00–17:00).
  const s = sh('b', t(8, 30), t(17, 40), { breaks: [{ start: t(12), end: t(12, 20) }, { start: t(16, 50), end: t(17, 30) }] });
  const m = match1(s, r);
  const pol = shift(s, { ...ST, breakMode: 'policy' }, 0, m);
  assert.deepEqual([pol.span, pol.ded, pol.paid], [8, 60, 7]);
  const act = shift(s, { ...ST, breakMode: 'actual' }, 0, m);
  assert.equal(act.actual, 30);                 // 20 + 10 minutes inside the paid span
  assert.equal(act.ded, 30);
  const max = shift(s, { ...ST, breakMode: 'greater' }, 0, m);
  assert.equal(max.ded, 60);
});

test('calcAll returns calcs for every shift with roster matches', () => {
  const data = { settings: ST, employees: [{ id: 'e1', name: 'Ann' }], adj: {},
    shifts: [sh('a', t(9, 8), t(17))], roster: roster(DAY, cafe('09:00', '17:00')) };
  const calc = calcAll(data, Date.now()).get('a');
  assert.equal(calc.paidIn, t(9, 15));
  assert.equal(calc.lateMin, 8);
});

test('rosterWeek hours use break rules; OFF counted', () => {
  const data = { settings: ST, adj: {}, shifts: [], employees: [{ id: 'e1', name: 'Ann', active: true }],
    roster: { '2026-10-26|e1': [cafe('10:00', '17:00')], '2026-10-27|e1': [cafe('09:00', '13:00'), { type: 'BAKERY', start: '17:00', end: '21:00' }],
      '2026-10-28|e1': [{ type: 'OFF', start: null, end: null }] } };
  const w = rosterWeek(data, new Date(2026, 9, 26));
  const row = w.rows.find(r => r.empId === 'e1');
  assert.deepEqual(row.days.slice(0, 3), [6, 7, 0]);
  assert.equal(row.total, 13);
  assert.equal(row.offDays, 1);
  assert.deepEqual(w.staffPerDay.slice(0, 3), [1, 1, 0]);
  assert.equal(w.total, 13);
});

test('anomalies: unpaid overtime and salaried without a salary', () => {
  const data = { settings: { ...ST, maxShiftHours: 14 }, adj: {}, roster: roster(DAY, cafe('09:00', '17:00')),
    employees: [{ id: 'e1', name: 'Ann', rate1: 20, active: true, payType: 'hourly' }, { id: 'e2', name: 'Sal', rate1: null, active: true, payType: 'salary', weeklySalary: null }],
    shifts: [sh('ot', t(9), t(17, 40))] };
  const a = anomalies(data, new Date(2026, 9, 26), t(20));
  assert.ok(a.some(x => x.level === 'med' && x.shiftId === 'ot' && /40 min/.test(x.msg)));
  assert.ok(a.some(x => x.empId === 'e2' && /salar/i.test(x.msg)));
});
