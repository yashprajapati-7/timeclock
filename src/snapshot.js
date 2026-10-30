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
  db.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
  fs.renameSync(temp, target);
  return target;
}

export function prune(dir, keep){
  if(!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => SNAPSHOT.test(f)).sort().reverse();   // dated names sort chronologically
  for(const f of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
}
