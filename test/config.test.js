import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';

test('loadConfig returns defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.host, '127.0.0.1');
  assert.match(c.dbPath, /data[\\/]timeclock\.db$/);
  assert.equal(c.backupKeep, 14);
});

test('env overrides', () => {
  const c = loadConfig({ PORT: '4000', DB_PATH: ':memory:', BACKUP_KEEP: '3' });
  assert.equal(c.port, 4000);
  assert.equal(c.dbPath, ':memory:');
  assert.equal(c.backupKeep, 3);
});

test('paths independent of cwd', (t) => {
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(os.tmpdir());
  assert.ok(loadConfig({}).dbPath.startsWith(ROOT));
});

test('root index.html untouched', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'index.html')));
});
