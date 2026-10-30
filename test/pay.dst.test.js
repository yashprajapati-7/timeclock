// Sydney DST: run in a child with TZ set so the wall-clock maths is really exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const run = code => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code],
  { env: { ...process.env, TZ: 'Australia/Sydney' }, cwd: new URL('..', import.meta.url) }).toString());

test('roster spans, rounding and paid time across Sydney DST changes', () => {
  const r = run(`
    import { rosterSpan } from './src/shared/pay.js';
    import { ceilStep, floorStep } from './src/shared/format.js';
    const H = 3600e3, e = { type: 'CAFE', start: '22:00', end: '07:00' };
    const fwd = rosterSpan(e, '2026-10-03'), back = rosterSpan(e, '2026-04-04');
    const second0220 = new Date('2026-04-05T02:20:00+10:00').getTime();
    console.log(JSON.stringify({ fwd: (fwd.E - fwd.S) / H, back: (back.E - back.S) / H,
      ceilOk: ceilStep(second0220, 15) >= second0220, floorOk: floorStep(second0220, 15) <= second0220,
      ceilDiff: (ceilStep(second0220, 15) - second0220) / 60000, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }));`);
  assert.equal(r.tz, 'Australia/Sydney');
  assert.equal(r.fwd, 8);        // 22:00 → 07:00 loses an hour when clocks go forward
  assert.equal(r.back, 10);      // and gains one when they go back
  assert.ok(r.ceilOk && r.floorOk);
  assert.equal(r.ceilDiff, 10);
});
