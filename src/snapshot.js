// Daily database snapshots via VACUUM INTO (consistent even while the server is writing in WAL mode).
import fs from 'node:fs';
import path from 'node:path';
import { ymd } from './shared/format.js';

const SNAPSHOT = /^timeclock-\d{4}-\d{2}-\d{2}\.db$/;

export function snapshot(db, dir, now = Date.now()){
  if(!db.file || db.file === ':memory:') return null;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `timeclock-${ymd(now)}.db`);
  // VACUUM INTO refuses an existing file, so write to a temp name and rename over today's snapshot.
  const temp = `${target}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  db.raw.prepare('VACUUM INTO ?').run(temp);
  fs.renameSync(temp, target);
  return target;
}

// Safety copies before risky operations. Their names do not match SNAPSHOT, so prune() never removes them.
// Must run outside any transaction.
function safetyCopy(db, dir, name, now){
  if(!db.file || db.file === ':memory:') return null;
  const d = new Date(now), hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `timeclock-${name}-${ymd(now)}-${hms}.db`);
  if(fs.existsSync(target)) return target;
  db.raw.prepare('VACUUM INTO ?').run(target);
  return target;
}
// Before schema migrations: next to the database file (so it lands on the same volume).
export const snapshotBeforeMigrate = (db, now = Date.now()) =>
  safetyCopy(db, path.dirname(db.file || '.'), `premigrate-v${db.get('PRAGMA user_version').user_version}`, now);
// Before backup import / erase: timeclock-pre-<label>-YYYY-MM-DD-HHMMSS.db in the backup folder.
export const snapshotBefore = (db, dir, label, now = Date.now()) => safetyCopy(db, dir, `pre-${label}`, now);

export function prune(dir, keep){
  if(!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => SNAPSHOT.test(f)).sort().reverse();   // dated names sort chronologically
  for(const f of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
}
