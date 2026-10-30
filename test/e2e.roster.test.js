// End-to-end: roster import → salaried + hourly staff → late kiosk punch → report/xlsx → email all → backup round trip → undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { openDb, migrate } from '../src/db.js';
import { createMailer } from '../src/mail.js';
import { makeTestApp, loginAgent, fixture, fakeClock, d, binary } from './helpers.js';

test('roster to payslip, end to end on a file database', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-e2e2-'));
  const db = openDb(path.join(dir, 'tc.db')); migrate(db);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const sent = [];
  const mailer = createMailer({ BREVO_API_KEY: 'k', MAIL_FROM: 'pay@shop.com' },
    { fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{"messageId":"m"}', { status: 201 }); } });
  const roster = fixture('roster-sample');
  roster.shifts['2026-10-29_2'] = [{ type: 'shift', category: 'CAFE', start: '09:00', end: '17:00' }];   // Him: Fri 30 Oct 9–5
  const clock = fakeClock(d(2026, 10, 30, 8));
  const { app } = await makeTestApp({ db, clock, mailer, fetch: async () => new Response(JSON.stringify(roster)) });
  const a = await loginAgent(app);

  // 1. Import the old roster (creates Him and MISHILA, matches nobody else).
  const imp = (await a.post('/api/admin/roster/import').send({})).body;
  const him = imp.created.find(c => c.name === 'Him');
  assert.ok(him);
  let s = (await a.get('/api/admin/state')).body;
  const himEmp = s.employees.find(e => e.name === 'Him'), mish = s.employees.find(e => e.name === 'MISHILA');
  assert.deepEqual(s.roster[`2026-10-30|${himEmp.id}`].map(e => [e.type, e.start]), [['CAFE', '09:00']]);

  // 2. Him hourly with email; MISHILA salaried with a fixed allowance. Rounding from this week.
  await a.put(`/api/admin/employees/${himEmp.id}`).send({ ...himEmp, rate1: 20, rate2: 30, email: 'him@x.co' });
  await a.put(`/api/admin/employees/${mish.id}`).send({ ...mish, payType: 'salary', weeklySalary: 700, email: 'm@x.co',
    fixedItems: [{ type: 'allowance', label: 'Phone', amount: 10, from: '2026-10-26' }] });
  await a.put('/api/admin/settings').send({ roundFrom: '2026-10-26' });

  // 3. Him clocks in at 9:08 (late) and out at 17:20 on the kiosk.
  clock.t = d(2026, 10, 30, 9, 8);
  const pin = him.pin;
  assert.equal((await request(app).post('/api/kiosk/punch').send({ pin, type: 'in' })).body.calc.paidIn, d(2026, 10, 30, 9, 15));
  clock.t = d(2026, 10, 30, 17, 20);
  await request(app).post('/api/kiosk/punch').send({ pin, type: 'out' });

  // 4. Report data and Excel: paid 9:15–17:00, late once; salary + allowance for MISHILA.
  const a2 = await loginAgent(app);       // the 9-hour kiosk day outlasted the admin session
  const x = await a2.get('/api/admin/export/payroll.xlsx?week=2026-10-26').buffer(true).parse(binary);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
  const sh = wb.getWorksheet('Shifts'), head = sh.getRow(1).values.slice(1);
  const himRow = [...Array(sh.rowCount - 1)].map((_, i) => sh.getRow(i + 2)).find(r => r.getCell(1).value === 'Him');
  assert.equal(himRow.getCell(head.indexOf('Paid in') + 1).value, '09:15');
  assert.equal(himRow.getCell(head.indexOf('Paid out') + 1).value, '17:00');
  assert.equal(himRow.getCell(head.indexOf('Late min') + 1).value, 8);
  const pay = wb.getWorksheet('Payroll');
  const mRow = pay.getRows(3, pay.rowCount - 3).find(r => r.getCell(1).value === 'MISHILA');
  const H = (await import('../src/reports/xlsx.js')).PAYROLL_HEADER(24);
  assert.equal(mRow.getCell(H.indexOf('Salary') + 1).value, 700);
  assert.equal(mRow.getCell(H.indexOf('Net pay') + 1).value, 710);

  // 5. Email all payslips (fake Brevo) → two sends, AKA-style staff without email skipped.
  const mail = (await a2.post('/api/admin/payslips/email').send({ week: '2026-10-26', emp: 'all' })).body;
  assert.equal(mail.results.filter(r => r.status === 'sent').length, 2);
  assert.equal(sent.length, 2);

  // 6. Backup round trip keeps roster, salary, fixed items and rounding.
  const backup = JSON.parse((await a2.get('/api/admin/backup')).text);
  assert.equal(backup.v, 3);
  await a2.post('/api/admin/import').send(backup);
  s = (await a2.get('/api/admin/state')).body;
  assert.equal(s.settings.roundFrom, '2026-10-26');
  assert.equal(s.employees.find(e => e.name === 'MISHILA').fixedItems[0].label, 'Phone');
  assert.equal(Object.keys(s.roster).length, Object.keys(backup.roster).length);

  // 7. Undo the last roster edit.
  const key = `2026-11-02|${himEmp.id}`;
  await a2.put(`/api/admin/roster/${himEmp.id}/2026-11-02`).send({ entries: [{ type: 'OFF' }] });
  assert.ok((await a2.get('/api/admin/state')).body.roster[key]);
  await a2.post('/api/admin/undo').type('json');
  assert.equal((await a2.get('/api/admin/state')).body.roster[key], undefined);
});
