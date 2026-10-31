// Admin sessions: the client holds a random token, the DB only its SHA-256.
import { randomBytes, createHash } from 'node:crypto';

export const COOKIE = 'tc_admin';
export const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');

export function createSession(db, now){
  const token = randomBytes(32).toString('base64url');
  db.run('INSERT INTO sessions (token_hash, created_at, last_seen) VALUES (?, ?, ?)', [tokenHash(token), now, now]);
  return token;
}

// Returns the session key (token hash) if still valid and refreshes last_seen; expired rows are deleted.
export function touchSession(db, token, now, timeoutMin){
  if(!token) return null;
  const key = tokenHash(token), row = db.get('SELECT last_seen FROM sessions WHERE token_hash = ?', key);
  if(!row) return null;
  if(now - row.last_seen > timeoutMin * 60000){ db.run('DELETE FROM sessions WHERE token_hash = ?', key); return null; }
  db.run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', [now, key]);
  return key;
}

export const destroySession = (db, token) => db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
export const destroyAllSessions = (db, { except } = {}) =>
  except ? db.run('DELETE FROM sessions WHERE token_hash <> ?', except) : db.run('DELETE FROM sessions');
export const purgeExpiredSessions = (db, now, timeoutMin) => db.run('DELETE FROM sessions WHERE last_seen < ?', now - timeoutMin * 60000);

export function parseCookies(header){
  const out = {};
  for(const part of String(header ?? '').split(';')){
    const i = part.indexOf('=');
    if(i < 1) continue;
    try{ out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }catch{ /* ignore malformed */ }
  }
  return out;
}
