// The only module that talks to node:sqlite. Swapping drivers means changing this file only.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.js';

// node:sqlite rows have a null prototype; spread them into plain objects.
const plain = r => r ? { ...r } : r;
const args = p => p == null ? [] : Array.isArray(p) ? p : [p];

export function openDb(file){
  if(file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if(file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  let depth = 0, sp = 0;
  const db = {
    raw, file,
    get: (sql, p) => plain(raw.prepare(sql).get(...args(p))),
    all: (sql, p) => raw.prepare(sql).all(...args(p)).map(plain),
    run: (sql, p) => raw.prepare(sql).run(...args(p)),
    exec: sql => raw.exec(sql),
    // Transaction; nested calls use savepoints so repo functions compose.
    tx(fn){
      const name = depth ? `sp${++sp}` : null;
      raw.exec(name ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
      depth++;
      try{
        const result = fn();
        if(result && typeof result.then === 'function') throw new TypeError('db.tx callback must be synchronous');
        raw.exec(name ? `RELEASE ${name}` : 'COMMIT');
        return result;
      }catch(e){
        raw.exec(name ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
        throw e;
      }finally{ depth--; }
    },
    close: () => raw.close(),
  };
  return db;
}

export const pendingMigrations = (db, list = migrations) => Math.max(0, list.length - db.get('PRAGMA user_version').user_version);

// Each migration runs in its own transaction (db.tx rolls back on any failing statement).
// A migration may be { foreignKeysOff: true, sql } for SQLite table rebuilds: foreign keys are switched off
// BEFORE the transaction (the pragma is a no-op inside one), checked with foreign_key_check before commit,
// and always switched back on.
export function migrate(db, list = migrations){
  const current = db.get('PRAGMA user_version').user_version;
  for(let v = current; v < list.length; v++){
    const m = list[v], sql = m.sql ?? m, step = () => db.tx(() => {
      db.exec(sql);
      if(m.foreignKeysOff){
        const bad = db.all('PRAGMA foreign_key_check');
        if(bad.length) throw new Error(`Migration ${v + 1} broke a foreign key (${bad[0].table} row ${bad[0].rowid})`);
      }
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
    if(!m.foreignKeysOff){ step(); continue; }
    db.exec('PRAGMA foreign_keys = OFF');
    try{
      if(db.get('PRAGMA foreign_keys').foreign_keys !== 0) throw new Error('Cannot switch foreign keys off (migration run inside a transaction?)');
      step();
    }finally{ db.exec('PRAGMA foreign_keys = ON'); }
  }
}
