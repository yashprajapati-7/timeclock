import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, ValidationError } from '../src/errors.js';

test('HttpError', () => {
  const e = new HttpError(409, 'x');
  assert.ok(e instanceof Error);
  assert.equal(e.status, 409);
  assert.equal(e.message, 'x');
  assert.equal(e.name, 'HttpError');
});

test('ValidationError', () => {
  const e = new ValidationError('bad', ['a']);
  assert.equal(e.status, 422);
  assert.deepEqual(e.details, ['a']);
  assert.equal(e.name, 'ValidationError');
});
