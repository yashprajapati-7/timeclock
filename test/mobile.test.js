// Mobile layout + "no instruction clutter" guarantees for the UI source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

test('phone layout rules exist', () => {
  assert.match(css, /@media \(max-width:700px\)/);
  assert.match(css, /table\.stack/);                    // tables become cards
  assert.match(css, /td::before\{content:attr\(data-label\)/);
  assert.match(css, /input,select\{font-size:16px\}/);  // no iOS zoom on focus
});

test('data tables are stackable and labelled', () => {
  const stacked = js.match(/<table class="stack">/g) || [];
  assert.ok(stacked.length >= 5, `expected 5+ stackable tables, got ${stacked.length}`);
  for(const label of ['Net pay', 'Paid hrs', 'Worked', 'Elapsed', 'When'])
    assert.ok(js.includes(`data-label="${label}"`), label);
});

test('instruction paragraphs are gone', () => {
  for(const text of ['Click a column heading', 'Solid = completed', 'Every punch and admin change is stored',
    'If a shift is at least this many hours long', 'blank = still on', 'so set them Inactive instead', 'dashed line ='])
    assert.ok(!js.includes(text), `still contains: ${text}`);
});

test('kiosk never advertises the default admin PIN', () => {
  const kiosk = js.slice(js.indexOf('// ---------- Kiosk'), js.indexOf('// ---------- Admin'));
  assert.doesNotMatch(kiosk, /0000/);
});

test('weekly report rows fold on phones behind a Details button', () => {
  assert.ok(js.includes('<tr class="fold">'));
  assert.ok(js.includes('data-act="toggleRow"'));
  assert.ok(css.includes('tr.fold:not(.open) td:not(.head):not(.net):not(.toggle){display:none}'));
});
