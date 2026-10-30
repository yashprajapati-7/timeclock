// UI source checks for the roster/pay-rules screens (plan Tasks 33–42). Behaviour is covered by the API tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const has = (s, what = s) => assert.ok(js.includes(s), `app.js should contain: ${what}`);

test('admin shell: Roster tab, colour classes, kiosk stays plain', () => {
  has("['roster','Roster']");
  has("app.className = 'admin'");
  has("app.className = ''");
  has('style="--tab:var(--c-${k});--tab-soft:var(--c-${k}-soft)"', 'per-tab colour');
});

test('roster page: grid, cell editor, copy/clear/pdf/import', () => {
  for(const s of ['class="roster-grid"', 'data-act="rosterCell"', 'data-submit="rosterAdd"', 'data-act="rosterPreset"',
    '/api/admin/roster/copy-week', '/api/admin/roster/clear-week', '/api/admin/roster/import', '/api/admin/export/roster.pdf', 'parseShortTime'])
    has(s);
  assert.match(css, /\.roster-grid[^{]*\{[^}]*border-collapse:separate/);
  assert.match(css, /\.roster-grid [^{]*\.rname[^{]*\{[^}]*position:sticky/);
});

test('employees: pay type, salary, contact, dates, fixed items', () => {
  for(const n of ['payType', 'weeklySalary', 'email', 'phone', 'birthday', 'startDate']) has(`name="${n}"`);
  has('value="fixed"', 'fixed rate pay type');
  has('data-act="addFixedItem"');
  // Compact list: name, pay, status; a click opens the full details.
  has('<tr class="click" data-act="editEmp"');
  has('data-act="addEmp"');
  has('empNew()');
});

test('report: Gross removed, salary and late shown, payslip emails', () => {
  assert.ok(!js.includes("th('gross'"));
  assert.ok(!js.includes('data-label="Gross"'));
  assert.doesNotMatch(js.slice(js.indexOf('const SORTS'), js.indexOf('const SORTS') + 200), /gross/);
  has('data-label="Salary"');
  has('/api/admin/payslips/email');
  has('/api/admin/payslips/email-status');
  has('data-act="emailAll"');
});

test('shifts, dashboard, settings, kiosk', () => {
  has('data-label="Paid times"');
  has('OT ${c.overMin}m');
  assert.ok(!js.includes('name="otApproved"'), 'no approve-overtime box');
  has('Coming up');
  has('Pay.upcoming(');
  assert.ok(!js.includes('<h3>Alerts'), 'dashboard alerts panel removed');
  has('name="roundFrom"');
  has('name="roundGraceMin"');
  has('Rostered today');
});

test('roster edits are drafts until "Save roster"; late check can be started from the roster page', () => {
  has('data-act="rosterSave"');
  has('function editRosterDraft');
  has('data-act="rosterSaveAll"');
  has('data-act="rosterDiscard"');
  has('function saveRoster');
  has('data-act="rosterStartLate"');
  assert.ok(!js.includes('Late check is off.'), 'no instruction text');
  assert.doesNotMatch(js, /rosterPreset: d => saveRosterCell/);
});
