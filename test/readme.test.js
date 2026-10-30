import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

test('README covers setup, migration, data safety and operations', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for(const s of ['npm install', 'npm start', 'npm run import', 'npm test', '0000', 'same `index.html`', 'only then delete',
    '-wal', 'data/backups', 'Task Scheduler', 'HOST=0.0.0.0', 'BACKUP_KEEP'])
    assert.ok(md.toLowerCase().includes(s.toLowerCase()), `README should mention: ${s}`);
  assert.doesNotMatch(md, /export (your backup )?from `?legacy\//i);
});

test('README documents roster, rounding, Brevo email and timezone', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for(const s of ['BREVO_API_KEY', 'MAIL_FROM', 'Authorised IPs', 'TZ=Australia/Sydney', 'ROSTER_IMPORT_URL', '±6', 'Rounding starts', 'Fair Work', 'Import old roster'])
    assert.ok(md.includes(s), `README should mention: ${s}`);
  assert.ok(!md.includes('SMTP_HOST'));
});
