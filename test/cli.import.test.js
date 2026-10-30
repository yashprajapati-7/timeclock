import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const run = (...a) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'scripts/import-backup.js'), ...a], { encoding: 'utf8' });

test('CLI imports, refuses non-empty db without --replace', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 't.db'), fx = path.join(ROOT, 'test/fixtures/backup-v2.json');
  const first = run(fx, '--db', db);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Imported 3 employees, 6 shifts, 2 adjustments, 2 audit entries/);
  const again = run(fx, '--db', db);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Database not empty, use --replace/);
  assert.equal(run(fx, '--db', db, '--replace').status, 0);
  assert.equal(run(path.join(dir, 'missing.json'), '--db', db).status, 1);
});
