import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { makeTestApp } from './helpers.js';
import { ROOT } from '../src/config.js';

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('serves the UI and shared modules', async () => {
  const { app } = await makeTestApp();
  const home = await request(app).get('/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes('<script type="module" src="/app.js">'));
  for(const p of ['/app.js', '/api.js', '/shared/pay.js', '/shared/format.js']){
    const r = await request(app).get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], /javascript/);
  }
  const unknown = await request(app).get('/api/unknown');
  assert.equal(unknown.status, 404);
  assert.deepEqual(Object.keys(unknown.body), ['error']);
});

test('shared modules have no DOM references', () => {
  for(const f of ['format.js', 'pay.js']) assert.doesNotMatch(read(`src/shared/${f}`), /\b(document|window|localStorage)\b/);
});

test('cwd independent', async (t) => {
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(os.tmpdir());
  const { app } = await makeTestApp();
  assert.equal((await request(app).get('/app.js')).status, 200);
});

test('root index.html untouched and not served', async () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'index.html')));
  const { app } = await makeTestApp();
  assert.ok((await request(app).get('/')).text.includes('type="module"'));
  assert.equal((await request(app).get('/index.html')).text, read('public/index.html'));
});

test('browser scripts parse', () => {
  for(const f of ['public/app.js', 'public/api.js']) execFileSync(process.execPath, ['--check', path.join(ROOT, f)]);
});

test('app.js is fully on the API', () => {
  const src = read('public/app.js');
  assert.doesNotMatch(src, /localStorage|crypto\.subtle|\bHash\./);
  for(const p of ['/api/admin/export/payroll.xlsx', '/api/admin/export/payroll.pdf', '/api/admin/export/payslips.pdf',
    '/api/admin/export/audit.csv', '/api/admin/backup', '/api/admin/import', '/api/admin/undo'])
    assert.ok(src.includes(p), p);
  // Idle auto-lock must end the server session too; only an already-expired session skips the logout call.
  assert.match(src, /Admin\.logout\('Admin session locked after inactivity'\)/);
  assert.match(src, /sessionGone: true/);
  const kiosk = src.slice(src.indexOf('// ---------- Kiosk'), src.indexOf('// ---------- Admin'));
  assert.ok(kiosk.length > 100);
  assert.doesNotMatch(kiosk, /\/api\/admin/);
});

test('PINs come from crypto randomness, not Math.random', () => {
  for(const f of ['src/roster-import.js', 'public/app.js'])
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /Math\.random/, f);
});

test('tests never write safety copies into the real data/backups folder', () => {
  assert.ok(!read('src/app.js').includes("backupDir = 'data/backups'"));
  assert.match(read('test/helpers.js'), /backupDir/);
});
