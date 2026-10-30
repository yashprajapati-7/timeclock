import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { openDb, migrate } from '../src/db.js';
import { makeTestApp, loginAgent, fixture, fakeClock, d, binary } from './helpers.js';

const shiftRows = async a => {
  const x = await a.get('/api/admin/export/payroll.xlsx?week=2026-10-26').buffer(true).parse(binary);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  return wb.getWorksheet('Shifts').rowCount;
};

test('data persists across restart; exports include the new kiosk shift', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'timeclock.db');
  const open = () => { const db = openDb(file); migrate(db); return db; };
  const clock = fakeClock(d(2026, 10, 29, 8));

  let db = open();
  let { app } = await makeTestApp({ db, clock });
  let a = await loginAgent(app);
  await a.post('/api/admin/import').send(fixture('backup-v2'));
  const before = await shiftRows(a);

  // Kiosk day for Bob (code 2222)
  for(const [type, mins] of [['in', 0], ['bs', 240], ['be', 30], ['out', 240]]){
    clock.advance(mins * 60000);
    assert.equal((await request(app).post('/api/kiosk/punch').send({ pin: '2222', type })).status, 200, type);
  }
  a = await loginAgent(app, '4321');      // the 8-hour kiosk day outlasted the admin idle timeout
  await a.put('/api/admin/settings').send({ company: 'After Restart Co' });
  assert.equal(await shiftRows(a), before + 1);
  db.close();

  // "Restart": reopen the same file with a fresh app
  db = open();
  ({ app } = await makeTestApp({ db, clock }));
  a = await loginAgent(app, '4321');
  const s = (await a.get('/api/admin/state')).body;
  assert.equal(s.settings.company, 'After Restart Co');
  assert.equal(s.shifts.length, 7);
  assert.equal(s.employees.length, 3);
  db.close();
});
