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

test('v3 round trip keeps roster, fixed items, salary, otApproved, rounding settings and import mapping', async () => {
  const a = memDb(), b = memDb();
  await importBackup(a, fixture('backup-v2'), { now });
  const { createEmployee, replaceRosterCell, saveShift, setSettings, getShift } = await import('../src/repo.js');
  createEmployee(a, { id: 's9', name: 'Sal', pin: '9999', active: true, payType: 'salary', weeklySalary: 800, email: 's@x.co',
    birthday: '1990-01-01', fixedItems: [{ type: 'allowance', label: 'Phone', amount: 10, from: '2026-10-26', to: null }] }, 9);
  replaceRosterCell(a, 'e1', '2026-10-27', [{ type: 'CAFE', start: '09:00', end: '15:00' }, { type: 'OFF' }]);
  saveShift(a, { ...getShift(a, 's2'), otApproved: true });
  setSettings(a, { roundFrom: '2026-10-26', rosterImport: { offsetDays: 1, idMap: { 1: 'e1' } } });
  const exported = exportBackup(a);
  assert.equal(exported.v, 3);
  await importBackup(b, JSON.parse(JSON.stringify(exported)), { now });
  const strip = x => ({ ...x, settings: { ...x.settings, adminPinHash: undefined } });
  assert.deepEqual(strip(loadData(b)), strip(loadData(a)));
  assert.deepEqual(getSettings(b).rosterImport, { offsetDays: 1, idMap: { 1: 'e1' } });
  assert.deepEqual(week(loadData(b), ws, now).map(r => r.net), week(loadData(a), ws, now).map(r => r.net));
});

test('older backups import with no roster and rounding not in effect', async () => {
  const db = memDb();
  await importBackup(db, fixture('backup-v2'), { now });
  assert.deepEqual(loadData(db).roster, {});
  assert.equal(getSettings(db).roundFrom, null);
});

test('fixed pay type survives a backup round trip and pays rate1 for every hour', async () => {
  const { createEmployee, saveShift } = await import('../src/repo.js');
  const src = memDb();
  createEmployee(src, { id: 'f1', name: 'Fi', pin: '5555', rate1: 25, rate2: 99, payType: 'fixed', active: true }, 0);
  for(let i = 0; i < 4; i++) saveShift(src, { id: `s${i}`, empId: 'f1', in: d(2026, 10, 26 + i, 8), out: d(2026, 10, 26 + i, 16), breaks: [] });
  const dst = memDb();
  await importBackup(dst, JSON.parse(JSON.stringify(exportBackup(src))));
  assert.equal(listEmployees(dst)[0].payType, 'fixed');
  const [r] = week(loadData(dst), new Date(d(2026, 10, 26)));
  assert.ok(r.paid > 24);
  assert.ok(Math.abs(r.gross - r.paid * 25) < 1e-9);
});
