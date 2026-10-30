import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d, memDb, fixture } from './helpers.js';
import { importBackup, exportBackup } from '../src/backup.js';
import { loadData, getSettings, listEmployees } from '../src/repo.js';
import { verifyPin } from '../src/auth/hash.js';
import { week } from '../src/shared/pay.js';

const ws = new Date(d(2026,10,26)), now = d(2026,10,30,12);
const legacyData = f => ({ settings: f.settings, employees: f.employees, shifts: f.shifts, adj: f.adj });
const strip = rows => rows.map(r => ({ ...r, e: { id: r.e.id, name: r.e.name } }));

test('v2 import: counts and same pay numbers as the old app', async () => {
  const db = memDb(), f = fixture('backup-v2');
  const counts = await importBackup(db, f, { now });
  assert.deepEqual(counts, { employees: 3, shifts: 6, adjustments: 2, audit: 2 });
  const fromDb = week(loadData(db), ws, now), fromLegacy = week(legacyData(f), ws, now);
  assert.deepEqual(strip(fromDb).map(r => [r.e.id, r.paid, r.gross, r.net]), strip(fromLegacy).map(r => [r.e.id, r.paid, r.gross, r.net]));
  assert.equal(await verifyPin('4321', getSettings(db).adminPinHash), true);
});

test('fnv backup verifies its PIN', async () => {
  const db = memDb();
  await importBackup(db, fixture('backup-v2-fnv'), { now });
  assert.equal(await verifyPin('4321', getSettings(db).adminPinHash), true);
});

test('v1 import rehashes plaintext PIN to scrypt', async () => {
  const db = memDb();
  await importBackup(db, fixture('backup-v1'), { now });
  const s = getSettings(db);
  assert.match(s.adminPinHash, /^scrypt\$/);
  assert.equal(await verifyPin('1234', s.adminPinHash), true);
  assert.equal(listEmployees(db)[0].rate1, null);
});

test('export → import round trip is lossless', async () => {
  const a = memDb(), b = memDb();
  await importBackup(a, fixture('backup-v2'), { now });
  await importBackup(b, exportBackup(a), { now });
  const strip2 = x => ({ ...x, settings: { ...x.settings, adminPinHash: undefined } });
  assert.deepEqual(strip2(loadData(b)), strip2(loadData(a)));
  assert.equal(await verifyPin('4321', getSettings(b).adminPinHash), true);
});

test('invalid backup leaves existing data unchanged', async () => {
  const db = memDb();
  await importBackup(db, fixture('backup-v2'), { now });
  const bad = fixture('backup-v2'); bad.shifts[0].empId = 'ghost';
  await assert.rejects(importBackup(db, bad, { now }));
  assert.equal(listEmployees(db).length, 3);
});
