import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { d, makeTestApp, loginAgent } from './helpers.js';

// Fake clock in helpers: Fri 30 Oct 2026 12:00 → "today" is 2026-10-30, week starts Mon 2026-10-26.
const setup = async () => {
  const x = await makeTestApp();
  const a = await loginAgent(x.app);
  const emp = (await a.post('/api/admin/employees').send({ name: 'Aka', pin: '1111', rate1: 20 })).body.id;
  const state = async () => (await a.get('/api/admin/state')).body;
  const put = (day, entries, extra = {}) => a.put(`/api/admin/roster/${emp}/${day}`).send({ entries, ...extra });
  return { ...x, a, emp, state, put };
};
const CAFE = [{ type: 'CAFE', start: '09:00', end: '17:00' }];

test('PUT cell, read back in state, undo restores', async () => {
  const { a, emp, state, put } = await setup();
  const r = await put('2026-11-02', CAFE);
  assert.equal(r.status, 200);
  assert.equal(r.body.repriced, 0);
  assert.deepEqual((await state()).roster[`2026-11-02|${emp}`].map(e => [e.type, e.start, e.end]), [['CAFE', '09:00', '17:00']]);
  await put('2026-11-02', [{ type: 'OFF' }]);
  assert.equal((await state()).undoLabel, 'Edit roster');
  await a.post('/api/admin/undo').type('json');
  assert.equal((await state()).roster[`2026-11-02|${emp}`][0].type, 'CAFE');
  const audit = (await a.get('/api/admin/audit?q=edit roster')).body;
  assert.match(audit.at(-1).detail, /Aka · .*: CAFE 09:00–17:00$/);
});

test('validation and auth on roster cells', async () => {
  const { app, put, a } = await setup();
  assert.equal((await a.put('/api/admin/roster/nope/2026-11-02').send({ entries: CAFE })).status, 404);
  assert.equal((await put('2026-13-01', CAFE)).status, 422);
  assert.equal((await put('2026-11-02', [{ type: 'CAFE', start: '9', end: '17' }])).status, 422);
  assert.equal((await request(app).put('/api/admin/roster/x/2026-11-02').send({ entries: [] })).status, 401);
});

test('past-day edit reports the re-priced shift; dry run writes nothing', async () => {
  const { a, emp, state, put } = await setup();
  await a.put('/api/admin/settings').send({ roundFrom: '2026-10-26' });
  await a.post('/api/admin/shifts').send({ empId: emp, in: d(2026, 10, 29, 9, 8), out: d(2026, 10, 29, 17), breaks: [] });
  const dry = await put('2026-10-29', CAFE, { dryRun: true });
  assert.deepEqual(dry.body, { repriced: 1, dryRun: true });
  assert.equal((await state()).roster[`2026-10-29|${emp}`], undefined);
  const real = await put('2026-10-29', CAFE);
  assert.equal(real.body.repriced, 1);
  const audit = (await a.get('/api/admin/audit?q=edit roster')).body[0];
  assert.match(audit.detail, /\(past: re-prices 1 shifts\)$/);
  const future = await put('2026-11-03', CAFE);
  assert.equal(future.body.repriced, 0);
  assert.doesNotMatch((await a.get('/api/admin/audit?q=edit roster')).body[0].detail, /past/);
});

test('copy-week copies only filled cells and is undoable; clear-week removes that week only', async () => {
  const { a, emp, state, put } = await setup();
  await put('2026-10-26', CAFE);
  await put('2026-11-03', [{ type: 'OFF' }]);            // target Tue has its own entry; source Tue is empty
  const c = await a.post('/api/admin/roster/copy-week').send({ week: '2026-10-26' });
  assert.equal(c.status, 200);
  assert.equal(c.body.copied, 1);
  let r = (await state()).roster;
  assert.equal(r[`2026-11-02|${emp}`][0].type, 'CAFE');
  assert.equal(r[`2026-11-03|${emp}`][0].type, 'OFF');
  await a.post('/api/admin/undo').type('json');
  assert.equal((await state()).roster[`2026-11-02|${emp}`], undefined);
  assert.equal((await a.post('/api/admin/roster/copy-week').send({ week: '2026-10-27' })).status, 422);
  const cl = await a.post('/api/admin/roster/clear-week').send({ week: '2026-11-02' });
  assert.equal(cl.body.cleared, 1);
  r = (await state()).roster;
  assert.equal(r[`2026-11-03|${emp}`], undefined);
  assert.equal(r[`2026-10-26|${emp}`][0].type, 'CAFE');
});

test('clear-week with a rounded past shift reports repriced; dry run writes nothing', async () => {
  const { a, emp, state, put } = await setup();
  await a.put('/api/admin/settings').send({ roundFrom: '2026-10-26' });
  await put('2026-10-27', CAFE);
  await a.post('/api/admin/shifts').send({ empId: emp, in: d(2026, 10, 27, 9, 8), out: d(2026, 10, 27, 17), breaks: [] });
  const dry = await a.post('/api/admin/roster/clear-week').send({ week: '2026-10-26', dryRun: true });
  assert.deepEqual(dry.body, { repriced: 1, dryRun: true });
  assert.ok((await state()).roster[`2026-10-27|${emp}`]);
});

const sample = () => JSON.parse(JSON.stringify(fixtureRoster));
import { fixture } from './helpers.js';
const fixtureRoster = fixture('roster-sample');
const okFetch = (calls = []) => async (url, init) => {
  calls.push({ url, init });
  return new Response(JSON.stringify(sample()), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('import dry-run uses the configured URL safely and changes nothing', async () => {
  const calls = [];
  const x = await makeTestApp({ fetch: okFetch(calls) });
  const a = await loginAgent(x.app);
  const r = await a.post('/api/admin/roster/import').send({ dryRun: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.toCreate.length, 3);
  assert.equal(r.body.offsetDays, 1);
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal);
  assert.match(calls[0].url, /roster-production-3522\.up\.railway\.app\/api\/roster$/);
  assert.equal((await a.get('/api/admin/state')).body.employees.length, 0);
});

test('import applies, returns codes once, remembers mapping; undo removes it', async () => {
  const x = await makeTestApp({ fetch: okFetch() });
  const a = await loginAgent(x.app);
  const r = await a.post('/api/admin/roster/import').send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.created.length, 3);
  assert.ok(r.body.created.every(c => /^\d{4}$/.test(c.pin) && c.pin !== '0000'));
  const s = (await a.get('/api/admin/state')).body;
  assert.equal(s.employees.length, 3);
  assert.ok(Object.keys(s.roster).length >= 9);
  assert.match((await a.get('/api/admin/audit?q=import roster')).body[0].detail, /9 cells, 3 new staff/);
  await a.post('/api/admin/undo').type('json');
  const after = (await a.get('/api/admin/state')).body;
  assert.equal(after.employees.length, 0);
  assert.deepEqual(after.roster, {});
});

test('uploaded data is used without fetching', async () => {
  let fetched = false;
  const x = await makeTestApp({ fetch: async () => { fetched = true; throw new Error('no'); } });
  const a = await loginAgent(x.app);
  const r = await a.post('/api/admin/roster/import').send({ dryRun: true, data: sample() });
  assert.equal(r.status, 200);
  assert.equal(fetched, false);
});

test('502 when the old roster app is unreachable, errors, or sends too much', async () => {
  const cases = [
    async () => { throw new TypeError('fetch failed'); },
    async () => new Response('nope', { status: 500 }),
    async () => new Response('x'.repeat(5 * 1024 * 1024 + 10), { status: 200 }),
  ];
  for(const f of cases){
    const x = await makeTestApp({ fetch: f });
    const a = await loginAgent(x.app);
    const r = await a.post('/api/admin/roster/import').send({ dryRun: true });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /old roster app|too large/);
  }
});
