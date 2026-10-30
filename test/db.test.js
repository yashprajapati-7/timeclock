import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate } from '../src/db.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('migrate creates all tables', () => {
  const db = fresh();
  const names = db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(r => r.name);
  for(const t of ['adjustments','audit','breaks','employees','sessions','settings','shifts']) assert.ok(names.includes(t), t);
  assert.equal(db.get('PRAGMA user_version').user_version, 1);
});

test('migrate is idempotent', () => {
  const db = fresh();
  migrate(db);
  assert.equal(db.get('PRAGMA user_version').user_version, 1);
});

test('foreign keys on', () => {
  const db = fresh();
  db.run("INSERT INTO employees (id,name,pin,active,created_at) VALUES ('e1','A','1111',1,0)");
  db.run("INSERT INTO shifts (id,emp_id,clock_in) VALUES ('s1','e1',1)");
  db.run("INSERT INTO breaks (shift_id,start_at) VALUES ('s1',2)");
  db.run("DELETE FROM shifts WHERE id='s1'");
  assert.equal(db.get('SELECT COUNT(*) n FROM breaks').n, 0);
  assert.throws(() => db.run("INSERT INTO shifts (id,emp_id,clock_in) VALUES ('s2','nope',1)"));
});

test('tx rolls back on throw, nested savepoints', () => {
  const db = fresh();
  assert.throws(() => db.tx(() => {
    db.run("INSERT INTO settings (key,value) VALUES ('a','1')");
    throw new Error('boom');
  }));
  assert.equal(db.get('SELECT COUNT(*) n FROM settings').n, 0);
  db.tx(() => {
    db.run("INSERT INTO settings (key,value) VALUES ('b','1')");
    try { db.tx(() => { db.run("INSERT INTO settings (key,value) VALUES ('c','1')"); throw new Error('inner'); }); } catch {}
  });
  assert.deepEqual(db.all('SELECT key FROM settings').map(r => r.key), ['b']);
});

test('opens file db in a new dir', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  const file = path.join(dir, 'sub', 'x.db');
  const db = openDb(file); migrate(db);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.ok(fs.existsSync(file));
  assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');
});
