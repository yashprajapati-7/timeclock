import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memDb } from './helpers.js';
import * as R from '../src/repo.js';

const seed = () => {
  const db = memDb();
  R.createEmployee(db, { id: 'e1', name: 'Ann', pin: '1111', active: true }, 0);
  return db;
};

test('replace cell, list map, clear with []', () => {
  const db = seed();
  const r = R.replaceRosterCell(db, 'e1', '2026-10-26', [{ type: 'CAFE', start: '09:00', end: '13:00' }, { type: 'BAKERY', start: '17:00', end: '21:00' }]);
  assert.equal(r.addedIds.length, 2);
  assert.deepEqual(R.listRoster(db)['2026-10-26|e1'].map(({ type, start, end }) => ({ type, start, end })),
    [{ type: 'CAFE', start: '09:00', end: '13:00' }, { type: 'BAKERY', start: '17:00', end: '21:00' }]);
  assert.equal(R.getRosterCell(db, 'e1', '2026-10-26').length, 2);
  const again = R.replaceRosterCell(db, 'e1', '2026-10-26', [{ type: 'OFF' }]);
  assert.deepEqual(again.removedIds, r.addedIds);
  assert.deepEqual(R.listRoster(db)['2026-10-26|e1'].map(e => [e.type, e.start, e.end]), [['OFF', null, null]]);
  R.replaceRosterCell(db, 'e1', '2026-10-26', []);
  assert.equal(R.listRoster(db)['2026-10-26|e1'], undefined);
  assert.ok('roster' in R.loadData(db));
});

test('listRoster range and row ids in range', () => {
  const db = seed();
  R.replaceRosterCell(db, 'e1', '2026-10-25', [{ type: 'OFF' }]);
  R.replaceRosterCell(db, 'e1', '2026-10-26', [{ type: 'OFF' }]);
  R.replaceRosterCell(db, 'e1', '2026-11-02', [{ type: 'OFF' }]);
  assert.deepEqual(Object.keys(R.listRoster(db, { from: '2026-10-26', to: '2026-11-01' })), ['2026-10-26|e1']);
  assert.equal(R.rosterRowIdsInRange(db, '2026-10-26', '2026-11-01').length, 1);
});
