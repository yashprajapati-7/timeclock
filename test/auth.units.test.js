import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memDb } from './helpers.js';
import { createSession, touchSession, destroySession, purgeExpiredSessions, parseCookies } from '../src/auth/sessions.js';
import { createLockout } from '../src/auth/lockout.js';

const MINUTE = 60000;

test('session idle timeout; raw token never stored', () => {
  const db = memDb();
  const token = createSession(db, 0);
  assert.equal(db.all('SELECT * FROM sessions').some(r => r.token_hash === token), false);
  assert.ok(touchSession(db, token, 4 * MINUTE, 5));
  assert.ok(touchSession(db, token, 9 * MINUTE, 5));             // last_seen moved to 4 min
  assert.equal(touchSession(db, token, 14 * MINUTE + 1000, 5), null);
  assert.equal(db.get('SELECT COUNT(*) n FROM sessions').n, 0);
  assert.equal(touchSession(db, 'garbage', 0, 5), null);
});

test('destroy and purge', () => {
  const db = memDb();
  const a = createSession(db, 0), b = createSession(db, 0), c = createSession(db, 10 * MINUTE);
  destroySession(db, a);
  createSession(db, 0);
  purgeExpiredSessions(db, 11 * MINUTE, 5);
  assert.equal(db.get('SELECT COUNT(*) n FROM sessions').n, 1);
  assert.ok(touchSession(db, c, 11 * MINUTE, 5));
  assert.equal(touchSession(db, b, 11 * MINUTE, 5), null);
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; tc_admin=x%3Dy; bad'), { a: '1', tc_admin: 'x=y' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('lockout', () => {
  let now = 0;
  const L = createLockout({ max: 5, ms: 60000, clock: () => now });
  for(let i = 0; i < 3; i++) L.fail('ip');
  assert.deepEqual(L.fail('ip'), { locked: false, remaining: 1 });
  assert.deepEqual(L.fail('ip'), { locked: true, remaining: 0, retryAfterSec: 60 });
  assert.equal(L.check('ip').locked, true);
  now = 60001;
  assert.equal(L.check('ip').locked, false);
  assert.deepEqual(L.fail('ip'), { locked: false, remaining: 4 });
  L.reset('ip');
  assert.deepEqual(L.fail('ip'), { locked: false, remaining: 4 });
});
