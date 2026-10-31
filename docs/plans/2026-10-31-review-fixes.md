# Plan: Review fixes (2026-10-31)

## Goal
Fix the three verified must-fix bugs: "fixed" pay type is never stored, `loadData` crashes once there are more than 32,766 shifts, and a shift that ends before its rostered start is paid $0. Also bundle the cheap, low-risk should-fix items. Nothing may break the café's daily kiosk use, and the live database must upgrade safely. The root `index.html` must never change.

Every task is test-first: write the test, run it and watch it fail (red), make the change, run it again and watch it pass (green), then run the whole suite with `npm test`. Tasks marked **guard** are refactors whose test is already green before the change. Their test is there to catch regressions, and the plan says so honestly instead of faking a red step.

## Chosen approach (and why) / Rejected alternatives

**R1, storing the `fixed` pay type (the hard one).** The CHECK constraint is in the column definition, so the `employees` table must be rebuilt. Three tables point at `employees`: `shifts` (ON DELETE RESTRICT), `adjustments` (CASCADE) and `roster` (CASCADE). With foreign keys ON, `DROP TABLE employees` runs an implicit `DELETE`. That would fail on RESTRICT, or wipe every adjustment and roster row through CASCADE. `PRAGMA foreign_keys` cannot be changed inside `BEGIN`.

- **Chosen: the official SQLite 12-step rebuild, with `migrate()` support for "foreign-keys-off" migrations.** A migration can be written as `{ foreignKeysOff: true, sql }`. `migrate()` then does this:
  1. Runs `PRAGMA foreign_keys=OFF` *before* `BEGIN` and checks that it really is 0 (if not, it throws, which also catches being called inside an outer transaction).
  2. Runs the SQL in `db.tx`.
  3. Runs `PRAGMA foreign_key_check` inside the same transaction and throws (rolling back) if it returns any rows.
  4. Sets `user_version` and commits.
  5. Turns `PRAGMA foreign_keys=ON` back on in a `finally`.

  The SQL creates `employees_new`, copies every row **including `rowid`** (the list order uses `created_at, rowid`), drops `employees`, then renames `employees_new` to `employees`. **The order matters:** never rename the *old* table first, because modern SQLite (legacy_alter_table=OFF) would rewrite the child foreign keys to point at `employees_old`. Child tables refer to the name `employees` as text, so they bind to the new table without being touched. Pros: the schema is correct, and this is the documented procedure. The pre-migration `VACUUM INTO` snapshot in `src/server.js` already protects the live database. Risk: medium-low, covered by a populated-database test.
- Rejected: `writable_schema` editing. Not acceptable, as the brief says.
- Rejected: a rebuild with foreign keys left ON plus `defer_foreign_keys`. CASCADE still fires on the implicit DELETE, so roster and adjustment rows would be lost.
- **Fallback, kept ready:** add an `ALTER TABLE employees ADD COLUMN fixed_rate INTEGER NOT NULL DEFAULT 0` column and map `payType 'fixed'` to `pay_type='hourly' AND fixed_rate=1`. This is purely additive and needs no rebuild, but the representation is ugly and the CHECK still lies about the allowed values. **Trigger:** switch to it on *any* problem with the rebuild, either a failing Task 2 test or anything unexpected when the new code runs against the live copy in runbook step (b). That includes a migration error, a non-empty `foreign_key_check`, `integrity_check` not equal to `ok`, a changed row count, or a pay difference that is not an R3 case. Under the fallback, migration 3 becomes the single `ALTER TABLE`, `extra()` writes `fixed_rate`, and `toEmp` reads `payType = fixed_rate ? 'fixed' : pay_type`. Task 2's test turns into "column added, all rows keep `fixed_rate = 0`".

**R2, the 32,766-shift crash.** Load the breaks with the same WHERE clause through a JOIN on `shifts`, so there is one query and no bound-parameter list. Rejected: chunking the IN list (more queries, more code).

**R3, shifts that end before the rostered start.** A shift only matches a roster entry if `(sh.out ?? now) > S`. Unmatched shifts are already paid their actual time. `matchRoster` gets a `now` argument (default `Date.now()`), and `calcAll` passes its `now` in. The browser shares `pay.js`, and the change is backward compatible.

**Freezing past weeks (user decision 2): a pay-rule history.** The four rounding settings (`rounding`, `roundGraceMin`, `roundStepMin`, `roundFrom`) are replaced by one setting:

`settings.payRules = [{ from: 'YYYY-MM-DD', rounding: bool, graceMin: 0–30, stepMin: 1|5|10|15|30 }]`

The list is sorted by `from`, and each `from` appears once.

- Each shift is priced by the entry in force on its clock-in date: `ruleFor(st, sh.in)` is the last entry with `from <= ymd(sh.in)`, using server local time (Australia/Sydney). Shifts before the first entry, or under a `rounding:false` entry, get no roster matching and are paid actual times.
- Saving the pay-rule fields appends an entry effective from **today** (the server date). A second change on the same day replaces today's entry, and a save that changes nothing is a no-op.
- `roundFrom` can no longer be set: a past date would re-price worked shifts.
- Migration 4 turns the live settings (rounding true, roundFrom 2026-10-26, grace 6, step 15) into the first entry `{from:'2026-10-26', rounding:true, graceMin:6, stepMin:15}`, so no current price changes.
- Backups carry `payRules`. Legacy v3 backups that only have the four old keys are converted by the same `legacyPayRules()` helper.
- When a settings object has no `payRules` array, `pay.js` derives the rules from the legacy keys. Hand-built settings in the pure pay tests and the Settings-page example therefore keep working unchanged.
- "Start late check" sends `{ rounding: true }`, which appends an entry from today.

Rejected alternatives:
- Storing the priced paid times on each shift. That needs a new column, a backfill, and recalculation rules whenever the roster changes.
- Allowing only future `from` dates (for example next Monday). The user asked for "from today".

## Releases
The work ships in two separate deploys. Each one follows the runbook below.

- **Release A (database v2 → v3):** Tasks 1–12, 16–22 and 26. These are the must-fixes, the cheap should-fixes, and removing `anomalies()` and `tz`.
- **Release B (database v3 → v4):** Tasks 27–33, the pay-rule history. Deploy it only after Release A has run cleanly in the café for at least two working days: kiosk punches, a weekly report and a payslip run all behaving normally.
- Tasks 13, 14, 15, 23, 24 and 25 are now under Deferred.

## Tasks (ordered by severity)

### Task 1: `migrate()` supports foreign-keys-off migrations [R1]
- Files: `src/db.js`, `test/db.test.js`
- Change: `migrate()` accepts each list item either as a string (as today) or as `{ foreignKeysOff: true, sql }`. For the object form it follows the five steps in "Chosen approach": OFF before BEGIN plus a check that it is 0, `foreign_key_check` inside the transaction, ON again in `finally`. String migrations behave exactly as they do now.
- Test first (`test/db.test.js`):
  - `fk-off migration: dangling foreign key aborts and rolls back` uses the list `[migrations[0], migrations[1], { foreignKeysOff: true, sql: "INSERT INTO shifts (id,emp_id,clock_in) VALUES ('bad','ghost',1)" }]`. It asserts that `migrate` throws `/foreign key/i`, that `user_version` is still `2`, that `SELECT COUNT(*) FROM shifts WHERE id='bad'` returns 0, and that `PRAGMA foreign_keys` is back to 1.
  - `fk-off migration: SQL error rolls back and re-enables foreign keys`: the sql is `'CREATE TABLE x(a); SELECT * FROM nope'`. It asserts a throw, that no table `x` exists, and that `foreign_keys` is 1.
  - `fk-off migration refuses to run inside a transaction`: `db.tx(() => migrate(db, list))` throws `/foreign keys/i`.
- Run: `node --disable-warning=ExperimentalWarning --test test/db.test.js`
- Depends on: none

### Task 2: Migration 3 rebuilds `employees` with `CHECK(pay_type IN ('hourly','fixed','salary'))` [R1]
- Files: `src/migrations.js`, `test/db.test.js`
- Change: append `{ foreignKeysOff: true, sql }` to the migrations list:
  - `CREATE TABLE employees_new (...)`: exactly the current columns, defaults and constraints (id TEXT PK, name NOT NULL, pin NOT NULL UNIQUE CHECK(length(pin)=4), rate1, rate2, active NOT NULL DEFAULT 1, created_at NOT NULL, role NOT NULL DEFAULT '', pay_type NOT NULL DEFAULT 'hourly' CHECK(pay_type IN ('hourly','fixed','salary')), weekly_salary, email NOT NULL DEFAULT '', phone NOT NULL DEFAULT '', birthday, start_date, fixed_items NOT NULL DEFAULT '[]').
  - `INSERT INTO employees_new (rowid, <all 15 columns>) SELECT rowid, <all 15 columns> FROM employees;`
  - `DROP TABLE employees; ALTER TABLE employees_new RENAME TO employees;`
  - `employees` has no explicit indexes other than the UNIQUE(pin) autoindex, which the new definition recreates.
- Test first (`test/db.test.js`, new test `migration 3 rebuilds employees on a populated v2 file database`):
  - Setup: open a temporary file database and run `migrate(db, migrations.slice(0, 2))`. Insert employees e1 (hourly), e2 (salary, weekly_salary 900) and e3 (no data), with created_at all equal so that rowid order matters. Add shift s1 for e1 with two breaks, an adjustment for e1, roster rows for e1 and e2, and one session row. Record the per-table counts and `SELECT rowid,id FROM employees`.
  - Then run `migrate(db)` and assert:
    - `user_version === 3`.
    - Every table count is unchanged (employees 3, shifts 1, breaks 2, adjustments 1, roster 2, sessions 1), and the employee rowids are unchanged.
    - `PRAGMA foreign_key_check` returns `[]` and `PRAGMA foreign_keys` is 1.
    - `db.get('PRAGMA integrity_check').integrity_check === 'ok'`.
    - The `sqlite_master.sql` text of `shifts`, `adjustments` and `roster` still contains `REFERENCES employees(id)`.
    - `SELECT name FROM sqlite_master WHERE sql LIKE '%employees_new%' OR sql LIKE '%employees_old%' OR name LIKE 'employees_%'` returns `[]`. This covers every table, index and trigger, not just the three child tables.
    - `UPDATE employees SET pay_type='fixed' WHERE id='e1'` works, and `'weekly'` throws.
    - The foreign key actions still work: `DELETE FROM employees WHERE id='e1'` throws (RESTRICT, because of shifts), and `DELETE FROM employees WHERE id='e2'` cascades e2's roster rows away.
    - `INSERT` of a duplicate pin throws (UNIQUE survived).
  - Update the existing `migration 2 upgrades a v1 database` test: its `user_version` assertion becomes `migrations.length`.
- Run: `node --disable-warning=ExperimentalWarning --test test/db.test.js`
- Depends on: Task 1

### Task 3: Pass `payType` through in the repo; API and backup round-trip [R1]
- Files: `src/repo.js` (`extra()`, line 48), `test/admin.employees.test.js`, `test/backup.import.test.js`
- Change: `extra()` maps `['hourly','fixed','salary'].includes(e.payType) ? e.payType : 'hourly'`.
- Test first:
  - `admin.employees.test.js` › `fixed pay type is stored and returned`: POST `/api/admin/employees {name:'Fi', pin:'5555', payType:'fixed', rate1:25}`. GET `/state` shows the employee with `payType === 'fixed'`. PUT the employee with `payType:'hourly'` and the state shows `'hourly'`. PUT back to `'fixed'`, then POST `/undo`, and the state shows `'hourly'` (undo restores the row).
  - `backup.import.test.js` › `fixed pay type survives backup round-trip`: create a fixed employee, then `exportBackup`, `importBackup` into a fresh `memDb()`, and `listEmployees` gives `payType === 'fixed'`. Also check that `week()` pays hours beyond `tierHours` at `rate1`.
- Run: `node --disable-warning=ExperimentalWarning --test test/admin.employees.test.js test/backup.import.test.js`
- Depends on: Task 2
- Note: employees the owner saved as "Fixed" before this fix were stored as hourly with rate2 = rate1, so their pay was correct. They are **not** auto-converted, because rate1 = rate2 could also be a deliberate hourly setting. The owner re-selects "Fixed rate" once. Put this in the release note.

### Task 4: Load breaks with a JOIN, not one `?` per shift [R2]
- Files: `src/repo.js` (`attachBreaks`, `getShift`, `listShifts`, `openShiftFor`), `test/repo.shifts.test.js`
- Change: `attachBreaks(db, rows, where, params)` loads breaks with `SELECT b.shift_id, b.start_at, b.end_at FROM breaks b JOIN shifts s ON s.id = b.shift_id WHERE ${where} ORDER BY b.start_at`, using the same `where`/`params` as the shift query. In the WHERE clauses, write the columns with an `s.` prefix:
  - `getShift`: `s.id = ?`
  - `listShifts`: `s.clock_in >= ? AND s.clock_in < ? [AND s.emp_id = ?]`
  - `openShiftFor`: `s.emp_id = ? AND s.clock_out IS NULL`
- Test first (`repo.shifts.test.js` › `loadData handles more than 32,766 shifts`): in one `db.tx`, use a single prepared statement through `db.raw.prepare` to insert 33,000 shifts for one employee, plus a break on the first and the last shift. Assert that `loadData(db).shifts.length === 33000`, and that the first and last shift each have `breaks.length === 1` with the right start. There is no timing assertion. Red today: "too many SQL variables".
- Run: `node --disable-warning=ExperimentalWarning --test test/repo.shifts.test.js`
- Depends on: none

### Task 5: A shift that ends at or before the rostered start is not matched [R3]
- Files: `src/shared/pay.js` (`matchRoster`, `calcAll`), `test/pay.roster.test.js`
- Change: `matchRoster(empShifts, roster, empId, st, now = Date.now())`. Inside the candidate loop, `const end = sh.out ?? now;` and skip any candidate where `end <= S`, for both the window match and the `early` fallback. `calcAll` passes `now`. Nothing else changes: unmatched shifts already pay actual time.
- Test first (`pay.roster.test.js`, using the file's existing `ST`, `t`, `sh`, `cafe`, `roster`, `match1`):
  - `morning shift before a 14:00 roster is paid actual time`: roster `cafe('14:00','20:00')`, shift `t(8)–t(12)`. `match1` returns `undefined`. `shift(s, ST, now, undefined)` gives `paidIn t(8)`, `paidOut t(12)`, `paid 3.75` (4 h with a 15-minute policy break).
  - `shift ending before a 09:00 roster start is paid actual time`: roster 09:00–17:00, shift `t(7)–t(8,55)`, `match1` returns `undefined`, `paid === 115/60`. Boundary: shift `t(7)–t(9)` is also unmatched.
  - `chain: an unmatched morning shift does not steal the start rule`: shifts m `t(8)–t(12)` and a `t(13,56)–t(20)`, roster 14:00–20:00. `matchRoster([m,a], r, 'e1', ST, t(21))` has no entry for m, and has `first === true, last === true` for a. In `calcAll` the paidIn of a is `t(14)`.
  - `open shift matches once it passes the rostered start`: in `t(7)`, out null, roster 09:00. At `now = t(8,30)` it is unmatched; at `now = t(9,30)` it is matched with `first === true`.
  - The existing match, split and chain tests must stay green.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.roster.test.js`
- Depends on: none

### Task 6: An undo that hits a conflict is discarded instead of blocking the stack
- Files: `src/undo.js` (`undo()`, the catch branch around lines 87-92), `test/undo.test.js`
- Change: when the conflict is thrown (inside the tx or by mapping a code-19 constraint error), `stack.pop()` before rethrowing. The message stays the same. Other errors (BUSY/IO) do **not** pop.
- Test first: in the existing test `conflict: kiosk punch after admin edit → 409, punch kept`, change the last assertion to `after.undoLabel === 'Add employee'` (the 'Edit shift' entry is gone).
- Run: `node --disable-warning=ExperimentalWarning --test test/undo.test.js`
- Depends on: none

### Task 7: Snapshot before backup import and before Erase; prepared `VACUUM INTO ?`
- Files: `src/snapshot.js`, `src/routes/admin.js`, `src/app.js` (new option `backupDir`, put on `ctx`), `src/server.js` (pass `config.backupDir`), `test/snapshot.test.js`, `test/admin.backup.test.js`
- Change:
  - Add `snapshotBefore(db, dir, label, now)`. It writes `timeclock-pre-<label>-YYYY-MM-DD-HHMMSS.db` into `dir` using the prepared `VACUUM INTO ?`, and returns null for `:memory:`. The name does not match `SNAPSHOT`, so `prune()` keeps it.
  - `snapshotBeforeMigrate` uses the same helper with its existing name format and folder.
  - `snapshot()` line 15 switches to `db.raw.prepare('VACUUM INTO ?').run(temp)`.
  - In `/import`, the order is `normalizeBackup`, then `snapshotBefore(..., 'import')`, then `importBackup`. In `/erase`, it is the confirm check, then `snapshotBefore(..., 'erase')`, then the delete. The snapshot runs outside any transaction. If the snapshot throws, the destructive action does not happen (500).
- Test first:
  - `admin.backup.test.js` › `erase and import keep a pre-snapshot`: use a temporary file database with migrate, and `makeTestApp({ db, backupDir })`. Add employee Ann, then POST `/erase {confirm:'ERASE'}`. `backupDir` contains exactly one file matching `/^timeclock-pre-erase-\d{4}-\d{2}-\d{2}-\d{6}\.db$/`. Opening it with `openDb` gives `SELECT COUNT(*) FROM employees === 1` (close it before cleanup, for Windows). Then POST `/import fixture('backup-v2')` and a `timeclock-pre-import-…db` file exists.
  - `snapshot.test.js` › `snapshot into a folder with a quote in its name` (**guard**): dir `…/O'Brien`, and the file exists.
- Run: `node --disable-warning=ExperimentalWarning --test test/admin.backup.test.js test/snapshot.test.js`
- Depends on: none

### Task 8: Changing the admin PIN signs out every other session
- Files: `src/auth/sessions.js` (`destroyAllSessions(db, { except } = {})`), `src/routes/auth.js` (`/pin`), `test/auth.api.test.js`
- Change: after `setSettings`, call `destroyAllSessions(db, { except: req.session.key })`, which runs `DELETE FROM sessions WHERE token_hash <> ?`.
- Test first: `PIN change revokes other admin sessions, keeps the current one`: log in agents A and B. A POSTs `/api/auth/pin {current:'0000', next:'4321'}` and gets 200. Then B GETs `/api/auth/me` and gets **401**, while A gets **200**.
- Run: `node --disable-warning=ExperimentalWarning --test test/auth.api.test.js`
- Depends on: none

### Task 9: `/api/kiosk/info` no longer sends `defaultPin` to anonymous callers
- Files: `src/routes/kiosk.js` (line 17), `test/kiosk.api.test.js`
- Change: drop `defaultPin` from the response. The UI never reads it from `/info`: the admin gets it from `/auth/login` and `/auth/me`.
- Test first: remove `'defaultPin'` from the `KEYS` allow-list in `kiosk.api.test.js`. `info exposes only the allow-list` then fails until the field is removed.
- Run: `node --disable-warning=ExperimentalWarning --test test/kiosk.api.test.js`
- Depends on: none

### Task 10: Small JSON limit on public endpoints; larger limit for admin, after auth
- Files: `src/app.js` (line 38), `test/proxy.test.js` or a new `test/limits.test.js`
- Change:
  - `app.use('/api', requireJson)`
  - `app.use(['/api/auth', '/api/kiosk'], express.json({ limit: '16kb' }))`
  - `app.use('/api/admin', requireAdmin(ctx), express.json({ limit: '25mb' }))`

  Remove the old separate `requireAdmin` line. Admin bodies are now parsed only after the session check. 25 MB leaves room for the audit trail growing inside backups, at about 3 MB a year for 15 staff.
- Test first (`test/limits.test.js`):
  - `kiosk rejects bodies over 16 KB`: POST `/api/kiosk/identify` with `{pin:'1111', pad:'x'.repeat(20000)}` gives 413.
  - `unauthenticated admin POST is 401 without reading a big body`: POST `/api/admin/import` with a 1 MB body and no cookie gives 401.
  - `admin import accepts an 11 MB backup`: logged in, POST `/api/admin/import` with `fixture('backup-v2')` plus one audit row whose `detail` is `'x'.repeat(11*1024*1024)` gives 200. Red today: 413.
- Run: `node --disable-warning=ExperimentalWarning --test test/limits.test.js`
- Depends on: none

### Task 11: Close the CSV/Excel formula-injection gap
- Files: `src/shared/format.js` (`safeText`, line 72), `test/format.test.js`
- Change: `safeText = v => { v = String(v ?? ''); return /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? "'" + v : v; }`
- Test first (add to `safeText guards formulas but leaves numbers`): `'-5'` and `'-3.5'` stay as they are, and so does `'12.50'`. These get a leading `'`: `'-1+A1'`, `'-2-cmd|x'`, `'\t=1+1'`, `'\r=1+1'`. The existing assertions stay.
- Run: `node --disable-warning=ExperimentalWarning --test test/format.test.js`
- Depends on: none

### Task 12: "Email all payslips" skips staff with no pay that week
- Files: `src/shared/pay.js` (new `export const hasPay = r => r.paid > 0 || (r.salary ?? 0) > 0 || r.allow > 0 || r.deduct > 0`), `src/routes/mail.js` (`emp === 'all'` loop), `public/app.js` (around line 851), `test/pay.week.test.js`, `test/mail.test.js`, `test/ui.flows.test.js` or `ui.roster.test.js`
- Change: in the `all` loop, a row where `!hasPay(row)` is pushed as `{status:'skipped', error:'No pay this week'}`, with no PDF and no send. An explicit single-employee send is unchanged. In the UI, the confirm count becomes `rows.filter(r => r.e.email && Pay.hasPay(r)).length`.
- Test first:
  - `pay.week.test.js` › `hasPay`: `{paid:0,salary:null,allow:0,deduct:0}` is false; `paid:0.5`, `salary:900` and `allow:20` are each true.
  - `mail.test.js` › `email all skips staff with no pay`: inside `withMail`, add employee Dan (email `dan@x.co`, no shifts) and POST `email {week:'2026-10-26', emp:'all'}`. Dan is `{status:'skipped', error:'No pay this week'}`, and no Brevo call went to `dan@x.co`.
  - UI source check: `app.js` contains `Pay.hasPay(r)`.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.week.test.js test/mail.test.js test/ui.roster.test.js`
- Depends on: none

### Task 16: Overtime is flagged only when overtime is actually paid
- Files: `src/shared/pay.js` (`paidSpan`, lines 78-81), `test/pay.roster.test.js`
- Change: in the `outM > E + g` branch, `res.overMin = res.paidOut > E ? Math.round((outM - E) / MIN) : 0`. The flag still reports *actual* minutes over, so the existing tests (25 and 30 minutes) stay valid.
- Test first: `overtime flag only when overtime is paid`: roster 09–17, out `t(17,10)` gives `paidOut === t(17)` and `overMin === 0`. Out `t(17,25)` still gives `overMin === 25`.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.roster.test.js`
- Depends on: Task 5 (same file; avoids conflicting edits)

### Task 17: A payslip printed mid-week shows "—", not "ABSENT", for today and later days
- Files: `src/reports/pdf.js` (`payslipDays`, around line 124), `test/report.pdf.test.js`
- Change: `const future = day >= ymd(report.generatedAt);` gives `off ? 'OFF' : timed && !future ? 'ABSENT' : '—'`.
- Test first: `payslip does not mark future rostered days ABSENT`: `report = { weekDays: <7 days from 2026-10-26>, generatedAt: d(2026,10,28,12) }` and `r = { roster: Array(7).fill([{type:'CAFE',start:'09:00',end:'17:00'}]), shifts: [] }`. The third column of `payslipDays(r, report)` deep-equals `['ABSENT','ABSENT','—','—','—','—','—']`.
- Run: `node --disable-warning=ExperimentalWarning --test test/report.pdf.test.js`
- Depends on: none

### Task 18: Generate PINs with crypto randomness
- Files: `src/roster-import.js` (line 88: `randomInt(10000)` from `node:crypto`), `public/app.js` (`suggestPin`: `crypto.getRandomValues(new Uint32Array(1))[0] % 10000`), `test/roster.import.test.js` or `test/static.test.js`
- Test first: a source check that neither `src/roster-import.js` nor `public/app.js` matches `/Math\.random/`. The existing applyImport and pinGen tests stay green.
- Run: `node --disable-warning=ExperimentalWarning --test test/static.test.js test/roster.import.test.js`
- Depends on: none

### Task 19: Fix the roster-key regex in backups (it is **still** broken)
- Files: `src/backup.js` (line 50: `/^d{4}-d{2}-d{2}|.+$/` becomes `/^\d{4}-\d{2}-\d{2}\|.+$/`), `test/backup.normalize.test.js`
- Test first: `roster key must use the | separator`: `normalizeBackup({ employees:[validE1], shifts:[], v:3, roster:{ '2026-10-26#e1': [] } })` throws `/roster 2026-10-26#e1/`. Today it is accepted, because the day and `slice(11)` both look valid.
- Run: `node --disable-warning=ExperimentalWarning --test test/backup.normalize.test.js`
- Depends on: none

### Task 20: Imported staff names are trimmed, and a missing name is skipped
- Files: `src/roster-import.js` (`planImport`, around line 51), `test/roster.import.test.js`
- Change: `const nm = String(s?.name ?? '').trim().replace(/\s+/g, ' ')`. If `!nm`, skip the employee. It gets no target, so its cells end up in `skipped` with the existing reason. Use `nm` for the target and for `toCreate`.
- Test first: `planImport` with employees `[{id:'x'}, {id:'y', name:'  Mary   Jane '}]` and a cell for each gives `toCreate.map(c => c.name)` deep-equal to `['Mary Jane']`. One of the `skipped` keys ends with `_x`, and no name equals `'undefined'`.
- Run: `node --disable-warning=ExperimentalWarning --test test/roster.import.test.js`
- Depends on: none

### Task 21: `db.tx` rejects async callbacks
- Files: `src/db.js` (`tx`), `test/db.test.js`
- Change: after `fn()`, `if(result && typeof result.then === 'function') throw new TypeError('db.tx callback must be synchronous');`. This is inside the `try`, so it rolls back. No async callers exist today (checked with grep).
- Test first: `tx rejects a promise-returning callback and rolls back`: `assert.throws(() => db.tx(() => { db.run("INSERT INTO settings (key,value) VALUES ('a','1')"); return Promise.resolve(); }), /synchronous/)`, then the settings count is 0.
- Run: `node --disable-warning=ExperimentalWarning --test test/db.test.js`
- Depends on: Task 1 (same file)

### Task 22: Shutdown force-exits after 10 s
- Files: new `src/shutdown.js` (`export const gracefulShutdown = ({ server, db, exit = process.exit, timeoutMs = 10000 }) => () => { setTimeout(() => exit(1), timeoutMs).unref(); server.close(() => { db.close(); exit(0); }); }`), `src/server.js` (use it), new `test/shutdown.test.js`
- Test first:
  - `forces exit when close hangs`: a fake server whose `close` never calls back, `timeoutMs: 20`; after awaiting 60 ms, exit was called with `1`.
  - `clean close exits 0 and closes db`: `close(cb)` calls `cb()`, and `db.close` was called, with exit `0`.
- Run: `node --disable-warning=ExperimentalWarning --test test/shutdown.test.js`
- Depends on: none

### Task 26: Dead code: `anomalies()` and the `/state` `tz` field
- Files: `src/shared/pay.js:203-243`, delete `test/pay.anomalies.test.js`, the import in `test/pay.roster.test.js:5` plus any use of it, `src/routes/admin.js:25-26`
- Test first: in `admin.shifts.test.js` or `ui.flows.test.js`, `'tz' in (await a.get('/api/admin/state')).body === false`. In `pay.week.test.js`, `'anomalies' in await import('../src/shared/pay.js') === false`.
- Run: `npm test` (the total test count drops by the 5 anomaly tests; that is expected)
- Depends on: Task 16 (same file)

### Release B: Pay-rule history (user decision 2: "Keep past weeks frozen")
Start Release B only once Release A is live and stable. Run Tasks 27–33 after Tasks 5, 16 and 26. Those tasks edit the same `pay.js` functions, and Task 26 removes `anomalies()`, the last other user of `roundingFrom`.

### Task 27: `migrate()` supports JS migrations `{ up(db) }`
- Files: `src/db.js`, `test/db.test.js`
- Change: a list item may be `{ up: db => … }`. It runs inside the same `db.tx` as SQL migrations, before `user_version` is set. Strings and `{ foreignKeysOff, sql }` keep working.
- Test first: `JS migration runs in the transaction and rolls back on error`:
  - The list `[m0, m1, { up: db => db.run("INSERT INTO settings (key,value) VALUES ('z','1')") }]` brings `user_version` to 3 and the `z` row exists.
  - With `up` instead doing an insert followed by `throw new Error('x')`, `migrate` throws `/x/`, there is no `z` row, and `user_version` is still 2.
- Run: `node --disable-warning=ExperimentalWarning --test test/db.test.js`
- Depends on: Task 1

### Task 28: Pure rule helpers in `pay.js`: `legacyPayRules`, `ruleFor`, `appendPayRule`
- Files: `src/shared/pay.js`, `test/pay.rules.test.js` (new)
- Change:
  - `legacyPayRules(st)` returns `st.rounding !== false && st.roundFrom ? [{ from: st.roundFrom, rounding: true, graceMin: num(st.roundGraceMin ?? 6), stepMin: num(st.roundStepMin) || 15 }] : []`.
  - `payRules(st)` returns `Array.isArray(st.payRules) ? st.payRules : legacyPayRules(st)`.
  - `ruleFor(st, ts)` returns the last entry of `payRules(st)` whose `from <= ymd(ts)`, or `null`.
  - `appendPayRule(rules, change, today)`:
    - The base is `ruleFor({payRules: rules}, atLocal(today,'00:00'))`, or `{rounding:true, graceMin:6, stepMin:15}` if there is none.
    - `next = { from: today, ...base without from, ...change }`.
    - If `next` equals the base apart from `from`, return `rules` unchanged.
    - If the last entry's `from === today`, replace that entry; otherwise append `next`.
- Test first (`pay.rules.test.js`, `R0 = {from:'2026-10-26', rounding:true, graceMin:6, stepMin:15}`):
  - `legacy settings become one rule`:
    - `ruleFor({rounding:true, roundFrom:'2026-10-26', roundGraceMin:6, roundStepMin:15}, d(2026,10,27,9))` deep-equals `R0`.
    - `ruleFor(sameSt, d(2026,10,25,23,59))` is `null`.
    - `legacyPayRules({rounding:false, roundFrom:'2026-10-26'})` and `legacyPayRules({roundFrom:null})` both deep-equal `[]`.
  - `ruleFor picks the entry in force on the clock-in date`: with `payRules = [R0, {from:'2026-10-31', rounding:true, graceMin:10, stepMin:15}]`, the grace is 6 for `d(2026,10,30,23)` and 10 for `d(2026,10,31,0,1)`.
  - `appendPayRule`:
    - `appendPayRule([R0], {graceMin:10}, '2026-10-31')` deep-equals `[R0, {from:'2026-10-31', rounding:true, graceMin:10, stepMin:15}]`.
    - Applying `{graceMin:12}` to that result on the same day gives a length of 2 and a last grace of 12.
    - `appendPayRule([R0], {graceMin:6}, '2026-10-31')` returns the same array (`===`).
    - `appendPayRule([], {rounding:true}, '2026-10-31')` deep-equals `[{from:'2026-10-31', rounding:true, graceMin:6, stepMin:15}]`.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.rules.test.js`
- Depends on: none

### Task 29: Price each shift with the rule in force on its clock-in date
- Files: `src/shared/pay.js` (`matchRoster`, `paidSpan`, `shift`, `week`; delete `roundingFrom`), `test/pay.rules.test.js`
- Change:
  - `matchRoster`: `const rule = ruleFor(st, sh.in); if(!rule?.rounding) continue;`. Each match stores `rule`.
  - `paidSpan` uses `g = (match.rule?.graceMin ?? num(st.roundGraceMin))` and `step = match.rule?.stepMin ?? (num(st.roundStepMin) || 15)`. The fallback keeps hand-built matches working, such as the Settings-page example at `app.js:696`.
  - `shift()` also returns `late: p.lateMin > (match?.rule?.graceMin ?? 0)`.
  - `week()` counts `c.late` instead of comparing against `data.settings.roundGraceMin`.
- Test first (`pay.rules.test.js`; roster `CAFE 09:00–17:00` every day; break rules `[]`; `before = {payRules:[R0]}`, `after = {payRules:[R0, {from:'2026-10-31', rounding:true, graceMin:10, stepMin:15}]}`):
  - `a shift worked before a grace change keeps its paid times and LATE flag`: shift `d(2026,10,27,9,8)`–`d(2026,10,27,17)`. Under both `before` and `after`, `calcAll` gives `paidIn === d(2026,10,27,9,15)`, `lateMin === 8` and `late === true`, and the two `calcAll(...).get(id)` results deep-equal each other. Do the same for a shift on 2026-10-30.
  - `a shift on or after the change date uses the new grace`: shift `d(2026,10,31,9,8)`–`17:00` under `after` gives `paidIn === d(2026,10,31,9)`, `lateMin === 0` and `late === false`. Under `before` it gives `paidIn === 9:15` and `late === true`.
  - `before the first rule → actual times`: shift `d(2026,10,25,9,8)`–`17:00` gives `paidIn === d(2026,10,25,9,8)` and `roster === null`.
  - `rounding switched off from a date`: with `payRules: [R0, {from:'2026-11-02', rounding:false, graceMin:6, stepMin:15}]`, a shift `d(2026,11,3,9,8)`–`17:00` is unmatched (`paidIn` 9:08). A shift on 2026-10-27 is still rounded (9:15).
  - `week() late count follows the shift's own rule`: two shifts at 9:08, on 10-30 and 10-31, under `after`, give `week(...).late === 1` for the week of 2026-10-26.
  - The existing `pay.roster`, `pay.week` and `report.roster` tests stay green through the legacy fallback.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.rules.test.js test/pay.roster.test.js test/pay.week.test.js test/report.roster.test.js`
- Depends on: Tasks 5, 16, 26, 28

### Task 30: `payRules` setting plus migration 4 (live settings become the first entry)
- Files: `src/repo.js` (`DEFAULT_SETTINGS`: remove `rounding`, `roundGraceMin`, `roundStepMin` and `roundFrom`; add `payRules: []`), `src/migrations.js` (migration 4), `src/validate.js` (a `payRules` case validates the whole list), `test/db.test.js`, `test/validate.test.js`
- Change:
  - Migration 4 is `{ up(db) }`. It reads the four legacy keys from `settings` (JSON). If no `payRules` row exists, it inserts `JSON.stringify(legacyPayRules(legacy))`. It does **not** delete or change the legacy rows (`rounding`, `roundFrom`, `roundGraceMin`, `roundStepMin`). They stay in the table but nothing reads or writes them. If Release B is rolled back to Release A code, that code still finds its settings exactly as they were.
  - `getSettings` ignores the legacy keys: `const LEGACY_SETTINGS = new Set(['rounding','roundFrom','roundGraceMin','roundStepMin'])`, and the loop skips those rows. Nothing in the new code can see them by accident, and `publicSettings` and `exportBackup` never contain them.
  - The `validateSettings` case for `payRules` checks:
    - it is an array of at most 200 entries;
    - each `from` is a real date;
    - `rounding` is a boolean;
    - `graceMin` is an integer from 0 to 30;
    - `stepMin` is one of 1, 5, 10, 15 or 30;
    - `from` values are strictly increasing.
  - The old `rounding`, `roundGraceMin`, `roundStepMin` and `roundFrom` cases are removed from `validateSettings`. Task 31 handles those inputs in the route.
- Test first:
  - `db.test.js` › `migration 4 turns live rounding settings into the first pay rule`: take a v3 database with settings rows `rounding=true`, `roundFrom="2026-10-26"`, `roundGraceMin=6`, `roundStepMin=15`. After `migrate(db)`:
    - `user_version === 4`, and `getSettings(db).payRules` deep-equals `[R0]`.
    - `SELECT key, value FROM settings WHERE key IN ('rounding','roundFrom','roundGraceMin','roundStepMin') ORDER BY key` still returns all four rows with their original values (`'true'`, `'"2026-10-26"'`, `'6'`, `'15'`).
    - `getSettings(db)` and `publicSettings(db)` have none of the keys `rounding`, `roundFrom`, `roundGraceMin` or `roundStepMin`.
  - `db.test.js` › `rollback safety: old-code-style settings reading still works after migration 4`: the test copies the Release A `getSettings` logic inline: `structuredClone({rounding:true, roundGraceMin:6, roundStepMin:15, roundFrom:null})`, then a loop over `SELECT key, value FROM settings` with `JSON.parse`. After migration 4 it yields `roundFrom === '2026-10-26'`, `rounding === true`, `roundGraceMin === 6` and `roundStepMin === 15`. Release A's `legacyPayRules` on that object deep-equals `[R0]`, so old code would price exactly as before. Also run `migrate(db, migrations.slice(0, 3))` (the Release A list) on the v4 database: it does nothing, `user_version` stays 4, and nothing throws.
  - `migration 4 keeps every price`: three shifts (10-25, 10-27 and 10-30, all at 9:08) and a roster. `calcAll` with the legacy settings object (built before migrating) deep-equals `calcAll(loadData(db))` after migrating.
  - Variants:
    - no rounding rows at all (a fresh database) gives `payRules` equal to `[]`;
    - `rounding=false` with a `roundFrom` set gives `[]`;
    - `roundFrom` set with no grace or step rows gives `[{from, rounding:true, graceMin:6, stepMin:15}]`.
  - `validate.test.js`: replace the lines 88–93 block with:
    - `validateSettings({payRules:[R0]})` deep-equals `{payRules:[R0]}`.
    - `bad(() => validateSettings({payRules:[{...R0, stepMin:7}]}), /step/i)`.
    - `bad(() => validateSettings({payRules:[R0, {...R0}]}), /order|date/i)`.
- Run: `node --disable-warning=ExperimentalWarning --test test/db.test.js test/validate.test.js`
- Depends on: Tasks 27, 28 (and Task 2 for the migration numbering)

### Task 31: Saving pay rules appends an entry from today; past dates are refused
- Files: `src/routes/admin.js` (`PUT /settings`), `test/helpers.js` (new `seedPayRules(db, rules)`, which calls `R.setSettings(db, { payRules: rules })`), `test/admin.settings.test.js` (new). Update the tests that set `roundFrom` through the API or the repo: `admin.roster.test.js:41,77`, `admin.shifts.test.js:43`, `e2e.roster.test.js:38,72`, `kiosk.api.test.js:75` and `roster.import.test.js:84`. They switch to `seedPayRules(db, [R0])`, and `e2e.roster.test.js:72` asserts `settings.payRules`. If deferred Task 13 (the roster batch endpoint) ever comes back, its dryRun test seeds `roundFrom` and joins this list as `seedPayRules`.
- Change:
  - The route pulls `rounding` (`!!v`), `roundGraceMin` (clamped to 0–30, rounded) and `roundStepMin` (one of 1, 5, 10, 15, 30, otherwise 422) out of the body.
  - If any of those are present, it computes `payRules: appendPayRule(getSettings(db).payRules, {rounding?, graceMin?, stepMin?}, ymd(clock()))`.
  - The rest of the body goes through `validateSettings`.
  - A body containing `roundFrom` gets 422 `"Pay rule changes start today; past weeks stay as they are"`. A body containing `payRules` gets 422 (history is only written by this route or by a backup import).
  - It all runs in one `change(req, 'Update settings', …)` call that touches `settings/payRules`, so the change is undoable.
- Test first (`admin.settings.test.js`; `fakeClock(d(2026,10,31,12))`; `seedPayRules(db, [R0])`; employee Ann; roster for Ann on 2026-10-27 and 2026-10-31, CAFE 09:00–17:00; shifts through `POST /api/admin/shifts` at 09:08–17:00 on both days):
  - `changing grace on 2026-10-31 does not re-price the 2026-10-27 shift`:
    - Capture `c27 = calcAll(loadData(db), clock()).get(id27)` (expect `paidIn 9:15`, `lateMin 8`, `late true`).
    - `PUT /api/admin/settings {roundGraceMin:10}` returns 200.
    - `/state.settings.payRules` deep-equals `[R0, {from:'2026-10-31', rounding:true, graceMin:10, stepMin:15}]`.
    - `calcAll(...).get(id27)` deep-equals `c27`.
    - `calcAll(...).get(id31).paidIn === d(2026,10,31,9)` and `.late === false`.
  - `roundFrom is refused`: `PUT {roundFrom:'2026-10-26'}` returns 422 matching `/past weeks/i`. `PUT {payRules:[]}` returns 422. `payRules` is unchanged afterwards.
  - `undo restores the previous rule history`: after the PUT, `POST /undo` makes `payRules` deep-equal `[R0]`.
  - `Start late check from today`: with `seedPayRules(db, [])`, `PUT {rounding:true}` gives `payRules` equal to `[{from:'2026-10-31', rounding:true, graceMin:6, stepMin:15}]`, and the 2026-10-27 shift stays unmatched (`paidIn 9:08`).
  - `the same save twice adds nothing`: two identical `PUT {roundGraceMin:10}` calls leave `payRules.length === 2`.
- Run: `node --disable-warning=ExperimentalWarning --test test/admin.settings.test.js` and then `npm test` (the updated suites)
- Depends on: Tasks 29, 30

### Task 32: Backups carry `payRules`; legacy v3 backups convert
- Files: `src/backup.js` (`cleanSettings`), `test/backup.import.test.js` (update lines 62 and 76)
- Change:
  - If `st.payRules` is an array, validate it through `validateSettings`. If it is invalid, fall back to the legacy keys.
  - If there is no `payRules` array, use `{ payRules: legacyPayRules(st) }`.
  - Export needs no change, because `payRules` is in `DEFAULT_SETTINGS` and is exported automatically. The format stays `v: 3`.
- Test first:
  - `legacy v3 backup rounding becomes one rule`: import settings `{rounding:true, roundFrom:'2026-10-26', roundGraceMin:6, roundStepMin:15}`. `getSettings(db).payRules` deep-equals `[R0]`. With `roundFrom:null` it is `[]`.
  - `rule history survives export → import`: `seedPayRules` with two entries, then `exportBackup`, then `importBackup` into a fresh database, and the history deep-equals the original.
  - `invalid payRules with legacy keys falls back to them`: `payRules:[{...R0, stepMin:7}]` together with the legacy keys gives `[R0]`.
- Run: `node --disable-warning=ExperimentalWarning --test test/backup.import.test.js`
- Depends on: Task 30

### Task 33: Settings → Pay rules UI and "Start late check" (from today)
- Files: `public/app.js` (lines 482, 484, 495, 508, 541, 691–696, 893–894, 1147), `test/ui.roster.test.js` (line 54)
- Change:
  - The form keeps the On/Off, Grace and Step fields. Their values come from `Pay.ruleFor(st, Date.now())`, falling back to the defaults.
  - The `roundFrom` date input is removed. Under the form, a read-only `<ul class="pay-rules">` lists each entry as "from <date>: on/off · grace X min · steps Y min", with the note "Changes apply from today; earlier shifts keep their pay."
  - Submitting sends `{rounding, roundGraceMin, roundStepMin}` only.
  - Line 482: the `UNROSTERED` tag shows when `Pay.ruleFor(db().settings, sh.in)?.rounding` is true.
  - Lines 484, 495 and 508 use `c.late`.
  - Line 541: the "Start late check" button shows when `!Pay.ruleFor(s.settings, Date.now())?.rounding`.
  - Lines 893–894: the confirm text is "Start late check from today?" and the request is `{ rounding: true }`.
- Test first (`ui.roster.test.js`; the line 54 `has('name="roundFrom"')` check is replaced):
  - `assert.doesNotMatch(js, /name="roundFrom"|settings\.roundGraceMin|settings\.roundFrom/)`
  - `has('Pay.ruleFor(')`, `has('class="pay-rules"')`, `has('c.late')`, `has('Start late check from today?')`
- Run: `node --disable-warning=ExperimentalWarning --test test/ui.roster.test.js`
- Depends on: Task 31
- Also update the README "Roster and pay rounding" section (line 50 onwards): changes take effect from the day they are saved, and earlier shifts keep their pay. Run `test/readme.test.js` afterwards.

## Decisions from the user (2026-10-31)
1. Kiosk security: "Leave as it is". There is no enrollment, allow-list or global limit, and the per-IP lockout (5 tries / 30 s, behind `TRUST_PROXY=1`) stays.
2. Past weeks: "Keep past weeks frozen". Tasks 27–33 (Release B) implement this.

## Deferred (needs user decision)
- **Kiosk PIN brute force: device enrollment, IP allow-list or a global failure limit.** The user chose to leave this as it is (2026-10-31). The remaining risk: someone using many IP addresses could guess a 4-digit PIN over time and clock that employee in or out, or see their name and hours. The audit log records every punch.
- **Task 13, `PUT /api/admin/roster/batch` (atomic roster save with one undo entry).** This is a new endpoint, and keeping the deploys small matters more. Today's save works one cell at a time, and a partial save is rare and visible. If it returns, its dryRun test moves to `seedPayRules` (see Task 31).
- **Task 14, "Save roster" using the batch endpoint.** It depends on Task 13.
- **Task 15, kiosk identify and punch loading only nearby data.** There is no measurable slowness at about 5.5k shifts a year, and it changes the hot kiosk path, so it is not worth the deploy risk now.
- **Task 23, removing the theme dead code.** It is harmless; it would touch about ten files and tests for no user-visible gain.
- **Task 24, removing the `otApproved` dead code.** It is harmless; the `ot_ok` column stays either way.
- **Task 25, removing `role`.** Editing an employee still blanks the role. Role is used only by the employee search and by roster-import creation, so the impact is minor; fix it with Task 23 in a cleanup release.
- **`/state` ships every shift.** Fixing it needs paging and a date-range design in the admin UI; at about 5.5k shifts a year it is not urgent.
- **Whole-database `calcAll` in the admin roster re-price checks (`routes/roster.js:23`, `roster-import.js:75`).** Admin-only and rare. Revisit with the `/state` item.
- **Capping audit rows in backups.** Not needed after Task 10 (25 MB is years of headroom), and capping would lose history on restore.
- **The exceljs → uuid advisory.** Do not run `npm audit fix --force` (it downgrades exceljs). An `overrides` entry is untested against exceljs, so wait for an exceljs release.
- **A CSP header.** The UI loads Google Fonts and uses inline `<style>` and `style=` attributes, so it would need `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com`. That gives little value (no user-written HTML) and could break the kiosk if something was missed. Do it later, with a browser smoke test on the tablet.

## Libraries/frameworks involved (for context7-modernizer)
- `node:sqlite` (`DatabaseSync`, `PRAGMA foreign_keys`, `foreign_key_check`, `integrity_check`, `legacy_alter_table` behaviour of `ALTER TABLE … RENAME`, `VACUUM INTO ?` with a bound parameter): Tasks 1, 2, 4, 7, 21, 27, 30
- Express 5.3 (`express.json({ limit })` per mount path, 413 error shape): Task 10
- `node:crypto` (`randomInt`) and Web Crypto `crypto.getRandomValues` in the browser: Task 18
- `node:test` and `supertest` 7.3: all tests
- pdfkit 0.20 (only the inputs to `payslipDays` change): Task 17
- exceljs 4.4 (`safeText` also feeds the xlsx export): Task 11
- Railway CLI (`railway ssh`) and Railway service settings (replicas, variables, custom start command, redeploying an earlier deployment): the runbook

## Pay diff script (one-off; lives in the scratchpad, never committed)
File: `C:\Users\MCS\AppData\Local\Temp\claude\c--Users-MCS-TimeClock\398e4c4f-731b-447f-a583-48b1e91e75dc\scratchpad\pay-diff.mjs`. It uses Node built-ins only.

- **Inputs:** `node --disable-warning=ExperimentalWarning pay-diff.mjs <oldTree> <newTree> <oldDb> <newDb> [--since 2026-10-26]`.
  - `<oldTree>` is a `git worktree add <scratch>/tc-old <deployed-commit>` of the code that is live now: `0c91a37` for Release A, or the Release A commit for Release B.
  - `<newTree>` is the working tree.
  - `<oldDb>` is the untouched live copy.
  - `<newDb>` is a second copy that the new code has migrated (runbook step b).
- **How it works:**
  - Each side dynamically imports its own `src/db.js`, `src/repo.js` and `src/shared/pay.js` (through `pathToFileURL`), opens its database with `openDb` (never `migrate`), and runs `loadData`.
  - Both sides use one fixed `now`: the time the live copy was taken, so open shifts compare equally.
- **Shift report (CSV):**
  - It compares `calcAll(old)` against `calcAll(new)` for every shift id and lists each shift whose `paidIn`, `paidOut` or `paid` differs (more than 1e-9 h).
  - Columns: employee, date, clock in, clock out, the rostered entry the old code matched, old paid in–out and hours, new paid in–out and hours, and the difference in hours and in dollars (difference × rate1).
  - Each row is classed **expected-R3** when the old code matched a roster entry and `sh.out <= S` for that entry (the shift ended before its rostered start). Every other difference is classed **UNEXPECTED**.
- **Week report (CSV):** for every Monday from `--since` to the current week, it compares `week(data, ws, now)` per employee for `paid`, `gross` and `net`. A differing employee-week is **expected** only if all of that employee's differing shifts in that week are expected-R3.
- **Exit code:** 1 if there is any UNEXPECTED row, otherwise 0.
  - Release A expects only expected-R3 rows.
  - Release B expects **zero** differences.
- **Output:** the expected-R3 rows go into the owner's release note ("Which past shifts changed"). Afterwards, run `git worktree remove` on the old tree and delete the copies.

## Deploy runbook (do every step for Release A, and again for Release B)
**(a) Take off-box copies, the same day, before any change.**
1. Minimum: in Admin, use **Download backup** (JSON) and save `timeclock_backup_YYYY-MM-DD.json` on the PC.
2. Get a consistent database file as well:
   - `railway link` to the TimeClock service, then run `railway ssh`. Inside the container, run `node -e "new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH).prepare('VACUUM INTO ?').run('/tmp/offbox.db')"`. If `DB_PATH` is not set, use the path from the startup log line `Database: …`. Writing to `/tmp` keeps the copy off the volume.
   - From the PC: `railway ssh -- base64 -w0 /tmp/offbox.db > live.b64`, then `base64 -d live.b64 > live-YYYYMMDD.db` (Git Bash), then `railway ssh -- rm /tmp/offbox.db`.
   - If the installed CLI cannot run a one-off command, run `base64 -w0 /tmp/offbox.db` in the interactive session and save its output to `live.b64` (for example by logging the session).
   - Check the copy locally: `PRAGMA integrity_check` is `ok`, and its employee and shift counts equal those in the JSON backup.
   - Keep both files somewhere other than the PC's working folder (for example a USB stick or the owner's cloud drive).

**(b) Rehearse on the live copy.**
1. Make two copies: `live-old.db` (never opened by the new code) and `live-new.db`.
2. Run `TZ=Australia/Sydney DB_PATH=<scratch>/live-new.db BACKUP_DIR=<scratch>/bk PORT=3100 npm start`. Expect `Pre-migration snapshot: …timeclock-premigrate-v2-…db` (or `v3` for Release B) and `Time Clock running`. Then stop it.
3. Check the Definition of done for this release and run the pay diff script.
4. **Release A:** any problem with the rebuild (a migration error, a non-empty `foreign_key_check`, `integrity_check` not `ok`, a row count change, or an UNEXPECTED diff) means switching to the `fixed_rate` fallback and repeating (b).
5. **Release B:** any diff at all, or `payRules` not equal to `[R0]`, means no deploy.

**(c) Deploy after the café closes.** First check that nobody is on shift (the dashboard shows 0 on shift and 0 on break). Then take a fresh JSON backup (step a.1) right before pushing. A restart during opening hours would fail kiosk punches.

**(d) Check Railway service settings before pushing.**
- Replicas = 1, with a single deployment attached to the volume. There must be no overlapping old and new containers on the volume.
- Variables: `TZ=Australia/Sydney` and `TRUST_PROXY=1`. Also confirm the `DB_PATH` and `BACKUP_DIR` values.

**(e) Smoke test after the deploy (on the café tablet).**
- The Railway logs show the pre-migration snapshot line, with no errors.
- The owner clocks in with their own code, waits a minute and clocks out. Afterwards, delete that test shift on the Shifts page (the delete is audited).
- Open the Weekly report for this week and last week; the totals match the step (b) rehearsal.
- **Release B only:** Settings → Pay rules lists `from 26/10/2026 · on · grace 6 min · steps 15 min`.

**(f) Restore (only if (e) fails or the pay looks wrong).**
1. Note any punches made since the deploy: the restore loses them, so re-enter them by hand.
2. Stop the app while keeping the volume mounted. In Railway → service → Settings → Deploy, set a **Custom Start Command** of `sleep infinity` and redeploy.
3. Run `railway ssh`, then `cp "$(dirname "$DB_PATH")"/timeclock-premigrate-vN-YYYY-MM-DD-HHMMSS.db "$DB_PATH" && rm -f "$DB_PATH-wal" "$DB_PATH-shm"`. Use N = 2 to undo Release A, or N = 3 to undo Release B. Removing the WAL and SHM files matters, because a stale WAL must not be replayed over the restored file.
4. Clear the custom start command, and in Deployments redeploy the **previous commit**.
5. Check the startup log and the weekly report.
6. If the premigrate file is missing or damaged, start the old commit on an empty database and restore the off-box JSON with Admin → Import backup.
7. A quicker alternative to steps 2 and 3: set `DB_PATH` to the premigrate file's path and redeploy the previous commit.
8. Both releases can also be undone by just redeploying the previous commit, without restoring, if the data is fine:
   - Release A code ignores v3 (`user_version` 3 is above its migration count, and the new CHECK only adds a value).
   - Release A code reads the untouched legacy rounding rows on v4.
   - Rule changes made under Release B are not visible to Release A code.

## Definition of done
**Both releases**
- Every task's new test was seen red, then green (guard tests green both times).
- `npm test` passes in full.
- `git diff --stat` shows no change to the root `index.html` (the `static` and `config` tests also check this).
- Runbook steps (a)–(e) are done, and the owner release note has been sent.

**Release A (rehearsed on `live-new.db`)**
- The log shows `Pre-migration snapshot: …timeclock-premigrate-v2-…db`, and `PRAGMA user_version` is 3.
- `PRAGMA foreign_key_check` is empty, `integrity_check` is `ok`, and no `sqlite_master` entry mentions `employees_new`.
- The row count of every table equals `live-old.db`.
- The pay diff script exits 0. Every per-employee `paid`, `gross` and `net` figure for every week since 2026-10-26 matches the old code, apart from rows marked expected-R3.

**Release B (rehearsed on a copy of the Release A live database)**
- `PRAGMA user_version` is 4.
- `settings.payRules` is `[{"from":"2026-10-26","rounding":true,"graceMin":6,"stepMin":15}]`, and the four legacy rows are still present.
- The pay diff script (Release A code against Release B code) reports **zero** differences, for both shifts and weeks, since 2026-10-26.

## Risks
- **The employees rebuild on the live database (Task 2).** Mitigations: the pre-migration snapshot, the off-box copies, the foreign-key and integrity checks inside the transaction, rollback on any error, a populated-database test, and a full rehearsal on the live copy. Any problem in that rehearsal triggers the `fixed_rate` fallback.
- **Concurrent access during the migration.** It runs at startup before `listen()`, so there is only one connection. Runbook (d) confirms a single replica.
- **The R3 matching change alters pay** for already-worked shifts that ended before their roster start. Those were paid $0, which is wrong, so this is the intended correction. The diff script lists every one of them for the owner.
- **The restore loses punches made after the deploy.** That is why deploys happen after close and a JSON backup is taken just before.
- `pre-*` snapshots are never pruned. Erase and import are rare, but the files are full database copies.
- Task 10 moves `requireAdmin` before body parsing. That is intended, but any admin route that read `req.body` inside middleware mounted before it would break. None exist today.
- **A pay-rule change applies to the whole of today (Release B).** Following the user's "effective from today", shifts already worked earlier today are re-priced by a same-day change. Every earlier day stays frozen.
- **"Today" and "clock-in date" use the server's local date.** Railway must keep `TZ=Australia/Sydney` (runbook d).
- **Tests that seeded `roundFrom` through the API must move to `seedPayRules`** (they are listed in Task 31). Any test that is missed will fail loudly with a 422, not silently.

## Owner release note (template; fill in and send after each deploy)
> **Time Clock update: <date>**
>
> *Release A*
> - **"Fixed rate" pay now saves properly.** Before, it quietly reverted to "Hourly". Pay was still right, because both rates were the same. Please open **Employees** and set "Fixed rate" again for: <names, or "anyone who should have it">.
> - **Some past shifts were paid $0 by mistake and are now paid.** This happened when a shift finished before the rostered start time (for example a morning shift on a day rostered for the afternoon). The affected shifts now pay the time actually worked:
>   | Employee | Day | Worked | Was paid | Now paid | Difference |
>   |---|---|---|---|---|---|
>   | <from the pay diff script> | | | 0:00 | <h:mm> | +$<x> |
>   If a payslip for one of those weeks has already gone out, you may want to send a corrected one.
> - **A safety copy is now saved automatically** before **Import backup** or **Erase all data**. It is a file named `timeclock-pre-import-…db` or `timeclock-pre-erase-…db` in the backups folder.
> - Smaller fixes: changing the admin PIN signs out other devices; "Email all payslips" skips staff with no pay that week; mid-week payslips no longer show the rest of the week as ABSENT; overtime is only flagged when overtime is paid.
>
> *Release B*
> - **Changes to the late or rounding rules now apply from the day you save them.** Shifts worked before that day keep the pay they already had. Settings → Pay rules shows the history of changes. "Start late check" now starts today.

## Questions for the user
None. Both questions were answered on 2026-10-31 (see "Decisions from the user").

## Build status (Release A)
- [x] Tasks 1–12, 16–22, 26 implemented test-first (each new test seen red, then green). `npm test`: 244/244 pass.
- [ ] Release B (Tasks 27–33): not started — after Release A has run cleanly for two working days.
- [ ] Runbook (a)–(f) and pay-diff on a copy of the live database: before the Release A deploy.
