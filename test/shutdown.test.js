import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gracefulShutdown } from '../src/shutdown.js';

test('forces exit when close hangs', async () => {
  const codes = [];
  gracefulShutdown({ server: { close(){} }, db: { close(){} }, exit: c => codes.push(c), timeoutMs: 20 })();
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(codes, [1]);
});

test('clean close exits 0 and closes the database', () => {
  const codes = [];
  let closed = false;
  gracefulShutdown({ server: { close: cb => cb() }, db: { close(){ closed = true; } }, exit: c => codes.push(c), timeoutMs: 1000 })();
  assert.deepEqual([closed, codes], [true, [0]]);
});

test('a second signal does nothing', () => {
  const codes = [];
  let closes = 0;
  const stop = gracefulShutdown({ server: { close: cb => cb() }, db: { close(){ closes++; } }, exit: c => codes.push(c), timeoutMs: 1000 });
  stop(); stop();
  assert.deepEqual([closes, codes], [1, [0]]);
});
