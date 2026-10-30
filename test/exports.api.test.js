import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { makeTestApp, loginAgent, fixture, binary } from './helpers.js';
import { addAudit, listAudit } from '../src/repo.js';

const PATHS = ['/api/admin/export/payroll.xlsx', '/api/admin/export/payroll.pdf', '/api/admin/export/payslips.pdf', '/api/admin/export/audit.csv'];

test('exports need a session', async () => {
  const { app } = await makeTestApp();
  for(const p of PATHS) assert.equal((await request(app).get(p)).status, 401, p);
});

test('xlsx, pdf, payslips and audit csv downloads', async () => {
  const { app, db } = await makeTestApp();
  const a = await loginAgent(app);
  await a.post('/api/admin/import').send(fixture('backup-v2'));

  const x = await a.get('/api/admin/export/payroll.xlsx?week=2026-10-28').buffer(true).parse(binary);
  assert.equal(x.status, 200);
  assert.equal(x.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(x.headers['content-disposition'], /payroll_2026-10-26\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  assert.equal(wb.worksheets.length, 3);

  const p = await a.get('/api/admin/export/payroll.pdf?week=2026-10-26').buffer(true).parse(binary);
  assert.equal(p.status, 200);
  assert.equal(p.headers['content-type'], 'application/pdf');
  assert.equal(p.body.subarray(0, 5).toString(), '%PDF-');

  const one = await a.get('/api/admin/export/payslips.pdf?week=2026-10-26&emp=e1').buffer(true).parse(binary);
  assert.equal(one.status, 200);
  assert.match(one.headers['content-disposition'], /payslip_alice-smith_2026-10-26\.pdf/);
  assert.equal((await a.get('/api/admin/export/payslips.pdf?week=2026-10-26&emp=ghost')).status, 404);

  const bad = await a.get('/api/admin/export/payroll.pdf?week=bad');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /week/);

  addAudit(db, { ts: 1, actor: 'Admin', action: 'Test', detail: '=cmd()' });
  const count = listAudit(db).length;
  const csv = await a.get('/api/admin/export/audit.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(csv.text.startsWith('﻿"Timestamp","Who","Action","Detail"'));
  assert.equal(csv.text.split('\r\n').length, count + 1);
  assert.ok(csv.text.includes(`"'=cmd()"`));
});
