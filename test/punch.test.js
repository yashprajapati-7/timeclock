import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d, memDb } from './helpers.js';
import { punch } from '../src/punch.js';
import { createEmployee, getShift, listAudit, setSettings } from '../src/repo.js';

const seed = () => {
  const db = memDb();
  setSettings(db, { breakMode: 'actual' });
  createEmployee(db, { id: 'e1', name: 'Ann', pin: '1111', rate1: 20, rate2: 30, active: true }, 0);
  return { db, emp: { id: 'e1', name: 'Ann' } };
};

test('full sequence in → bs → be → out', () => {
  const { db, emp } = seed();
  const r1 = punch(db, emp, 'in', d(2026,10,27,9));
  assert.equal(r1.type, 'in');
  punch(db, emp, 'bs', d(2026,10,27,12));
  punch(db, emp, 'be', d(2026,10,27,12,30));
  const out = punch(db, emp, 'out', d(2026,10,27,17));
  assert.equal(out.calc.paid, 7.5);
  assert.equal(out.at, d(2026,10,27,17));
  const audit = listAudit(db).map(a => [a.actor, a.action]).reverse();
  assert.deepEqual(audit, [['Ann','Clock in'],['Ann','Break start'],['Ann','Break end'],['Ann','Clock out']]);
});

test('invalid transitions → 409', () => {
  const { db, emp } = seed();
  assert.throws(() => punch(db, emp, 'out', 1), e => e.status === 409 && /Not clocked in/.test(e.message));
  punch(db, emp, 'in', 1000);
  assert.throws(() => punch(db, emp, 'in', 2000), e => e.status === 409 && /Already clocked in/.test(e.message));
  assert.throws(() => punch(db, emp, 'be', 2000), e => e.status === 409 && /Not on break/.test(e.message));
  punch(db, emp, 'bs', 3000);
  assert.throws(() => punch(db, emp, 'bs', 4000), e => e.status === 409 && /Already on break/.test(e.message));
  assert.throws(() => punch(db, emp, 'zz', 4000), e => e.status === 422);
});

test('out during a break closes the break at clock-out', () => {
  const { db, emp } = seed();
  punch(db, emp, 'in', d(2026,10,27,9));
  punch(db, emp, 'bs', d(2026,10,27,12));
  const r = punch(db, emp, 'out', d(2026,10,27,13));
  const sh = getShift(db, r.shift.id);
  assert.equal(sh.breaks[0].end, d(2026,10,27,13));
  assert.equal(sh.out, d(2026,10,27,13));
});
