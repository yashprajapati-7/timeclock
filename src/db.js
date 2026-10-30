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

export function migrate(db){
  const current = db.get('PRAGMA user_version').user_version;
  for(let v = current; v < migrations.length; v++){
    db.tx(() => {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
