import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d } from './helpers.js';
import { validatePin, validateEmployee, validateShift, validateSettings, validateAdjustment, validateRosterEntries } from '../src/validate.js';

const bad = (fn, re) => assert.throws(fn, e => e.status === 422 && (!re || re.test(e.message)));
const emps = [{ id: 'e1', pin: '1111' }];

test('pin rules', () => {
  bad(() => validatePin('12', emps), /4 digits/);
  bad(() => validatePin('1111', emps), /already used/);
  validatePin('1111', emps, 'e1');
  validatePin('2222', emps);
});

test('employee', () => {
  bad(() => validateEmployee({ name: '  ', pin: '1234' }), /name/i);
  bad(() => validateEmployee({ name: 'A', pin: '1234', rate1: -1 }), /rate/i);
  assert.deepEqual(validateEmployee({ name: ' Ann ', pin: '1234', rate1: '', rate2: '30', active: false }),
    { name: 'Ann', pin: '1234', rate1: null, rate2: 30, active: false, role: '', payType: 'hourly', weeklySalary: null,
      email: '', phone: '', birthday: null, startDate: null, fixedItems: [] });
});

const day = (h, m = 0) => d(2026,10,27,h,m);
test('shift rules', () => {
  bad(() => validateShift({ empId: 'e1', in: null, out: null, breaks: [] }, []), /Clock-in/);
  bad(() => validateShift({ empId: 'e1', in: day(9), out: day(8), breaks: [] }, []), /after/);
  bad(() => validateShift({ empId: 'e1', in: day(9), out: day(17), breaks: [{ start: day(8), end: day(9) }] }, []), /inside/);
  bad(() => validateShift({ empId: 'e1', in: day(9), out: day(17), breaks: [{ start: day(12), end: day(11) }] }, []), /ends before/);
  bad(() => validateShift({ empId: 'e1', in: day(9), out: day(17), breaks: [{ start: day(12), end: day(13) }, { start: day(12, 30), end: day(14) }] }, []), /overlap/);
  // open break on a closed shift ends at clock-out; breaks come back sorted
  bad(() => validateShift({ empId: 'e1', in: day(9), out: day(17), breaks: [{ start: day(16), end: day(17) }, { start: day(12), end: null }] }, []), /overlap/);
  const ok = validateShift({ empId: 'e1', in: day(9), out: day(17), breaks: [{ start: day(16), end: day(17) }, { start: day(12), end: day(12, 30) }] }, []);
  assert.deepEqual(ok.breaks.map(b => b.start), [day(12), day(16)]);
  const open = validateShift({ empId: 'e1', in: day(9), out: day(17), breaks: [{ start: day(16), end: null }] }, []);
  assert.equal(open.breaks[0].end, day(17));
  bad(() => validateShift({ empId: 'e1', in: day(18), out: day(20), breaks: [] }, [{ id: 'x', in: day(9), out: null }]), /Overlaps/);
  validateShift({ empId: 'e1', in: day(17), out: day(20), breaks: [] }, [{ id: 'x', in: day(9), out: day(17) }]);
});

test('settings', () => {
  const s = validateSettings({ company: '', tierHours: -5, kioskIdleSec: 1, breakRules: [{ h: 7, m: 60 }, { h: 0, m: 9 }, { h: 4, m: 15 }] });
  assert.deepEqual(s, { company: 'Time Clock', tierHours: 0, kioskIdleSec: 5, breakRules: [{ h: 4, m: 15 }, { h: 7, m: 60 }] });
  bad(() => validateSettings({ adminPinHash: 'x' }), /adminPinHash/);
  bad(() => validateSettings({ breakMode: 'nope' }), /breakMode/);
  bad(() => validateSettings({ theme: 'pink' }), /theme/);
});

test('adjustment', () => {
  bad(() => validateAdjustment({ week: '2026-10-27', empId: 'e1', type: 'allowance', amount: 5 }), /Monday/);
  bad(() => validateAdjustment({ week: '2026-10-26', empId: 'e1', type: 'allowance', amount: 0 }), /amount/i);
  bad(() => validateAdjustment({ week: '2026-10-26', empId: 'e1', type: 'gift', amount: 5 }), /type/);
  assert.equal(validateAdjustment({ week: '2026-10-26', empId: 'e1', type: 'deduction', amount: '5', label: '' }).label, '—');
});

test('employee: pay type, contact, dates, fixed items', () => {
  const ok = validateEmployee({ name: 'Sal', pin: '1234', payType: 'salary', weeklySalary: '800', email: ' A@B.Co ', phone: '+61 400 000 000',
    birthday: '1999-11-02', startDate: '2024-11-04', role: ' Barista ',
    fixedItems: [{ type: 'allowance', label: ' Phone ', amount: '10', from: '2026-10-26' }, { type: 'deduction', label: 'Uniform', amount: 5, from: '2026-10-26', to: '2026-11-02' }] });
  assert.equal(ok.email, 'a@b.co');
  assert.equal(ok.weeklySalary, 800);
  assert.equal(ok.role, 'Barista');
  assert.deepEqual(ok.fixedItems[0], { type: 'allowance', label: 'Phone', amount: 10, from: '2026-10-26', to: null });
  bad(() => validateEmployee({ name: 'S', pin: '1234', payType: 'salary' }), /Weekly salary/);
  bad(() => validateEmployee({ name: 'S', pin: '1234', email: 'bob@' }), /Email/);
  bad(() => validateEmployee({ name: 'S', pin: '1234', phone: '12' }), /Phone/);
  bad(() => validateEmployee({ name: 'S', pin: '1234', birthday: '2026-02-30' }), /Birthday/);
  bad(() => validateEmployee({ name: 'S', pin: '1234', birthday: '2999-01-01' }), /Birthday/);
  bad(() => validateEmployee({ name: 'S', pin: '1234', payType: 'weekly' }), /Pay type/);
  bad(() => validateEmployee({ name: 'S', pin: '1234', fixedItems: [{ type: 'allowance', label: 'x', amount: 1, from: '2026-10-27' }] }), /Monday/);
  bad(() => validateEmployee({ name: 'S', pin: '1234', fixedItems: [{ type: 'allowance', label: 'x', amount: 0, from: '2026-10-26' }] }), /amount/i);
  bad(() => validateEmployee({ name: 'S', pin: '1234', fixedItems: [{ type: 'allowance', label: 'x', amount: 1, from: '2026-10-26', to: '2026-10-19' }] }), /until/i);
  assert.equal(validateEmployee({ name: 'H', pin: '1234', payType: 'hourly', weeklySalary: 500 }).weeklySalary, null);
});

test('roster entries', () => {
  assert.deepEqual(validateRosterEntries([{ type: 'OFF', start: '09:00' }]), [{ type: 'OFF', start: null, end: null }]);
  assert.deepEqual(validateRosterEntries([{ type: 'CAFE', start: '09:00', end: '17:00' }]), [{ type: 'CAFE', start: '09:00', end: '17:00' }]);
  assert.deepEqual(validateRosterEntries([]), []);
  bad(() => validateRosterEntries([{ type: 'CAFE', start: '9:00', end: '17:00' }]), /HH:MM/);
  bad(() => validateRosterEntries([{ type: 'CAFE', start: '09:00', end: '09:00' }]), /same/);
  bad(() => validateRosterEntries([{ type: 'NAP' }]), /type/);
  bad(() => validateRosterEntries(Array(5).fill({ type: 'OFF' })), /4/);
  bad(() => validateRosterEntries('x'), /list/);
});

test('rounding settings', () => {
  assert.deepEqual(validateSettings({ rounding: 1, roundGraceMin: 50, roundStepMin: 15, roundFrom: '2026-11-02' }),
    { rounding: true, roundGraceMin: 30, roundStepMin: 15, roundFrom: '2026-11-02' });
  assert.equal(validateSettings({ roundFrom: null }).roundFrom, null);
  assert.equal(validateSettings({ roundFrom: '' }).roundFrom, null);
  bad(() => validateSettings({ roundStepMin: 7 }), /step/i);
  bad(() => validateSettings({ roundFrom: '2026-11-03' }), /Monday/);
  bad(() => validateSettings({ rosterImport: {} }), /Unknown/);
});

test('employee pay type accepts fixed rate', async () => {
  const { validateEmployee } = await import('../src/validate.js');
  assert.equal(validateEmployee({ name: 'A', payType: 'fixed', rate1: 25 }).payType, 'fixed');
});
