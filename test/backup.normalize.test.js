import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { normalizeBackup } from '../src/backup.js';
import { ValidationError } from '../src/errors.js';

test('v1 migrates to v2', () => {
  const n = normalizeBackup(fixture('backup-v1'));
  assert.equal(n.v, 2);
  assert.deepEqual(n.audit, []);
  assert.equal(n.settings.adminPin, '1234');
});

test('v2 sha256 and fnv accepted unchanged', () => {
  for(const f of ['backup-v2', 'backup-v2-fnv']){
    const n = normalizeBackup(fixture(f));
    assert.equal(n.employees.length, 3);
    assert.equal(n.shifts.length, 6);
    assert.equal(n.audit.length, 2);
  }
});

test('invalid backups throw', () => {
  assert.throws(() => normalizeBackup({}), ValidationError);
  assert.throws(() => normalizeBackup(null), ValidationError);
  const bad = fixture('backup-v2'); bad.shifts[0].in = 'x';
  assert.throws(() => normalizeBackup(bad), /shift/);
  const pin = fixture('backup-v2'); pin.employees[0].pin = '12';
  assert.throws(() => normalizeBackup(pin), /pin/i);
});

test('rejects roster entries for unknown employees or with bad times', () => {
  const ghost = { ...fixture('backup-v2'), v: 3, roster: { '2026-10-27|ghost': [{ type: 'OFF' }] } };
  assert.throws(() => normalizeBackup(ghost), /roster/);
  const badTime = { ...fixture('backup-v2'), v: 3, roster: { '2026-10-27|e1': [{ type: 'CAFE', start: '9', end: '17' }] } };
  assert.throws(() => normalizeBackup(badTime), /roster/);
  const badEmp = fixture('backup-v2'); badEmp.v = 3; badEmp.employees[0].email = 'nope@';
  assert.throws(() => normalizeBackup(badEmp), /Email/);
});

test('rejects roster keys with a bad day and junk rosterImport settings', () => {
  for(const key of ['garbage-key|e1', '2026-13-45|e1', '2026-02-30|e1'])
    assert.throws(() => normalizeBackup({ ...fixture('backup-v2'), v: 3, roster: { [key]: [{ type: 'OFF' }] } }), /roster/, key);
  const b = fixture('backup-v2');
  const n = normalizeBackup({ ...b, v: 3, settings: { ...b.settings, rosterImport: [1, 2] } });
  assert.equal(n.settings.rosterImport, undefined);
  const ok = normalizeBackup({ ...b, v: 3, settings: { ...b.settings, rosterImport: { offsetDays: 1, idMap: { 1: 'e1' } } } });
  assert.deepEqual(ok.settings.rosterImport, { offsetDays: 1, idMap: { 1: 'e1' } });
});

test('roster key must use the | separator', () => {
  assert.throws(() => normalizeBackup({ ...fixture('backup-v2'), v: 3, roster: { '2026-10-26#e1': [{ type: 'OFF' }] } }), /roster 2026-10-26#e1/);
});
