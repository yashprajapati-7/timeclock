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
