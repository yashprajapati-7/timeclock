import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeTestApp, loginAgent, fixture } from './helpers.js';
import { normalizeBackup } from '../src/backup.js';

test('import, backup round trip, PIN from backup, erase', async () => {
  const { app } = await makeTestApp();
  const a = await loginAgent(app);
  const imp = await a.post('/api/admin/import').send(fixture('backup-v2'));
  assert.equal(imp.status, 200);
  assert.equal(imp.body.employees, 3);
  assert.equal((await a.get('/api/admin/state')).body.shifts.length, 6);

  const bk = await a.get('/api/admin/backup');
  assert.match(bk.headers['content-disposition'], /attachment; filename="?timeclock_backup_\d{4}-\d{2}-\d{2}\.json"?/);
  const n = normalizeBackup(JSON.parse(bk.text));
  assert.equal(n.employees.length, 3);
  assert.equal(n.shifts.length, 6);

  const bad = await a.post('/api/admin/import').send({ employees: 'x' });
  assert.equal(bad.status, 422);
  assert.equal((await a.get('/api/admin/state')).body.employees.length, 3);

  // The importing session stays valid; a new login needs the backup's PIN.
  assert.equal((await request(app).post('/api/auth/login').send({ pin: '0000' })).status, 401);
  await loginAgent(app, '4321');

  assert.equal((await a.post('/api/admin/erase').send({})).status, 422);
  assert.equal((await a.post('/api/admin/erase').send({ confirm: 'ERASE' })).status, 200);
  const state = (await (await loginAgent(app)).get('/api/admin/state')).body;
  assert.equal(state.employees.length, 0);
  assert.equal(state.settings.defaultPin, true);
});

test('erase and import keep a pre-snapshot of the database', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { openDb, migrate } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pre-')), backupDir = path.join(dir, 'bk');
  const db = openDb(path.join(dir, 'tc.db')); migrate(db);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { app } = await makeTestApp({ db, backupDir });
  const a = await loginAgent(app);
  await a.post('/api/admin/employees').send({ name: 'Ann', pin: '1111', rate1: 20 });
  assert.equal((await a.post('/api/admin/erase').send({ confirm: 'ERASE' })).status, 200);
  const erase = fs.readdirSync(backupDir).filter(f => /^timeclock-pre-erase-\d{4}-\d{2}-\d{2}-\d{6}\.db$/.test(f));
  assert.equal(erase.length, 1);
  const copy = openDb(path.join(backupDir, erase[0]));
  assert.equal(copy.get('SELECT COUNT(*) n FROM employees').n, 1);
  copy.close();
  const b = await loginAgent(app);
  assert.equal((await b.post('/api/admin/import').send(fixture('backup-v2'))).status, 200);
  assert.ok(fs.readdirSync(backupDir).some(f => /^timeclock-pre-import-.*\.db$/.test(f)));
});
