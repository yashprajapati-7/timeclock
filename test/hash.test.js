import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashPin, verifyPin, needsRehash, fnv1a } from '../src/auth/hash.js';

test('scrypt hash + verify', async () => {
  const h = await hashPin('0000');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPin('0000', h), true);
  assert.equal(await verifyPin('0001', h), false);
  assert.notEqual(h, await hashPin('0000'));
});

test('legacy sha256 and fnv', async () => {
  const salt = 'abc';
  const sha = `${salt}|sha256:` + createHash('sha256').update(`${salt}:4321`).digest('hex');
  assert.equal(await verifyPin('4321', sha), true);
  assert.equal(await verifyPin('4320', sha), false);
  assert.equal(fnv1a('abc:4321'), 'fnv:f180bc63');
  assert.equal(await verifyPin('4321', 'abc|fnv:f180bc63'), true);
});

test('malformed input → false', async () => {
  assert.equal(await verifyPin('1', 'abc'), false);
  assert.equal(await verifyPin('1', ''), false);
  assert.equal(await verifyPin('1', 'scrypt$1$2'), false);
  assert.equal(needsRehash('scrypt$16384$8$1$a$b'), false);
  assert.equal(needsRehash('x|sha256:00'), true);
});
