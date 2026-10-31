import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { d, memDb } from './helpers.js';
import { openDb, migrate } from '../src/db.js';
import { createEmployee } from '../src/repo.js';
import { snapshot, prune } from '../src/snapshot.js';
import { migrations } from '../src/migrations.js';

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-snap-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('snapshot opens and migrates cleanly; same day overwrites', (t) => {
  const dir = tmp(t);
  const db = openDb(path.join(dir, 'live.db')); migrate(db);
  createEmployee(db, { id: 'e1', name: 'Ann', pin: '1111', active: true }, 0);
  const out = path.join(dir, 'backups');
  const file = snapshot(db, out, d(2026, 10, 30, 9));
  assert.equal(path.basename(file), 'timeclock-2026-10-30.db');
  const copy = openDb(file); migrate(copy);
  assert.equal(copy.get('SELECT COUNT(*) n FROM employees').n, 1);
  assert.equal(copy.get('PRAGMA user_version').user_version, migrations.length);
  copy.close();
  snapshot(db, out, d(2026, 10, 30, 18));
  assert.deepEqual(fs.readdirSync(out).filter(f => f.endsWith('.db')), ['timeclock-2026-10-30.db']);
  db.close();   // Windows: close before the temp dir is removed
});

test('prune keeps the newest N dated files and leaves others alone', (t) => {
  const dir = tmp(t);
  for(let i = 1; i <= 16; i++) fs.writeFileSync(path.join(dir, `timeclock-2026-10-${String(i).padStart(2, '0')}.db`), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  prune(dir, 14);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 15);
  assert.ok(left.includes('notes.txt'));
  assert.ok(!left.includes('timeclock-2026-10-01.db'));
  assert.ok(!left.includes('timeclock-2026-10-02.db'));
});

test('memory db → null', () => {
  assert.equal(snapshot(memDb(), os.tmpdir(), Date.now()), null);
});

test('pre-migration snapshot is taken next to the DB and never pruned', async (t) => {
  const { snapshotBeforeMigrate } = await import('../src/snapshot.js');
  const { pendingMigrations } = await import('../src/db.js');
  const dir = tmp(t);
  const db = openDb(path.join(dir, 'live.db'));
  migrate(db, migrations.slice(0, 1));
  assert.equal(pendingMigrations(db), migrations.length - 1);
  const file = snapshotBeforeMigrate(db, d(2026, 10, 30, 9, 15));
  assert.equal(path.dirname(file), dir);
  assert.match(path.basename(file), /^timeclock-premigrate-v1-2026-10-30-091500\.db$/);
  assert.ok(fs.existsSync(file));
  prune(dir, 0);
  assert.ok(fs.existsSync(file));
  db.close();
});

test('snapshot into a folder with a quote in its name', t => {
  const base = tmp(t), dir = path.join(base, "O'Brien");
  const db = openDb(path.join(base, 'tc.db')); migrate(db);
  try{ assert.ok(fs.existsSync(snapshot(db, dir, d(2026, 10, 31)))); }
  finally{ db.close(); }
});
