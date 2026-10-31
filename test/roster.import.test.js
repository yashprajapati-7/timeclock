import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d, memDb, fixture } from './helpers.js';
import * as R from '../src/repo.js';
import { planImport, applyImport, offsetWarning } from '../src/roster-import.js';

const NOW = d(2026, 10, 30, 12);                     // Fri; days up to Thu 29 Oct are in the past
const ctxOf = db => ({ ...R.loadData(db), now: NOW });
const seq = () => { let n = 1000; return () => String(n++); };   // deterministic pin generator
const seed = () => {
  const db = memDb();
  R.createEmployee(db, { id: 'aka', name: 'Aka', pin: '1111', active: true }, 0);
  return db;
};
const apply = (db, plan, pinGen = seq()) => db.tx(() => applyImport(db, plan, { now: NOW, pinGen, touch: () => {} }));

test('default offset +1 moves the old app\'s Sunday-keyed days to the real Monday', () => {
  const db = seed();
  const plan = planImport(fixture('roster-sample'), ctxOf(db));
  assert.equal(plan.offsetDays, 1);
  assert.equal(plan.firstDay, '2026-10-26');
  const cell = plan.cells.find(c => c.empId === 'aka' && c.day === '2026-10-26');
  assert.deepEqual(cell.entries, [{ type: 'CAFE', start: '09:00', end: '17:00' }]);
  assert.match(plan.sample[0], /^Mon, 26 Oct · Aka · CAFE 09:00–17:00$|^Mon 26 Oct · Aka · CAFE 09:00–17:00$/);
  assert.equal(plan.warning, undefined);
});

test('override offset 0 is used and persisted', () => {
  const db = seed();
  const plan = planImport(fixture('roster-sample'), ctxOf(db), { offsetDays: 0 });
  assert.equal(plan.firstDay, '2026-10-25');
  apply(db, plan);
  assert.equal(R.getSettings(db).rosterImport.offsetDays, 0);
  assert.equal(planImport(fixture('roster-sample'), ctxOf(db)).offsetDays, 0);
});

test('warning when keys look Monday-aligned but offset is +1', () => {
  assert.match(offsetWarning(['2026-10-26_1', '2026-11-01_1'], 1), /Monday/);
  assert.equal(offsetWarning(['2026-10-25_1', '2026-10-31_1'], 1), undefined);
});

test('names match case-insensitively; missing staff are planned for creation; bad entries skipped', () => {
  const plan = planImport(fixture('roster-sample'), ctxOf(seed()));
  assert.deepEqual(plan.matched.map(m => [m.srcName, m.empId]), [['AKA', 'aka']]);
  assert.deepEqual(plan.toCreate.map(c => [c.name, c.role]), [['Him', 'Delivery Driver'], ['MISHILA', 'Training']]);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /HH:MM/);
  assert.equal(plan.cells.length, 9);
  assert.equal(plan.changedCells, 9);
});

test('apply creates staff with unique non-0000 codes, writes the roster and is idempotent', () => {
  const db = seed();
  const pins = ['0000', '1111', '2345', '2345', '3456'];
  const res = apply(db, planImport(fixture('roster-sample'), ctxOf(db)), () => pins.shift());
  assert.deepEqual(res.created.map(c => c.pin), ['2345', '3456']);
  assert.equal(R.listEmployees(db).length, 3);
  assert.equal(R.listRoster(db)['2026-10-27|aka'].length, 2);
  const again = planImport(fixture('roster-sample'), ctxOf(db));
  assert.equal(again.toCreate.length, 0);
  assert.equal(again.changedCells, 0);
});

test('after renaming an imported employee a re-run creates nobody and changes nothing', () => {
  const db = seed();
  apply(db, planImport(fixture('roster-sample'), ctxOf(db)));
  const him = R.listEmployees(db).find(e => e.name === 'Him');
  R.updateEmployee(db, him.id, { ...him, name: 'Himanshu Patel' });
  const again = planImport(fixture('roster-sample'), ctxOf(db));
  assert.equal(again.toCreate.length, 0);
  assert.equal(again.changedCells, 0);
});

test('ambiguous duplicate names are skipped', () => {
  const db = seed();
  R.createEmployee(db, { id: 'aka2', name: 'AKA ', pin: '2222', active: true }, 0);
  const plan = planImport(fixture('roster-sample'), ctxOf(db));
  assert.deepEqual(plan.ambiguous, ['AKA']);
  assert.ok(!plan.cells.some(c => c.empId === 'aka' || c.empId === 'aka2'));
});

test('dry run reports past-day cells and re-priced shifts', () => {
  const db = seed();
  R.setSettings(db, { roundFrom: '2026-10-26' });
  R.saveShift(db, { id: 's1', empId: 'aka', in: d(2026, 10, 26, 9, 8), out: d(2026, 10, 26, 17), breaks: [] });
  const plan = planImport(fixture('roster-sample'), ctxOf(db));
  assert.equal(plan.repricedShifts, 1);
  assert.ok(plan.pastDayCells >= 3);
});

test('import fetch: empty or broken body is a 502, not a 500', async () => {
  const { makeTestApp, loginAgent } = await import('./helpers.js');
  for(const fetch of [async () => new Response(null, { status: 200 }),
    async () => new Response(new ReadableStream({ pull(c){ c.error(new Error('reset')); } }))]){
    const { app } = await makeTestApp({ fetch });
    const a = await loginAgent(app);
    const r = await a.post('/api/admin/roster/import').send({ dryRun: true });
    assert.equal(r.status, 502);
  }
});

test('imported names are trimmed and a missing name is skipped', () => {
  const db = memDb();
  const src = { employees: [{ id: 'x' }, { id: 'y', name: '  Mary   Jane ' }],
    shifts: { '2026-11-01_x': [{ type: 'OFF' }], '2026-11-01_y': [{ type: 'OFF' }] } };
  const plan = planImport(src, ctxOf(db));
  assert.deepEqual(plan.toCreate.map(c => c.name), ['Mary Jane']);
  assert.ok(plan.skipped.some(k => String(k.key ?? k).endsWith('_x')), JSON.stringify(plan.skipped));
  assert.ok(!JSON.stringify(plan).includes('undefined'));
});
