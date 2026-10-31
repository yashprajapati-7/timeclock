import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate } from '../src/db.js';
import { migrations } from '../src/migrations.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('migrate creates all tables', () => {
  const db = fresh();
  const names = db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(r => r.name);
  for(const t of ['adjustments','audit','breaks','employees','sessions','settings','shifts']) assert.ok(names.includes(t), t);
  assert.equal(db.get('PRAGMA user_version').user_version, migrations.length);
});

test('migrate is idempotent', () => {
  const db = fresh();
  migrate(db);
  assert.equal(db.get('PRAGMA user_version').user_version, migrations.length);
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

test('migration 2 upgrades a v1 database with data', () => {
  const db = openDb(':memory:');
  migrate(db, migrations.slice(0, 1));
  db.run("INSERT INTO employees (id,name,pin,active,created_at) VALUES ('e1','Ann','1111',1,0)");
  db.run("INSERT INTO shifts (id,emp_id,clock_in,clock_out) VALUES ('s1','e1',1,2)");
  migrate(db);
  assert.equal(db.get('PRAGMA user_version').user_version, migrations.length);
  const e = db.get("SELECT * FROM employees WHERE id='e1'");
  assert.equal(e.pay_type, 'hourly');
  assert.equal(e.fixed_items, '[]');
  assert.equal(e.email, '');
  assert.equal(db.get("SELECT ot_ok FROM shifts WHERE id='s1'").ot_ok, 0);
  db.run("INSERT INTO roster (emp_id,day,type,start_hm,end_hm,position) VALUES ('e1','2026-10-26','CAFE','09:00','17:00',0)");
  assert.throws(() => db.run("INSERT INTO roster (emp_id,day,type,start_hm,end_hm,position) VALUES ('e1','2026-10-26','OFF','09:00','17:00',1)"));
  assert.throws(() => db.run("INSERT INTO roster (emp_id,day,type,start_hm,end_hm,position) VALUES ('e1','2026-10-26','CAFE',NULL,NULL,1)"));
  assert.throws(() => db.run("UPDATE employees SET pay_type='weekly' WHERE id='e1'"));
});

test('roster rows cascade when employee deleted', () => {
  const db = fresh();
  db.run("INSERT INTO employees (id,name,pin,active,created_at) VALUES ('e1','Ann','1111',1,0)");
  db.run("INSERT INTO roster (emp_id,day,type,position) VALUES ('e1','2026-10-26','OFF',0)");
  db.run("DELETE FROM employees WHERE id='e1'");
  assert.equal(db.get('SELECT COUNT(*) n FROM roster').n, 0);
});

test('a failing migration rolls back completely', () => {
  const db = openDb(':memory:');
  migrate(db, migrations.slice(0, 1));
  assert.throws(() => migrate(db, [migrations[0], 'CREATE TABLE half_done (x); SELECT * FROM no_such_table;']));
  assert.equal(db.get('PRAGMA user_version').user_version, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM sqlite_master WHERE name='half_done'").n, 0);
});

const tmpDb = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mig-'));
  const db = openDb(path.join(dir, 'x.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
};

test('fk-off migration: dangling foreign key aborts and rolls back', t => {
  const db = tmpDb(t);
  const list = [migrations[0], migrations[1], { foreignKeysOff: true, sql: "INSERT INTO shifts (id,emp_id,clock_in) VALUES ('bad','ghost',1)" }];
  assert.throws(() => migrate(db, list), /foreign key/i);
  assert.equal(db.get('PRAGMA user_version').user_version, 2);
  assert.equal(db.get("SELECT COUNT(*) n FROM shifts WHERE id='bad'").n, 0);
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
});

test('fk-off migration: SQL error rolls back and re-enables foreign keys', t => {
  const db = tmpDb(t);
  assert.throws(() => migrate(db, [migrations[0], { foreignKeysOff: true, sql: 'CREATE TABLE x(a); SELECT * FROM nope' }]));
  assert.equal(db.get("SELECT COUNT(*) n FROM sqlite_master WHERE name='x'").n, 0);
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(db.get('PRAGMA user_version').user_version, 1);
});

test('fk-off migration refuses to run inside a transaction', () => {
  const db = openDb(':memory:');
  assert.throws(() => db.tx(() => migrate(db, [migrations[0], { foreignKeysOff: true, sql: 'SELECT 1' }])), /foreign keys/i);
});

test('migration 3 rebuilds employees on a populated v2 file database', t => {
  const db = tmpDb(t);
  migrate(db, migrations.slice(0, 2));
  for(const [id, pin, pay, sal] of [['e1', '1111', 'hourly', null], ['e2', '2222', 'salary', 900], ['e3', '3333', 'hourly', null]])
    db.run('INSERT INTO employees (id,name,pin,active,created_at,pay_type,weekly_salary,rate1) VALUES (?,?,?,1,5,?,?,20)', [id, id.toUpperCase(), pin, pay, sal]);
  db.run("INSERT INTO shifts (id,emp_id,clock_in,clock_out) VALUES ('s1','e1',1,9)");
  db.run("INSERT INTO breaks (shift_id,start_at,end_at) VALUES ('s1',2,3),('s1',4,5)");
  db.run("INSERT INTO adjustments (week_start,emp_id,type,label,amount,position) VALUES ('2026-10-26','e1','allowance','x',5,0)");
  db.run("INSERT INTO roster (emp_id,day,type,position) VALUES ('e1','2026-10-26','OFF',0),('e2','2026-10-27','OFF',0)");
  db.run("INSERT INTO sessions (token_hash,created_at,last_seen) VALUES ('h',1,1)");
  const tables = ['employees', 'shifts', 'breaks', 'adjustments', 'roster', 'sessions'];
  const counts = () => tables.map(n => db.get(`SELECT COUNT(*) n FROM ${n}`).n);
  const before = counts(), rowids = db.all('SELECT rowid, id FROM employees ORDER BY rowid');
  migrate(db);
  assert.equal(db.get('PRAGMA user_version').user_version, migrations.length);
  assert.deepEqual(counts(), before);
  assert.deepEqual(db.all('SELECT rowid, id FROM employees ORDER BY rowid'), rowids);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok');
  for(const n of ['shifts', 'adjustments', 'roster'])
    assert.ok(db.get('SELECT sql FROM sqlite_master WHERE name = ?', n).sql.includes('REFERENCES employees(id)'), n);
  assert.deepEqual(db.all("SELECT name FROM sqlite_master WHERE sql LIKE '%employees_new%' OR sql LIKE '%employees_old%' OR name LIKE 'employees_%'"), []);
  assert.equal(db.get("SELECT weekly_salary FROM employees WHERE id='e2'").weekly_salary, 900);
  db.run("UPDATE employees SET pay_type='fixed' WHERE id='e1'");
  assert.throws(() => db.run("UPDATE employees SET pay_type='weekly' WHERE id='e1'"));
  assert.throws(() => db.run("DELETE FROM employees WHERE id='e1'"));          // RESTRICT (shifts)
  db.run("DELETE FROM employees WHERE id='e2'");                                // CASCADE (roster)
  assert.equal(db.get("SELECT COUNT(*) n FROM roster WHERE emp_id='e2'").n, 0);
  assert.throws(() => db.run("INSERT INTO employees (id,name,pin,active,created_at) VALUES ('e9','X','3333',1,0)"));   // UNIQUE pin
});

test('tx rejects a promise-returning callback and rolls back', () => {
  const db = fresh();
  assert.throws(() => db.tx(() => { db.run("INSERT INTO settings (key,value) VALUES ('a','1')"); return Promise.resolve(); }), /synchronous/);
  assert.equal(db.get('SELECT COUNT(*) n FROM settings').n, 0);
});
