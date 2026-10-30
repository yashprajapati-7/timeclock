# Plan: Roster, roster-based pay rounding, richer employees, emailed payslips, colourful admin

## Goal
Bring the separate GJ 06 Roster app into the Time Clock as a new admin **Roster** tab stored in our SQLite database, and use the roster to work out **paid** start and finish times. Inside ±6 min of the rostered time, pay snaps to the rostered time. A late start rounds up to the quarter hour. An early start is paid from the rostered start. Raw punches are never changed. Employees gain pay type (hourly or fixed weekly salary), email, phone, role, birthday, start date and recurring weekly allowances and deductions. Payslip PDFs can be emailed (through the Brevo HTTPS API) one at a time or to everyone. "Gross" leaves the report screen and the exports, and the payslip keeps it. The dashboard reminds the admin of birthdays and work anniversaries 7 days ahead. The admin area gets a token-based colour system, while the kiosk stays black and white. The kiosk itself is unchanged apart from showing today's rostered shift(s).

*Revised after gstack-leader review (GO WITH CHANGES) and context7-modernizer findings. Changelog at the end of this file.*

### What the code does today (read before planning)
- `src/migrations.js`: one migration (`user_version = 1`). `employees.pin TEXT NOT NULL UNIQUE CHECK(length(pin)=4)`. `shifts` has `clock_in`/`clock_out` (epoch ms) and its breaks live in `breaks`. `adjustments` are one-off per week (`week_start|emp_id`).
- `src/shared/pay.js` (shared by browser and server): `shift(sh, st, now)` → `{total, actual, policy, ded, paid, open}`. `week(data, ws, now)` adds tiers `h1/h2`, `p1/p2`, `gross`, `allow`, `deduct`, `net`. A shift belongs to the day and week it **starts** in. All dates are server/browser **local time** (`new Date(y,m,d)`). The browser imports the same file from `/shared/pay.js`.
- `src/undo.js`: per-session before/after row images for `employees`, `shifts`, `adjustments`, `settings`. `restore.employees` hard-codes the column list.
- `src/backup.js`: format `v: 2`. `normalizeBackup` accepts v1/v2.
- `src/reports/model.js` builds a single report that feeds `xlsx.js` (Payroll/Shifts/Adjustments sheets, `PAYROLL_HEADER` has `Gross`) and `pdf.js` (payroll table has a `Gross` column, payslip has a `Gross` line).
- `public/app.js`: one page with `Kiosk` and `Admin`. `Admin.tabs` is a list. Views are `html` templates. Actions are delegated through `data-act`. Report sort keys include `gross`. The browser payroll CSV (`Actions.exportReport`) includes Gross. `public/index.html` holds all CSS: `--ink/--paper/--muted/--soft/--warn`, light/dark via `prefers-color-scheme` + `[data-theme]`.
- Tests: node:test + supertest, 132 passing. UI is tested through API sequences (`test/ui.flows.test.js`) and source assertions (`test/mobile.test.js`, `test/static.test.js`).

### What the roster source does (read-only clone, `index.html` + `server.js`)
- Data is one JSON blob: `employees [{id:number, name, role}]`, `shifts {'YYYY-MM-DD_<empId>': [entry…]}`, where an entry is `{type:'shift', category:'CAFE'|'BAKERY', start:'HH:MM', end:'HH:MM'}`, `{type:'TRAINING', start, end}` or `{type:'OFF'|'DELIVERY'|'BAKE'|'BAKERY YC'}` (no times).
- UI: weekly grid staff × Mon–Sun, tap a cell to open a bottom sheet. The sheet has presets (OFF, DELIVERY, BAKE, BAKERY YC), "Add shift" (category + start/end typed as `9.30` + AM/PM), "Save as training", a list of current entries with ✕, and Clear. Copy week → next week overwrites only target cells that have a source entry. Clear week. Overview tab (total staff, total hours, busiest day, days off, hours per person, daily breakdown). Shift calculator. jsPDF landscape week PDF with logo.
- Colours: CAFE `#EFF8F3`/`#1A5C36`, BAKERY and BAKERY YC `#FCE7F3`/`#9D174D`, TRAINING `#EDE9FE`/`#5B21B6`, DELIVERY `#FFF3E0`/`#B45309`, BAKE `#FEF9EE`/`#92400E`, OFF `#E8E8E8`/`#777`.
- Break rule (`breakMins`): <4h 0, <5h 15, <7h 30, <10h 60, else 90. This is **identical** to our default `breakRules [{4,15},{5,30},{7,60},{10,90}]`, so we use `settings.breakRules` through `policyBreak` with no visible change.
- **Date-key bug, verified against live data:** `fd(d) = d.toISOString().slice(0,10)` turns local midnight into a UTC date. East of UTC (the app uses `en-AU`), every key is therefore **one day early**. Live data: 1134 keys from **2026-08-16 (a Sunday) to 2026-11-07 (a Saturday)**, which is exactly 12 Sun–Sat blocks, while the grid is Mon–Sun. So the key `2026-08-16_1` is really **Monday 17 Aug**. 16 staff. 25 cells have 2 entries and the rest have 1. No overnight shifts. No orphan keys. Start times run 05:00–19:30.

## Chosen approach (and why) / Rejected alternatives

### Approach A (CHOSEN): roster as relational rows in SQLite; "paid span" computed in shared `pay.js` at calculation time
- **Storage:** migration 2 adds a `roster` table (one row per entry: `emp_id`, `day` = real local date, `type`, `start_hm`, `end_hm`, `position`) and new employee and shift columns through `ALTER TABLE ADD COLUMN`. Raw punches are untouched.
- **Pay rules:** `pay.js` gains pure functions: `rosterSpan`, `matchRoster` and `paidSpan`. `shift()` takes an optional match and returns the existing fields plus `paidIn/paidOut/span/lateMin/earlyMin/capped/roster`. A new `calcAll(data, now)` returns a `Map(shiftId → calc)` and is used by `week()`, the report model, the kiosk and the browser views. Because the browser imports the same module, the UI, xlsx, pdf and payslips agree by construction.
- **Recurring allowances/deductions:** a JSON column `fixed_items` on `employees` (`[{type,label,amount,from,to}]`). Undo and backup then cover them automatically through the employee row image.
- **Email:** the **Brevo** transactional HTTPS API (`POST https://api.brevo.com/v3/smtp/email`) via the built-in `fetch`, behind a small `src/mail.js` `createMailer(env, { fetch })` that is injected into `createApp({ mailer })`. No new dependency, no SMTP (Railway blocks outbound SMTP below Pro). Tests use a fake `fetch` only.
- **Kiosk codes for imported staff:** keep `pin NOT NULL UNIQUE`. The importer **generates** unused random 4-digit codes and shows them in the import result and the audit log. Rebuilding `employees` to allow a NULL pin would mean a table rebuild with `foreign_keys=ON` and RESTRICT children (shifts), which is a high risk on the live Railway DB for no real benefit.
- **Why:** smallest change that keeps a single source of truth. Every number flows through `pay.js`. Raw times stay auditable. The roster reuses the existing undo/audit/backup machinery.

### Approach B (rejected): store paid in/out on the shift row at punch time
- Pros: simple reads, and reports would not need roster lookups.
- Cons: a roster edit after the fact (very common: "she was actually rostered 9:30") would not re-price the shift. Admin shift edits would need re-derivation. Two sources of truth (raw vs stored paid) could drift, and backups/undo would carry derived data.
- Risk: silent pay errors when the roster changes after a punch.

### Approach C (rejected): keep the roster app separate and read it over HTTP (or embed it in an iframe)
- Pros: no data migration.
- Cons: pay would depend on another service being up. The UTC key bug stays. There is no audit/undo and no auth on the old API (anyone can PUT). Reports could not be reproduced offline. The user asked to include the roster in our code.

### Sub-decisions
- **Roster `type` flattened:** `shift/CAFE` → `CAFE` and `shift/BAKERY` → `BAKERY`. Then `TRAINING`, `OFF`, `DELIVERY`, `BAKE`, `BAKERY YC`. Only CAFE/BAKERY/TRAINING have times (CHECK constraint).
- **Roster PDF:** server-side with pdfkit (`GET /api/admin/export/roster.pdf?week=`), drawn with the existing `table()` helper style plus coloured cells. No jsPDF or CDN.
- **Roster import:** pure `src/roster-import.js` (`planImport(source, db) → plan`, `applyImport(db, plan)`), exposed via `POST /api/admin/roster/import` (with `dryRun`). There is no CLI. The server fetches only the configured URL (`ROSTER_IMPORT_URL`, default `https://roster-production-3522.up.railway.app/api/roster`), never an admin-typed URL (no SSRF). A JSON file upload works too. The browser cannot fetch the old app because it sends no CORS headers.
- **Colour:** CSS custom-property tokens, scoped to `#app.admin`. Each tab sets `--accent` via `data-tab`. Shift-type and status tokens have light and dark values. The kiosk markup never gets the `.admin` class, so it stays black and white.

## Pay rounding rules (exact spec; `pay.js` implements this, tests encode it)
Settings (new, validated, editable under Settings → Pay rules): `rounding: true`, `roundGraceMin: 6`, `roundStepMin: 15`, `roundFrom: null` (a Monday `YYYY-MM-DD`).
Constants: `MATCH_EARLY_MIN = 120`.

0. **Effective date:** rounding applies only to shifts whose **raw clock-in ≥ local midnight of `roundFrom`**. `roundFrom = null` means rounding is not yet in effect anywhere. Shifts before `roundFrom` are paid at actual times exactly as today, even when a matching roster entry exists. When the admin turns rounding on in Settings, the UI pre-fills `roundFrom` with next Monday. Past payroll therefore never re-prices silently.

Times are compared in **whole minutes** (seconds truncated: 9:06:59 counts as 9:06). "Quarter" means local clock quarters (:00/:15/:30/:45) with the step `roundStepMin`.

1. **Which roster entry:** candidates are the employee's **timed** entries (CAFE/BAKERY/TRAINING) on the clock-in's local day and the day before and after. Each one becomes an epoch span `S = atLocal(day, start_hm)`, `E = atLocal(day, end_hm)`, or `E = atLocal(day + 1, end_hm)` when `end_hm <= start_hm` (overnight). E is always built from **local wall-clock**, never `S + duration`, so DST changes are handled. A candidate qualifies if `S − 120 min ≤ in < E`. Pick the qualifying entry whose `S` is **nearest** the clock-in (tie → earlier `S`). **Early-clock-in gap fallback:** if nothing qualifies but the employee has a timed entry on the clock-in's local day with `in < S − 120 min` (and therefore `in < E`), match the first such entry (by `S`), so the shift is paid from `S` under rule 3. If there is still no match while the employee has timed entries that day, the shift is tagged **OFF-ROSTER** (actual times) and raises a `med` anomaly. Each entry is used by at most one *chain* of shifts: if an employee clocks out and back in inside the same entry, both shifts match it. The **first** shift gets the start rule, the **last** gets the finish rule, and the ones in between use actual times. That prevents paying the 9:00 start twice.
2. **No match** (no roster that day, only OFF/DELIVERY/BAKE/BAKERY YC, OFF-ROSTER, `rounding=false`, `roundFrom` unset or after the clock-in): paid = actual, exactly today's behaviour. This keeps all existing tests and history green.
3. **Start** (rostered `S`, grace `g=6`):
   - `S−g ≤ in ≤ S+g` → paid from `S`.
   - `in < S−g` (early) → paid from `S` (no early pay).
   - `in > S+g` (late) → `ceil` to the next quarter: 9:07→9:15, 9:08→9:15, 9:15→9:15, 9:16→9:30, 9:20→9:30, 9:40→9:45. `lateMin = in − S`. Tag **LATE**.
4. **Finish** (rostered `E`):
   - `E−g ≤ out ≤ E+g` → paid until `E`.
   - `out > E+g` (stayed late) → **ASSUMPTION: paid until `E`** (`capped = out − E` minutes, tag **OVER +Nm**) **unless** the shift has `otApproved` (admin ticks "Approve overtime" in the shift dialog). Approved → actual `out` **floored** to the quarter.
   - `out < E−g` (left early) → **ASSUMPTION: actual `out` floored to the quarter** (16:40→16:30). `earlyMin = E − out`. Tag **EARLY**.
   - Open shift (no `out`): the same rules with `now`. Live paid hours stop growing at `E` unless approved.
5. `paidOut < paidIn` → span 0 (clamped). Break deduction on the **paid span**, per `breakMode`: **policy** → `policyBreak(spanHours)`. **actual** → actual break minutes that fall **inside** `[paidIn, paidOut]` (each break clipped to the span). **greater** → `max(policy, actual-inside-span)`. In every mode the deduction is capped at `spanMin`. `paid = span − ded`. (With no match, span = raw shift, so this equals today's formula.) `total` stays the **actual** worked time, so admins see "Worked 7:40 · Paid span 7:30".
6. Day and week assignment still follow the **raw** clock-in (unchanged).
7. Mid-shift breaks are counted as today (actual minutes inside the shift).

Summary for the README: *"Close to the roster (±6 min) snaps to the roster. Anything else is rounded in 15-minute steps: starts round up, finishes round down. Early starts and unapproved overtime are paid from/to the rostered time."*

## Assumptions (defaults chosen; leader please review)
1. **Clock-out more than 6 min after the rostered end:** paid until the rostered end. The admin approves overtime per shift (`otApproved`), and approved overtime is paid to the actual finish floored to the quarter. Unapproved overtime is flagged on the Shifts page and the dashboard so it is not missed.
2. **Clock-out more than 6 min early:** actual finish rounded **down** to the quarter.
3. **No timed roster entry that day:** actual times, no rounding. An "UNROSTERED" tag shows in the Shifts table only (no alert). If the employee **does** have timed entries that day but the shift matches none of them (e.g. clocks in after the last entry's end), it is tagged **OFF-ROSTER** and raises a `med` anomaly.
4. **Multiple entries in a day:** the nearest start wins, within the window `S−120min ≤ in < E`. A split shift (9–13 and 17–21) therefore matches correctly. A clock-in more than 120 min early still matches that day's entry (fallback in rule 1), so 6:30 for a 9:00 roster is paid from 9:00.
5. **Overnight entries:** `end ≤ start` means the shift finishes the next day. A clock-in at 23:56 for a 00:00 start matches through the "day after" candidate.
6. **Roster dates in the old app are one day early** (UTC bug, evidence above). The import uses **`offsetDays = +1` by default**, which the admin can override (`offsetDays` in the API). The choice is persisted in `settings.rosterImport = { offsetDays, idMap: { <sourceId>: empId } }`, and re-runs reuse both. Detection stays only as a dry-run **WARNING**, based on the weekday distribution of *all* source keys: if the key weeks look Mon-aligned rather than Sun-aligned, it says "offset +1 may be wrong". The dry run shows the first mapped entries ("Mon 17 Aug · AKA · CAFE 10:00–17:00") so the admin can confirm before applying.
7. **Import idempotency:** for each source cell (staff × day), the target cell is **replaced** with the source entries, and cells that are not in the source are untouched. Source staff are resolved via the persisted `idMap` first and by name second, so renaming an employee here does not create a duplicate. Running it again changes 0 cells and creates 0 staff. The import is one undoable action ("Import roster") and is audited. The dry run returns `changedCells`, `pastDayCells` (changed cells dated before today) and `repricedShifts` (existing shifts whose paid times would change).
8. **Missing staff on import:** created **active** with a generated unique random code (never `0000`), `role` from the source, hourly, no rate, and recorded in `idMap`. The existing "has no pay rate set" alert then prompts the admin. The codes are returned in the import result (shown once in a dialog) and are visible under Employees → Show codes. Names (for staff not yet in `idMap`) match case-insensitively with whitespace collapsed. If two of our employees have the same name, that staff member is reported as ambiguous and skipped.
8a. **Past-day roster changes:** any roster edit, copy, clear or import that touches days before today counts the existing shifts whose paid times change. The API returns `repriced: N`, the audit detail gets the suffix `(past: re-prices N shifts)`, and the UI asks for confirmation first when the dry count `N > 0` (the routes accept `dryRun: true` to return the count without writing).
9. **Salary:** `payType='salary'` pays `weeklySalary` per week. Hours are still tracked and shown, and the Rate 1/2 tiers are not used (`p1=p2=0`). The salary is paid in every week where the employee is **active**, or has shifts or adjustments, and `startDate` (if set) is on or before the week's end. Changing the salary changes the history of past weeks, the same as rate changes do today (existing behaviour).
10. **Fixed (recurring) items:** `{type, label, amount, from, to?}`, where `from`/`to` are week-start Mondays. They apply to weeks `from ≤ ws ≤ to` **only when the employee has paid hours > 0 that week or is salaried**. That way a holidaying hourly worker is not paid a $10 allowance for a week with no pay. "Remove" in the UI sets `to` = last week when the item has already applied, or deletes it if it never applied. Past payslips therefore do not change.
11. **Gross:** removed from the Weekly Report screen (column + sort), the browser payroll CSV, the xlsx Payroll sheet and the PDF payroll table. Its slot becomes a **Salary** column (blank for hourly staff). The **payslip keeps** a "Gross pay" line, which is needed to explain net pay. `pay.week` still computes `gross` (= base pay) for the payslip and totals.
12. **Birthdays/anniversaries:** stored as full dates. The dashboard "Coming up" card lists everything from today to +7 days (birthday: no age shown, for privacy; anniversary: "3 years"). A 29 Feb birthday falls on 28 Feb in non-leap years. A start date in the future, or anniversary year 0, is not listed. Reminders are admin-only; the kiosk shows no birthday greeting.
13. **Email (Brevo):** one PDF per employee (the existing `payslipsPdf(rep, [id])`). Subject `"<Company> payslip <weekStart> – <weekEnd>"`, with a body naming the week and net pay, sent as both `textContent` and a minimal-HTML `htmlContent`. Employees without an email are skipped and reported. Sends are sequential. One audit row per attempt ("Email payslip", `name · week · sent (messageId) | failed: reason`). Env: `BREVO_API_KEY`, `MAIL_FROM`, optional `MAIL_FROM_NAME`, `MAIL_REPLY_TO`. `configured = BREVO_API_KEY && MAIL_FROM`. When it is not configured: `503 {error:'Email is not set up: set BREVO_API_KEY and MAIL_FROM'}`, and the UI disables the buttons. Configuration is reported through `state.mailConfigured`. The key is read only from env, never logged, never stored in the DB or backups. Only one "email all" per week can run at a time (409 otherwise).
14. **Timezone:** as in the previous plan, days are **server local time**. Railway has `TZ=Australia/Sydney` set. `/api/admin/state` returns `tz: { name, offsetMin }`. The dashboard still shows a **high** alert if this differs from the browser's offset, as a guard against the setting being lost.
15. **Roster grid rows:** active employees, plus inactive employees with entries that week, sorted by name. At most **4 entries per cell**. Entries in a cell are not checked against each other for overlap (the source does not do this either).
16. **Roster time entry:** the source's shorthand is kept for speed and muscle memory: `9.30` + AM/PM, where `9.5` means 9:50 as in the source. 24-hour `17:00` is also accepted. This becomes a pure `parseShortTime` in `format.js`.
17. **Roster PDF:** company name heading, no logo (the source's 107 KB base64 logo is not ported; it can be added later).
18. **Old roster service** is left alone: we only send GET requests.
19. A **snapshot is taken before pending migrations run** on an existing DB file and written to `path.dirname(config.dbPath)` (same volume as the DB; the path is logged), so migration 2 on the live Railway volume has a ready rollback.
20. **Rounding effective date:** `roundFrom` starts as `null`, so deploying this changes no pay at all until the admin chooses a Monday.

## Questions for the user
None open. The earlier questions are resolved: email goes through the Brevo HTTPS API (no SMTP), and Railway has `TZ=Australia/Sydney`, `DB_PATH=/data/timeclock.db`, `BACKUP_DIR=/data/backups`. The owner should confirm the rounding policy against their award (see Risks: Fair Work).

## Data model changes (migration 2)
```sql
ALTER TABLE employees ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'hourly' CHECK(pay_type IN ('hourly','salary'));
ALTER TABLE employees ADD COLUMN weekly_salary REAL;
ALTER TABLE employees ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN birthday TEXT;          -- YYYY-MM-DD
ALTER TABLE employees ADD COLUMN start_date TEXT;        -- YYYY-MM-DD (anniversary)
ALTER TABLE employees ADD COLUMN fixed_items TEXT NOT NULL DEFAULT '[]';  -- JSON [{type,label,amount,from,to}]
ALTER TABLE shifts ADD COLUMN ot_ok INTEGER NOT NULL DEFAULT 0;
CREATE TABLE roster (id INTEGER PRIMARY KEY,
  emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                                     -- real local date YYYY-MM-DD
  type TEXT NOT NULL CHECK(type IN ('CAFE','BAKERY','TRAINING','OFF','DELIVERY','BAKE','BAKERY YC')),
  start_hm TEXT, end_hm TEXT, position INTEGER NOT NULL,
  CHECK((type IN ('CAFE','BAKERY','TRAINING')) = (start_hm IS NOT NULL AND end_hm IS NOT NULL)));
CREATE INDEX roster_day_emp ON roster(day, emp_id);
```
Legacy shapes: an employee becomes `{…, role, payType, weeklySalary, email, phone, birthday, startDate, fixedItems}`, a shift becomes `{…, otApproved}`, and `data.roster = {'YYYY-MM-DD|empId': [{id,type,start,end}]}` (mirrors `data.adj`). `pay.js` treats a missing `data.roster` as `{}`.

## API additions
| Method & path | Body / query | Result |
|---|---|---|
| `GET /api/admin/state` | — | + `roster`, `tz`, `mailConfigured` |
| `PUT /api/admin/roster/:empId/:day` | `{entries:[{type,start?,end?}], dryRun?}` (`[]` clears) | `{ok, repriced}`; undo "Edit roster" |
| `POST /api/admin/roster/copy-week` | `{week, dryRun?}` | `{copied, repriced}`; undo |
| `POST /api/admin/roster/clear-week` | `{week, dryRun?}` | `{cleared, repriced}`; undo |
| `POST /api/admin/roster/import` | `{dryRun, offsetDays?, data?}` (no `data` → fetch `ROSTER_IMPORT_URL`) | dry: `{offsetDays, warning?, sample, toCreate, matched, skipped, changedCells, pastDayCells, repricedShifts}`; apply: `+ created:[{name,pin}], repriced` |
| `GET /api/admin/export/roster.pdf` | `?week=` | PDF |
| `POST /api/admin/payslips/email` | `{week, emp:'all'|id}` | `{results:[{empId,name,status,messageId?,error?}]}`; 409 if an email-all for that week is running |
| `GET /api/admin/payslips/email-status` | `?week=` | `{lastSentAt, lastSentCount, running}` (from audit + lock) |
| `POST /api/kiosk/identify` | — | + `roster:[today's entries]` |

## Tasks
Conventions: every test command is `node --disable-warning=ExperimentalWarning --test test/<file>.test.js`. "Red first" means the named test is written and run before the change, and fails for the stated reason. Full-suite check: `npm test`.

### Phase A — Schema & data access

### Task 1: Migration 2 (schema)
- Files: `src/migrations.js`, `test/db.test.js`, `test/snapshot.test.js`
- Change: append the migration 2 SQL above. Update `user_version` expectations 1 → 2 (`db.test.js` lines 14 and 20, `snapshot.test.js` line 22) to `migrations.length`.
- Change (runner): `migrate` must run each migration inside `db.tx` (it does today) so a failing statement mid-script is ROLLED BACK. Make `migrate(db, list = migrations)` accept the list for testing. ALTER ADD COLUMN rules: NOT NULL only with a constant DEFAULT, no UNIQUE/PK, CHECK only with a valid default.
- Test first: `test/db.test.js` → new `migration 2 upgrades a v1 database with data`: build a DB with only `migrations[0]` applied, insert an employee + shift, run `migrate`, assert `user_version === 2`, the employee has `pay_type='hourly'`, `fixed_items='[]'`, `email=''`, the shift has `ot_ok=0`, the `roster` table exists, and inserting `('OFF','09:00','17:00')` and `('CAFE',NULL,NULL)` both throw (CHECK). Also `roster rows cascade when employee deleted`. Also `a failing migration leaves user_version unchanged and no partial table` (`migrate(db, [m0, 'CREATE TABLE x(a); SELECT nope_fn();'])` throws, `user_version` stays 1, table `x` is absent, and the db is not left inside an open transaction: a following `db.tx` works).
- Run: `node --disable-warning=ExperimentalWarning --test test/db.test.js`
- Depends on: none

### Task 2: Snapshot before pending migrations
- Files: `src/db.js` (export `pendingMigrations(db)`), `src/server.js`
- Change: in `server.js`, if `pendingMigrations(db) > 0` and the file is not `:memory:` and `employees` already exists → `snapshotBeforeMigrate(db, path.dirname(config.dbPath), now)`, which writes `timeclock-premigrate-v<from>-<ymd>-<HHMMSS>.db` on the **DB's own volume** (`/data` on Railway) and logs the path. Keep the name out of the `SNAPSHOT` regex so `prune` never deletes it. Then `migrate`. `VACUUM INTO` must run **outside** any transaction (before BEGIN), using a bound parameter `db.raw.prepare('VACUUM INTO ?').run(target)` rather than string escaping, and the target must not exist (the timestamp suffix ensures that; refuse if it does).
- Test first: `test/snapshot.test.js` → `pendingMigrations counts and premigrate snapshot is not pruned`: a temp file DB at v1 → `pendingMigrations === 1`. `snapshotBeforeMigrate(db, path.dirname(file), now)` → the file exists next to the DB, opens, and has `user_version 1`. `prune(dir, 0)` leaves it in place. A second call in the same second throws instead of overwriting.
- Run: `node --disable-warning=ExperimentalWarning --test test/snapshot.test.js`
- Depends on: 1

### Task 3: Repo — employee fields
- Files: `src/repo.js` (`toEmp`, `createEmployee`, `updateEmployee`)
- Change: map `role, payType, weeklySalary, email, phone, birthday, startDate, fixedItems` (JSON parse/stringify; bad JSON → `[]`).
- Test first: `test/repo.basic.test.js` → `employee round-trips new fields`: create with `{payType:'salary', weeklySalary:800, email:'a@b.co', phone:'0400 000 000', birthday:'1999-11-02', startDate:'2024-11-04', role:'Barista', fixedItems:[{type:'allowance',label:'Phone',amount:10,from:'2026-10-26'}]}`, then `getEmployee` deep-equals it. Old-style create (no new fields) → defaults (`payType:'hourly'`, `fixedItems:[]`, `email:''`).
- Run: `node --disable-warning=ExperimentalWarning --test test/repo.basic.test.js`
- Depends on: 1

### Task 4: Repo — roster CRUD
- Files: `src/repo.js`
- Change: `listRoster(db, {from, to}?)` → map `'day|empId' → [{id,type,start,end}]` ordered by position. `getRosterCell(db, empId, day)`. `replaceRosterCell(db, empId, day, entries)` (delete + insert with positions, in `db.tx`, returns `{removedIds, addedIds}`). `rosterRowIdsInRange(db, fromDay, toDay)`. `loadData` adds `roster`.
- Test first: `test/repo.roster.test.js` (new) → `replace cell, list map, clear with []`: replace with 2 entries → `listRoster` has key `'2026-10-26|e1'` with 2 entries in order; replace with `[]` → key gone; `loadData(db).roster` present.
- Run: `node --disable-warning=ExperimentalWarning --test test/repo.roster.test.js`
- Depends on: 1

### Task 5: Repo — shift `otApproved`
- Files: `src/repo.js` (`attachBreaks`, `saveShift`)
- Change: read and write `ot_ok` ↔ `otApproved` (boolean, default false).
- Test first: `test/repo.shifts.test.js` → `otApproved persists and defaults false`.
- Run: `node --disable-warning=ExperimentalWarning --test test/repo.shifts.test.js`
- Depends on: 1

### Task 6: Validate — employee
- Files: `src/validate.js` (`validateEmployee`)
- Change: `payType ∈ {hourly,salary}` (default hourly). With salary, `weeklySalary` must be a number ≥ 0 and is required. Email is optional and loose (`/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`, trimmed, lower-cased). Phone is optional (`/^\+?[\d\s()-]{6,20}$/`, trimmed). Birthday/startDate are optional real dates (`YYYY-MM-DD` round-trip like `parseWeekParam`), and the birthday must not be in the future. Role is optional, ≤ 40 chars. `fixedItems`: an array ≤ 20 of `{type allowance|deduction, label 1–60, amount > 0, from Monday, to? Monday ≥ from}`.
- Test first: `test/validate.test.js` → `employee: pay type, contact, dates, fixed items` (valid case normalises email case; `'salary'` without salary → throws "Weekly salary"; `'bob@'` → throws "Email"; `'12'` phone → throws; `'2026-02-30'` → throws; fixed item with `from:'2026-10-27'` (Tuesday) → throws "Monday").
- Run: `node --disable-warning=ExperimentalWarning --test test/validate.test.js`
- Depends on: none

### Task 7: Validate — roster entries and settings
- Files: `src/validate.js` (`validateRosterEntries`, `validateSettings`), `src/repo.js` (`DEFAULT_SETTINGS` + `rounding:true, roundGraceMin:6, roundStepMin:15, roundFrom:null, rosterImport:null`; `rosterImport` is server-managed: not in the Settings form, rejected by `validateSettings`, but kept in backups)
- Change: entries is an array ≤ 4. Timed types need `HH:MM` 00:00–23:59 with `start !== end`. Untimed types drop any times. Unknown type → 422. Settings: `rounding` is a boolean, `roundGraceMin` is clamped 0–30, `roundStepMin` must be one of 1, 5, 10, 15, 30, and `roundFrom` is `null` or a real Monday `YYYY-MM-DD`.
- Test first: `test/validate.test.js` → `roster entries` and `rounding settings`. `[{type:'CAFE',start:'9:00',end:'17:00'}]` → throws (not HH:MM); `[{type:'OFF',start:'09:00'}]` → `[{type:'OFF'}]`; 5 entries → throws; `{roundStepMin:7}` → throws; `{roundFrom:'2026-11-03'}` (Tuesday) → throws "Monday"; `{roundFrom:'2026-11-02'}` → ok; `{roundFrom:null}` → ok; `{rosterImport:{}}` → throws "Unknown setting".
- Run: `node --disable-warning=ExperimentalWarning --test test/validate.test.js`
- Depends on: none

### Phase B — Shared pay rules (`src/shared/*`, pure, browser-safe)

### Task 8: Format helpers
- Files: `src/shared/format.js`
- Change: `atLocal(ymdStr, hm)` → epoch of the local date/time. `floorMin(ts)` (drop seconds). `ceilStep(ts, step)` / `floorStep(ts, step)` on local wall-clock minutes. `parseShortTime(str, meridiem)` (port of `parseDecimalTime`, plus `HH:MM` 24h). `nextOccurrence(mmdd, now)` helper for anniversaries.
- Test first: `test/format.test.js` → `rounding helpers` (`ceilStep(9:08)=9:15`, `ceilStep(9:15)=9:15`, `floorStep(16:40)=16:30`, `floorMin(9:06:59)=9:06`) and `parseShortTime` (`'9.30','AM'→'09:30'`, `'9.5','PM'→'21:50'`, `'12','AM'→'00:00'`, `'17:00'→'17:00'`, `'13','PM'→null`).
- Run: `node --disable-warning=ExperimentalWarning --test test/format.test.js`
- Depends on: none

### Task 9: `rosterSpan` + `matchRoster`
- Files: `src/shared/pay.js`
- Change: `rosterSpan(entry, day)` → `{S: atLocal(day, start), E: atLocal(end <= start ? day+1 : day, end)}` (local wall-clock, never `S + duration`). `matchRoster(empShifts, rosterMap, empId, st)` → `Map(shiftId → {entry, S, E, first, last} | {offRoster: true})`, following rule 1 (window, nearest start, early-clock-in fallback, chains, OFF-ROSTER).
- Test first: `test/pay.roster.test.js` (new) → `match: nearest entry, window, early fallback, split shift, chain, overnight, off-roster`. Cases: roster 9–17, in 8:30 → matched. **In 6:30 → matched by the fallback** (paid from 9:00 is asserted in Task 10). Split 9–13 and 17–21, in 16:50 → the 17:00 entry. Two shifts 9:01–12:00 and 12:30–17:02 → both match, the first has `first`, the second has `last`. Roster 22:00–06:00, in 21:58 → E is the next day 06:00. Roster 9–13 only, in 14:00 → `offRoster`. Roster only OFF → none (not offRoster). **DST** goes in a dedicated `test/pay.dst.test.js`, because node:test runs each file in its own process. Its first line sets `process.env.TZ = 'Australia/Sydney'`, and it then loads `pay.js`/`format.js` via `await import()`, since static imports are hoisted. It asserts `Intl.DateTimeFormat().resolvedOptions().timeZone === 'Australia/Sydney'` and otherwise skips with a message. Cases: an overnight entry on 2027-04-03 22:00–06:00 (DST ends 04-04 03:00) → `E === atLocal('2027-04-04','06:00')` and `E − S === 9 h` (not 8). An entry 2026-10-04 01:00–09:00 (DST starts at 02:00) → `E − S === 7 h`.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.roster.test.js test/pay.dst.test.js`
- Depends on: 8

### Task 10: `paidSpan` — start rules
- Files: `src/shared/pay.js`
- Change: `paidSpan(sh, match, st, now)` → `{paidIn, paidOut, lateMin, earlyMin, capped}` (start part of rule 3).
- Test first: `test/pay.roster.test.js` → `start rounding table` (roster 9:00, `roundFrom` before the test week; in → paidIn): 8:54→9:00, 9:06→9:00, 9:06:59→9:00, 9:07→9:15 (late 7), 9:08→9:15, 9:15→9:15, 9:20→9:30, 9:40→9:45, 8:30→9:00, **6:30→9:00** (early fallback), and `rounding:false` → actual.
- Run: same file
- Depends on: 9

### Task 11: `paidSpan` — finish rules, OT approval, clamp
- Files: `src/shared/pay.js`
- Change: rule 4 + rule 5.
- Test first: `test/pay.roster.test.js` → `finish rounding table` (roster end 17:00): 16:55→17:00, 17:06→17:00, 17:25→17:00 `capped 25`, 17:25 + `otApproved`→17:15, 16:40→16:30 `earlyMin 20`, open shift at now 18:00→17:00. Very late in 16:50 with out 16:52 → span 0. Overnight 22:00–06:00 out 06:04 → 06:00. **DST** (in `test/pay.dst.test.js`): overnight 2027-04-03 22:00–06:00 with in 22:00 and out 06:03 → paidOut `=== atLocal('2027-04-04','06:00')` and span 9 h. Shift 2026-10-04 01:00–09:00 rostered the same → span 7 h.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.roster.test.js test/pay.dst.test.js`
- Depends on: 10

### Task 12: `shift()` uses the paid span; `calcAll`
- Files: `src/shared/pay.js`
- Change: `shift(sh, st, now, match)` adds `paidIn, paidOut, span, lateMin, earlyMin, capped, offRoster, roster` (entry or null). Break deduction on the span per `breakMode` (rule 5): policy → `policyBreak(span)`, actual → break minutes clipped to `[paidIn, paidOut]`, greater → max of the two; always capped at span. `paid = span − ded`. The match is ignored (actual times) when `!st.rounding`, when `st.roundFrom` is null, or when `sh.in < atLocal(st.roundFrom, '00:00')`. `calcAll(data, now, {from,to}?)` → Map for all shifts in the range (groups per employee, calls `matchRoster`).
- Test first: `test/pay.roster.test.js` → `shift with roster: 9:20–17:30 rostered 9–17 → total 8:10, span 7:30, ded 60 (policy), paid 6:30, lateMin 20, capped 30`. `break modes on paid span`: same shift with a 12:00–12:40 break plus a 9:10–9:25 "break" partly before paidIn 9:30 → **policy** ded 60. **actual** ded 40 (the early break lies outside the span and counts 0). **greater** ded 60. A 2:00 span with a 3:00 actual break → ded capped at 120. `roundFrom gate`: the same shift and roster with `roundFrom` = the following Monday → deep-equals the result of `shift()` with no roster at all; `roundFrom: null` → the same. `test/pay.shift.test.js` already exists unchanged (no match → identical numbers) and must stay green.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.roster.test.js test/pay.shift.test.js`
- Depends on: 11

### Task 13: `week()` — roster-aware paid hours, late counts
- Files: `src/shared/pay.js`
- Change: `week` uses `calcAll` for its range (plus ±1 day of roster). The row adds `late` (count) and `lateMin` (sum).
- Test first: `test/pay.week.test.js` → `week uses rounded paid hours`: `tierFixture` + roster 9–15 on all 5 days + `roundFrom` = that Monday, with a 9:10 clock-in on day 1 → `paid` drops by 0:15 relative to the fixture (27.25), `late === 1`. `week before roundFrom is unchanged`: the same data with `roundFrom` = the next Monday → the row deep-equals the no-roster row (27.5, `late 0`). The existing `tier split` test (no roster) stays at 27.5.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.week.test.js`
- Depends on: 12

### Task 14: `week()` — salary + fixed items
- Files: `src/shared/pay.js` (`week`, `totals` keys add `salary`)
- Change: `base = payType==='salary' ? weeklySalary : p1+p2`, `gross = base`, `salary` field. Fixed items apply per assumption 10 (`fixed: [...]` on the row). `allow`/`deduct` include fixed + one-off. Respect `startDate` for salary.
- Test first: `test/pay.week.test.js` → `salary pays fixed weekly amount regardless of hours` (salary 800, 3 h worked → p1=p2=0, gross 800, net 800, paid 3). `fixed items apply in range and only with pay` (allowance 10 from this week → net +10. Week before `from` → no allowance. Hourly employee with 0 h → no allowance. Item with `to` = last week → not applied this week). `salary not paid before startDate`.
- Run: same file
- Depends on: 13

### Task 15: Upcoming birthdays/anniversaries
- Files: `src/shared/pay.js` (`upcoming(employees, now, days = 7)`)
- Change: returns a sorted `[{empId,name,kind:'birthday'|'anniversary',date,inDays,years?}]` for active employees.
- Test first: `test/pay.upcoming.test.js` (new) → today counts as `inDays 0`. Birthday 7 days ahead is included, 8 days is not. Anniversary "2 years". A start date this week (0 years) is excluded. A 29 Feb birthday shows on 28 Feb 2027. Year wrap (now 28 Dec, birthday 2 Jan → inDays 5).
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.upcoming.test.js`
- Depends on: 8

### Task 16: Roster hours overview + anomalies
- Files: `src/shared/pay.js` (`rosterWeek(data, ws)` → per employee `{days:[h…], total, offDays}` + per-day staff counts, using `policyBreak` on day totals; `anomalies` adds `low` "X is salaried but has no weekly salary", `med` "X stayed N min past rostered end (not paid)" for capped shifts this week with `shiftId`, and `med` "X clocked in off-roster on <day>" for `offRoster` shifts with `shiftId`. `anomalies` uses `calcAll` for the week.)
- Test first: `test/pay.roster.test.js` → `rosterWeek hours use break rules` (CAFE 10:00–17:00 = 7h → 6h, two entries 9–13 + 17–21 = 8h → 7h, OFF counted in offDays, per-day staff count). `test/pay.anomalies.test.js` → `flags salaried without salary, unpaid overtime and off-roster clock-in`.
- Run: `node --disable-warning=ExperimentalWarning --test test/pay.roster.test.js test/pay.anomalies.test.js`
- Depends on: 12, 14

### Phase C — Server

### Task 17: Undo — generic employee restore, roster table, shift flag
- Files: `src/undo.js`
- Change: `restore.employees` builds the upsert from `Object.keys(row)` (no hard-coded columns). Add `snap.roster`/`restore.roster` (by id). The created-employee conflict check also refuses when untouched `roster` rows reference that employee. `shifts` restore keeps `otApproved` via `saveShift`.
- Test first: `test/undo.test.js` → `undo restores new employee fields`, `undo roster cell edit`, `undo employee create refuses when roster rows were added later`.
- Run: `node --disable-warning=ExperimentalWarning --test test/undo.test.js`
- Depends on: 3, 4, 5

### Task 18: Admin routes — employees, state, erase
- Files: `src/routes/admin.js`, `src/app.js` (ctx gains `mailer`, `fetch`)
- Change: POST/PUT employees pass the new fields. DELETE employee touches roster rows before cascade. `/state` adds `roster`, `tz: {name: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMin: -new Date(now).getTimezoneOffset()}` and `mailConfigured` (= `mailer.configured`, i.e. `BREVO_API_KEY && MAIL_FROM`; the key itself never appears in state). Erase deletes `roster`.
- Test first: `test/admin.employees.test.js` → `create/edit employee with salary, contact, fixed items; 422 on bad email`. `test/ui.flows.test.js` (existing state-shape test) → update the expected keys to `['adj','employees','mailConfigured','roster','settings','shifts','tz','undoLabel']`.
- Run: `node --disable-warning=ExperimentalWarning --test test/admin.employees.test.js test/ui.flows.test.js`
- Depends on: 6, 17

### Task 19: Admin routes — shift `otApproved`
- Files: `src/routes/admin.js` (`checkedShift`), `src/validate.js` (`validateShift` passes `otApproved: !!b.otApproved`)
- Test first: `test/admin.shifts.test.js` → `PUT shift with otApproved changes paid via state` (roster 9–17, shift 9:00–17:30. Before: paid span to 17:00. After the approve PUT: span to 17:30).
- Run: `node --disable-warning=ExperimentalWarning --test test/admin.shifts.test.js`
- Depends on: 12, 18

### Task 20: Roster routes — edit cell
- Files: `src/routes/roster.js` (new, mounted at `/api/admin/roster` in `app.js` behind `requireAdmin`)
- Change: `PUT /:empId/:day` validates the employee exists and the day is a real date, then `validateRosterEntries`, `replaceRosterCell` inside `undo.run` (touch old ids, created new ids). Shared helper `repricedCount(db, before, after, days)` (in `src/routes/roster.js`): for days before today, compares `calcAll` paid in/out of the affected employees' shifts before and after the change and returns N. `dryRun: true` → `{repriced}` without writing. Audit: `"Edit roster", "AKA · Mon 26 Oct: CAFE 09:00–17:00"`, plus ` (past: re-prices N shifts)` when the day is before today and N > 0. The response is `{ok, repriced}`.
- Test first: `test/admin.roster.test.js` (new) → `PUT cell, read back in state, undo restores`; `404 unknown employee`; `422 bad day '2026-13-01'`; `401 without session`; `past-day edit reports repriced count and audits it` (shift yesterday 9:08–17:00, `roundFrom` set, PUT a 9:00–17:00 cell with `dryRun` → `repriced 1` and nothing written; then real PUT → audit detail ends `(past: re-prices 1 shifts)`); `future-day edit → repriced 0, no suffix`.
- Run: `node --disable-warning=ExperimentalWarning --test test/admin.roster.test.js`
- Depends on: 4, 7, 17

### Task 21: Roster routes — copy week / clear week
- Files: `src/routes/roster.js`
- Change: copy: for each cell in week `ws`, replace the same employee's cell at `+7 days` (source semantics: empty source cells leave the target alone). Clear: delete all rows in the week. Both are single undoable actions and audited with counts, with the ` (past: re-prices N shifts)` suffix when the affected days include past days and N > 0. Both support `dryRun` and return `repriced`. `week` must be a Monday.
- Test first: `test/admin.roster.test.js` → `copy-week copies only filled cells and is undoable`, `clear-week removes the week only`, `clear-week on the current week with a rounded past shift reports repriced 1 (dryRun writes nothing)`.
- Run: same file
- Depends on: 20

### Task 22: Roster import core (pure)
- Files: `src/roster-import.js` (new), `test/fixtures/roster-sample.json` (new: ~3 staff and ~10 keys taken from the live shape, including a 2-entry cell, a BAKERY shift, an OFF, and keys laid out in Sun–Sat blocks like the live data)
- Change: `offsetDays` = explicit override ?? `settings.rosterImport.offsetDays` ?? **+1**. `offsetWarning(keys, offsetDays)` looks at the weekday distribution of **all** keys (per 7-day block: which weekday starts the blocks of contiguous keys). If the blocks start on Monday while `offsetDays = 1` (or on Sunday while it is 0), it returns a warning string. It is only a warning and never changes the offset. `planImport(src, {employees, roster, shifts, settings, now}, {offsetDays})` resolves each source staff member via `settings.rosterImport.idMap[sourceId]` (if that employee still exists), then by normalised name. It returns `{offsetDays, warning?, firstDay, lastDay, matched:[{srcId, srcName, empId}], toCreate:[{srcId, name, role}], ambiguous:[], skipped:[{key, reason}], cells:[{empId|newIndex, day, entries}], changedCells, pastDayCells, repricedShifts, sample:[…5 lines]}`. `repricedShifts` = existing shifts whose `calcAll` paid in/out differs after applying the cells. Type mapping `shift/CAFE→CAFE`. Validation goes through `validateRosterEntries` (bad → skipped). `applyImport(db, plan, {now, pinGen})` creates employees with unique random codes (excluding used + `0000`), replaces cells, and persists `settings.rosterImport = {offsetDays, idMap}` (merged with the existing idMap).
- Test first: `test/roster.import.test.js` (new) → `default offset +1 maps '2026-08-16_1' to '2026-08-17'`, `override offset 0 is used and persisted`, `warning when keys are Monday-aligned with offset +1; none for the fixture`, `maps names case-insensitively and plans creations`, `generated codes are unique 4-digit and not 0000` (seeded `pinGen`), `second apply changes 0 cells (idempotent)`, **`after renaming an imported employee, a re-run creates 0 staff and changes 0 cells`** (via idMap), `ambiguous duplicate names are skipped`, `dry-run reports pastDayCells and repricedShifts` (existing past shift 9:08 + `roundFrom` set → `repricedShifts 1`).
- Run: `node --disable-warning=ExperimentalWarning --test test/roster.import.test.js`
- Depends on: 4, 7

### Task 23: Roster import route
- Files: `src/routes/roster.js` (`POST /import`), `src/config.js` (`rosterImportUrl` from `ROSTER_IMPORT_URL`)
- Change: with no `data`, call `await ctx.fetch(rosterImportUrl, {signal: AbortSignal.timeout(10000), redirect: 'error'})`. A non-`res.ok` response → 502. Read the body as text with a **5 MB cap** (stream reader, abort beyond it → 502 "Roster data too large"), then `JSON.parse` and check the shape (`employees` array, `shifts` object). Any fetch failure (`TypeError: fetch failed`, `TimeoutError`) → 502 "Could not reach the old roster app". `dryRun` → plan summary only. Otherwise `applyImport` inside `undo.run('Import roster')` + audit `"N cells, M new staff"` plus ` (past: re-prices N shifts)` when N > 0. The response includes `created` and `repriced`. There is no CLI.
- Test first: `test/admin.roster.test.js` → `import dry-run uses injected fetch and changes nothing` (the fake fetch asserts `redirect: 'error'` and a signal), `import applies, returns created codes, persists rosterImport, undo removes them`, `502 when fetch throws`, `502 on non-ok status`, `502 when body exceeds 5 MB`, `uploaded data is used without fetching`.
- Run: `node --disable-warning=ExperimentalWarning --test test/admin.roster.test.js`
- Depends on: 20, 22

### Task 24: Kiosk — today's roster; roster-aware hours
- Files: `src/routes/kiosk.js`, `src/punch.js`
- Change: identify returns `roster` (today's entries for that employee only). `todayPaid`/`weekPaid` use `calcAll`. `punch` computes its `calc` through the roster match (loads that employee's shifts and roster ±1 day), so the clock-out toast's "PAID" figure matches the admin pages. The response shape is otherwise unchanged. There is no birthday flag and no late toast. The kiosk response still describes only that employee.
- Test first: `test/kiosk.api.test.js` → `identify shows today's roster entries`, `identify never includes other employees' roster`, `punch out calc.paid uses the rounded span` (fake clock, roster 9–17, `roundFrom` set, in 9:08, out 17:20 → `calc.paid` = 7:45 span − 60 policy = 6:45).
- Run: `node --disable-warning=ExperimentalWarning --test test/kiosk.api.test.js`
- Depends on: 12, 20

### Task 25: Report model
- Files: `src/reports/model.js`
- Change: rows add `payType, salary, base, fixed, late, lateMin`. Shift rows add `paidIn, paidOut, span, lateMin, capped, earlyMin, rosterLabel`. Calcs come from `calcAll`.
- Test first: `test/report.model.test.js` → `model exposes salary, fixed items and paid in/out` (one salaried, one hourly late shift).
- Run: `node --disable-warning=ExperimentalWarning --test test/report.model.test.js`
- Depends on: 13, 14

### Task 26: Excel — Gross → Salary, paid times
- Files: `src/reports/xlsx.js`
- Change: `PAYROLL_HEADER`: `'Gross'` → `'Salary'` (salary or blank). Allowances/Deductions include fixed items. The Shifts sheet adds `Paid in`, `Paid out`, `Late min`, `Over min (unpaid)` (autoFilter range updated). The Adjustments sheet lists fixed items with Type `allowance (fixed)` / `deduction (fixed)`.
- Test first: `test/report.xlsx.test.js` → `payroll header has no Gross and has Salary`, `shifts sheet shows paid in/out for a rounded shift`, `fixed items listed`.
- Run: `node --disable-warning=ExperimentalWarning --test test/report.xlsx.test.js`
- Depends on: 25

### Task 27: PDF — payroll without Gross, payslip lines
- Files: `src/reports/pdf.js`
- Change: payroll table `Gross` → `Salary`. Payslip summary: salaried staff get `Weekly salary` instead of the tier lines; then `Gross pay`, fixed items (`+ Phone (fixed)`), one-off adjustments, NET. The timesheet table adds a `Paid` in/out column ("9:15 LATE").
- Test first: `test/report.pdf.test.js` → render with `compress:false` and assert the text contains `Salary` and not `Gross` for the payroll; the payslip contains `Gross pay`, `Weekly salary` and `(fixed)`.
- Run: `node --disable-warning=ExperimentalWarning --test test/report.pdf.test.js`
- Depends on: 25

### Task 28: Roster PDF + route
- Files: `src/reports/pdf.js` (`rosterPdf(model)`), `src/reports/model.js` (`buildRosterWeek(data, ws)` using `rosterWeek`), `src/routes/exports.js` (`GET /roster.pdf`)
- Change: A4 landscape, staff × Mon–Sun grid. Cells are filled with the type background colours (light palette) and use short labels like the source (`9A–5P`, `Bakery 5A–1P`, `TRN`, `DEL`, `BAKE`, `BKY YC`, `OFF`), plus an hours column and a per-day staff count row. Audit "Export roster pdf". pdfkit details: per cell draw `rect().fill(bg)` first, then `doc.fillColor(fg)` before every `text()`, and reset to `#000` afterwards. Clip long chip labels with `doc.save().rect(x,y,w,h).clip()` … `doc.restore()`. Compute rows per page and call `addPage()` manually (repeat the header row). In tests, text is checked with `compress:false`; fill colours appear as `sc`/`scn` operators, not `rg`.
- Test first: `test/report.pdf.test.js` → `roster pdf lists staff and entries` (uncompressed text has the names, `OFF`, `9A`). `test/exports.api.test.js` → `GET roster.pdf 200 application/pdf, 400 on bad week, 401 without session`.
- Run: `node --disable-warning=ExperimentalWarning --test test/report.pdf.test.js test/exports.api.test.js`
- Depends on: 16, 20

### Task 29: Mailer module (Brevo HTTPS API only; no new dependency)
- Files: `src/mail.js` (new)
- Change: `createMailer(env, { fetch = globalThis.fetch } = {})` → `{configured, send({to, toName?, subject, text, attachments:[{filename, content: Buffer}]})}`. `configured = !!(env.BREVO_API_KEY && env.MAIL_FROM)`. `send` POSTs `https://api.brevo.com/v3/smtp/email` with headers `api-key: <key>`, `content-type: application/json`, `accept: application/json`, and `signal: AbortSignal.timeout(15000)`. Body: `{sender:{email: MAIL_FROM, name?: MAIL_FROM_NAME}, to:[{email, name?}], subject, textContent, htmlContent: <minimal HTML wrapping the escaped text>, attachment:[{name, content: buf.toString('base64')}] (no data: prefix), replyTo?: {email: MAIL_REPLY_TO}}`. Success = **201** → returns `{messageId}`. Any other status: read the body as text, try `JSON.parse` for `{code, message}`, throw `MailError('failed: <message || status>')`. `TypeError: fetch failed` → `'failed: network error'`. `TimeoutError` → `'failed: timed out'`. Not configured → `send` throws `HttpError(503, 'Email is not set up: set BREVO_API_KEY and MAIL_FROM')`. The key is never logged or included in an error message.
- Test first: `test/mail.test.js` (new), fake `fetch` only → `not configured without BREVO_API_KEY or MAIL_FROM`. `send posts to Brevo with api-key, sender, to and a PDF attachment` (asserts the URL, the `api-key` header, `sender.email`, `to[0].email`, `attachment[0].name`, and that `Buffer.from(attachment[0].content,'base64')` starts with `%PDF`, plus `htmlContent` and `textContent` present and the timeout signal passed). `201 returns messageId`. `400 {message:'Sender not valid'} → error 'failed: Sender not valid'`. `non-JSON 500 body → 'failed: 500'`. `fetch TypeError → 'failed: network error'` and `TimeoutError → 'failed: timed out'`. `error text never contains the api key`.
- Run: `node --disable-warning=ExperimentalWarning --test test/mail.test.js`
- Depends on: none

### Task 30: Email payslip routes + double-send guard
- Files: new `src/routes/mail.js` mounted at `/api/admin/payslips` behind `requireAdmin`, `src/app.js`, `src/server.js` (`createApp({ mailer: createMailer(process.env) })`)
- Change: `POST /api/admin/payslips/email {week, emp}`. Not configured → 503 before any work. For `emp:'all'`, take an **in-memory lock per week** (`Set` in the router closure, released in `finally`). A second email-all for the same week while one is running → **409** "Payslips for this week are already being sent". For each target row: no email → `skipped`. Otherwise build `payslipsPdf(rep,[id])` and `send`, then write one audit row per attempt: `Email payslip`, `"<name> · <week> · sent (<messageId>)"` or `"… · failed: <reason>"`. Failures do not stop the others. Returns `results`. `GET /api/admin/payslips/email-status?week=` → `{lastSentAt, lastSentCount, running}`, built from the newest `Email payslip` audit rows for that week and the lock.
- Test first: `test/mail.api.test.js` (new) with a fake mailer → `sends one payslip with pdf attachment and audits messageId`, `email all skips staff without email and reports a failure without aborting`, `503 when mailer not configured`, `401 without session`, `concurrent email-all for the same week → second gets 409; a different week is allowed` (the fake `send` awaits a controllable promise), `email-status reports last sent time and count after a send`.
- Run: `node --disable-warning=ExperimentalWarning --test test/mail.api.test.js`
- Depends on: 27, 29

### Task 31: Backup v3
- Files: `src/backup.js`
- Change: `exportBackup` → `v:3`, employees with new fields, shifts with `otApproved`, `roster` map. `normalizeBackup`: v<3 → `roster = {}` and new fields defaulted. Validate roster keys (`YYYY-MM-DD|knownEmpId`) and entries (via `validateRosterEntries`, problems collected) and employee fields (via `validateEmployee`, problems collected rather than thrown). `importBackup` deletes and restores `roster`. Settings `roundFrom` and the server-managed `rosterImport` (`{offsetDays, idMap}`, validated by shape, invalid → dropped) round-trip as well; `cleanSettings` handles `rosterImport` separately because `validateSettings` rejects it. A v1/v2 import gets `roundFrom: null`.
- Test first: `test/backup.import.test.js` → `v3 round-trip keeps roster, fixed items, salary, otApproved` (export → import into a fresh DB → same `week()` numbers and roster). `v1 and v2 fixtures still import` (existing tests stay green). `test/backup.normalize.test.js` → `rejects roster entry for unknown employee`.
- Run: `node --disable-warning=ExperimentalWarning --test test/backup.import.test.js test/backup.normalize.test.js`
- Depends on: 3, 4, 5, 6, 7

### Phase D — UI (`public/app.js`, `public/index.html`)
UI tests follow the existing pattern: API sequences in `test/ui.flows.test.js` plus source/CSS assertions in `test/mobile.test.js`, `test/static.test.js` and a new `test/theme.test.js`. Manual browser check at the end of each task (light, dark, a 375 px width).

### Task 32: Colour tokens + contrast test
- Files: `public/index.html` (CSS), `test/theme.test.js` (new)
- Change: tokens in `:root` and both dark blocks. Tab colours: `--c-dashboard` (blue), `--c-roster` (teal), `--c-report` (green), `--c-shifts` (orange), `--c-employees` (violet), `--c-audit` (slate), `--c-settings` (rose). Type colours `--t-cafe-bg/-fg`, `--t-bakery-*`, `--t-training-*`, `--t-delivery-*`, `--t-bake-*`, `--t-bkyc-*`, `--t-off-*` (light values = the source palette, dark = deep backgrounds with light foreground). Status colours `--s-on`, `--s-break`, `--s-late`, `--s-alert`, `--s-ok`. Admin-only rules are scoped under `#app.admin` (`--accent` set by `#app.admin[data-tab="roster"]{--accent:var(--c-roster)}` …). Borders and shadows stay `var(--ink)`. **Hex tokens are the source of truth** (the contrast test parses them). `color-mix()` may be used only for decoration and always after a plain-hex fallback declaration.
- Test first: `test/theme.test.js` → `every fg/bg token pair has WCAG contrast ≥ 4.5 in light and dark` (parse the hex tokens from the CSS text and compute relative luminance). `kiosk selectors never use colour tokens` (rules for `.kiosk`, `.keys`, `.pins`, `.status`, `.card` contain no `var(--c-`/`--t-`/`--s-`). `each admin tab has an accent token`.
- Run: `node --disable-warning=ExperimentalWarning --test test/theme.test.js`
- Depends on: none

### Task 33: Admin shell uses colours
- Files: `public/app.js` (`Admin.render`, `Admin.tabs` + `roster`, `Kiosk.render`), `public/index.html`
- Change: `app.className = 'admin'` and `app.dataset.tab = ui.tab` in `Admin.render`. Remove them in `Kiosk.render`. Each tab button gets `style="--tab:var(--c-<k>)"` (an accent strip, filled when active). Section `h3`, KPI cards and table headers use `--accent`. Tags: `.tag.on/.break/.late/.over/.alert` use status tokens. New tab order: Dashboard, Roster, Weekly Report, Shifts, Employees, Audit Log, Settings.
- Test first: `test/static.test.js` → `admin tabs include roster and every tab has a colour token` (source includes `['roster','Roster']` and every tab key appears as `--c-<key>` in the CSS). `kiosk render clears admin class` (source contains `app.className = ''` in Kiosk.render or an equivalent assertion).
- Run: `node --disable-warning=ExperimentalWarning --test test/static.test.js`
- Depends on: 32

### Task 34: Roster view — grid
- Files: `public/app.js` (`Views.roster`), `public/index.html` (grid CSS: sticky name column, 7 day columns, horizontal scroll on phones, today column highlighted, coloured chips)
- Change: week nav reused (`weekNav()`). Grid of rows × Mon–Sun with cells `data-act="rosterCell" data-emp data-day` and chips labelled like the source. A per-person **hours column**, a **per-day staff count** footer row and the **week total** (all from `Pay.rosterWeek`). Nothing more: no busiest-day, days-off or daily-breakdown panels. Sticky first column only: the table uses `border-collapse:separate; border-spacing:0`, the first-column cells have a solid background, `left:0`, a `z-index` above other cells, and `position:-webkit-sticky; position:sticky`. There is no `overflow:hidden` between those cells and the `overflow-x:auto` scroller.
- Test first: `test/mobile.test.js` → `roster grid is scrollable and labelled` (source has `class="roster-grid"`, `data-act="rosterCell"`; CSS has `.roster-grid` with `border-collapse:separate`, `position:sticky`, `left:0`, and the `@media (max-width:700px)` rules). `test/ui.flows.test.js` → `roster sequence: PUT cell, state.roster has it, rosterWeek hours match` (API + `rosterWeek` on the state, exactly as the view computes it).
- Run: `node --disable-warning=ExperimentalWarning --test test/mobile.test.js test/ui.flows.test.js`
- Depends on: 16, 20, 33

### Task 35: Roster cell editor (bottom sheet)
- Files: `public/app.js` (`Dialogs.rosterCell`, `Forms.rosterAdd`, `Actions.rosterPreset/rosterDelEntry/rosterClearCell`), CSS for `.sheet` (bottom sheet on phones, modal on desktop)
- Change: current entries listed with ✕. Presets OFF/DELIVERY/BAKE/BAKERY YC. "Add shift": CAFE/BAKERY select + start/end shorthand inputs with AM/PM toggles and a preview "= 7.00h paid (break removed)" using `Pay.policyBreak`. "Add training". "Clear cell". Each change → PUT the whole cell → refresh → undo toast.
- Test first: `test/format.test.js` already covers `parseShortTime` (Task 8). `test/ui.flows.test.js` → `roster cell editor sequence: add CAFE, add OFF, delete one, clear → state matches each step; 422 message shown for 5th entry`.
- Run: `node --disable-warning=ExperimentalWarning --test test/ui.flows.test.js`
- Depends on: 8, 34

### Task 36: Roster actions — copy, clear, PDF, import dialog
- Files: `public/app.js`
- Change: buttons Copy to next week (confirm), Clear week (confirm, typed "CLEAR"), Roster PDF (`downloadFile('/api/admin/export/roster.pdf?week=…')`), Import from old roster (dialog: "Fetch from old app" or "Choose JSON file" → dry-run summary with offset (editable, default +1), any offset **warning**, sample lines, staff to create, skipped, `changedCells`, `pastDayCells`, `repricedShifts` → "Import" → result dialog listing new codes once). For cell edits (Task 35), copy, clear and import: the UI first calls with `dryRun: true`, and if `repriced > 0` asks "This changes past days and re-prices N shifts. Continue?" before the real call.
- Test first: `test/ui.flows.test.js` → `import dialog sequence: dry-run then apply returns created codes` (via `makeTestApp` with an injected fetch returning the fixture). `past-day edit sequence: dryRun returns repriced > 0, then the real call writes`.
- Run: `node --disable-warning=ExperimentalWarning --test test/ui.flows.test.js`
- Depends on: 21, 23, 28, 35

### Task 37: Employees — form, dialog, table
- Files: `public/app.js` (`Views.employees`, `Views.empRows`, `Dialogs.emp`, `Forms.empAdd/empSave`)
- Change: fields Role, Pay type (Hourly/Salary toggle that shows Rate 1/Rate 2 or Weekly salary), Email, Phone, Birthday, Start date. A fixed items editor (rows: type, label, amount, "from week"; Remove = end or delete per assumption 10). The table adds a Pay column ("$800/wk" or "$25 / $30"), Email ✓, and a 🎂 marker when the birthday is within 7 days (text "BDAY" for accessibility). The edit form sends **all** fields (PUT replaces).
- Test first: `test/ui.flows.test.js` → `employee edit sequence keeps fixed items and contact fields across a rename` (PUT name only + the existing fields as the form sends them → the fields persist). `test/mobile.test.js` → `employees table labels` (`data-label="Pay"`, `data-label="Email"`).
- Run: `node --disable-warning=ExperimentalWarning --test test/ui.flows.test.js test/mobile.test.js`
- Depends on: 18, 33

### Task 38: Report — no Gross, salary, late, email buttons, CSV
- Files: `public/app.js` (`Views.report`, `SORTS` without `gross`, `Actions.exportReport`, new `Actions.emailPayslip/emailAll`)
- Change: drop the Gross column/total/sort. Salaried rows show "Salary $800" across the tier cells. Name cell tags `LATE×2`. Row actions: `± Adjust`, `Payslip`, `Email` (disabled with a title if there is no email or `!mailConfigured`). Bottom: "Email all payslips". The confirm dialog shows the recipient count and, from `GET /payslips/email-status`, "Last emailed for this week: <date time> (N sent)" or "Not emailed yet for this week". While sending, the button is **disabled** and shows "Sending…". A 409 response shows "Already sending". Then a results dialog (sent/skipped/failed). Payroll CSV header: Gross → Salary.
- Test first: `test/mobile.test.js` → `report has no Gross` (source has no `th('gross'`, no `data-label="Gross"`, and `SORTS` has no `gross`). `test/ui.flows.test.js` → `email all sequence with fake mailer returns per-employee results and email-status shows last sent` (createApp with a fake mailer). Source assertion: `emailAll` disables its button before the request and re-enables it in `finally`.
- Run: `node --disable-warning=ExperimentalWarning --test test/mobile.test.js test/ui.flows.test.js`
- Depends on: 25, 30, 33

### Task 39: Shifts — actual vs paid, tags, OT approval
- Files: `public/app.js` (`Views.shifts`, `Dialogs.shift`, `Forms.shiftSave`), uses `Pay.calcAll`
- Change: columns In/Out show actual, plus a new "Paid" column `9:15–17:00` with tags `LATE 20m` / `OVER 25m` / `EARLY` / `UNROSTERED`. The shift dialog shows the rostered entry and an "Approve overtime (pay actual finish)" checkbox → `otApproved`. The timeline is unchanged.
- Test first: `test/mobile.test.js` → `shifts table has Paid column label` (`data-label="Paid times"`). `test/ui.flows.test.js` → `shift dialog sequence: approve overtime toggles paid out in state calc`.
- Run: `node --disable-warning=ExperimentalWarning --test test/mobile.test.js test/ui.flows.test.js`
- Depends on: 19, 33

### Task 40: Dashboard — coming up, late today, tz alert
- Files: `public/app.js` (`Views.dashboard`)
- Change: a "Coming up · 7 days" card from `Pay.upcoming` (today highlighted, "in 3 days", anniversary years). KPI "Late today". A high alert when `state.tz.offsetMin !== -new Date().getTimezoneOffset()`. "On the clock now" shows the rostered end and a LATE tag.
- Test first: `test/ui.flows.test.js` → `state exposes tz and upcoming() works on state employees` (birthday tomorrow → listed). `test/mobile.test.js` → source contains `Coming up` and `data-label="Rostered"`.
- Run: `node --disable-warning=ExperimentalWarning --test test/ui.flows.test.js test/mobile.test.js`
- Depends on: 15, 18, 33

### Task 41: Kiosk — today's roster line (stays black/white)
- Files: `public/app.js` (`Kiosk.renderEmp` only)
- Change: one plain-text line under the name: "Rostered today: CAFE 9:00–17:00" (several entries joined with " · "), "OFF today", or "Not rostered today". No toast changes, no birthday greeting, no colour classes.
- Test first: `test/static.test.js` → `kiosk shows roster line without colour tokens` (source includes `Rostered today`, and the Kiosk object has no `--c-`/`--t-`/`--s-` or `tag` usage). The data is covered by `test/kiosk.api.test.js` (Task 24).
- Run: `node --disable-warning=ExperimentalWarning --test test/static.test.js`
- Depends on: 24, 32

### Task 42: Settings — pay rules section
- Files: `public/app.js` (`Views.settings`, `Forms.settingsSave`)
- Change: "Pay rules (roster)" section: Rounding on/off, **"Rounding applies from (Monday)"** date input for `roundFrom` (shows "Not in effect yet" while null; switching rounding on with an empty `roundFrom` pre-fills next Monday; the date picker snaps to Monday), grace minutes, step minutes, and an explanatory example line ("9:08 → paid from 9:15"), computed live with `Pay.paidSpan` so it always matches.
- Test first: `test/ui.flows.test.js` → `settings save rounding fields round-trip incl. roundFrom; roundStepMin 7 rejected; Tuesday roundFrom rejected`. `test/mobile.test.js` → source contains `name="roundFrom"` and `Not in effect yet`.
- Run: `node --disable-warning=ExperimentalWarning --test test/ui.flows.test.js`
- Depends on: 7, 33

### Task 43: README + env docs
- Files: `README.md`
- Change: roster tab and import (offset +1 default, persisted mapping, dry-run warnings and repricing counts), pay rounding rules summary including `roundFrom`, employees fields. Brevo email setup: create an API key, set `BREVO_API_KEY`, `MAIL_FROM` (a **verified sender** in Brevo), and optionally `MAIL_FROM_NAME`, `MAIL_REPLY_TO`. Turn **OFF "Authorised IPs"** for the key (Railway egress IPs change). Deliverability note: a Gmail address as sender can land in spam or be rejected by DMARC, so do a test send to yourself first and use a custom-domain sender with Brevo domain authentication where possible. Env table: `TZ=Australia/Sydney` (set on Railway), `DB_PATH`, `BACKUP_DIR`, `ROSTER_IMPORT_URL`. Pre-migration snapshot location. Backup v3.
- Test first: `test/readme.test.js` → asserts the README mentions `BREVO_API_KEY`, `MAIL_FROM`, `Authorised IPs`, `TZ=Australia/Sydney`, `ROSTER_IMPORT_URL`, `roundFrom`, `±6`, and does **not** mention `SMTP_HOST`.
- Run: `node --disable-warning=ExperimentalWarning --test test/readme.test.js`
- Depends on: 23, 30

### Task 44: End-to-end + full suite
- Files: `test/e2e.test.js`
- Change: a scenario: import the roster fixture through the route with an injected fake fetch → set `roundFrom` to this Monday → set Ann salaried with a fixed allowance, Bob hourly (both with emails) → kiosk: Bob identifies (today's roster entry shown), clocks in 9:08 against a 9:00 roster and out 17:20 → the report model shows paid from 9:15 to 17:00, LATE 1, and the same paid hours as the kiosk `calc.paid` → xlsx Shifts row has paid in 09:15 → "email all" through a mailer built by `createMailer` with a **fake Brevo fetch** sends 2 (each body has a `%PDF` attachment) and audits messageIds → backup export/import keeps everything (incl. `roundFrom`, `rosterImport`) → undo the last roster edit. No CLI, no kiosk toast assertions.
- Test first: write the scenario (red until all prior tasks), then `npm test` all green (132 existing + new).
- Run: `node --disable-warning=ExperimentalWarning --test test/e2e.test.js` then `npm test`
- Depends on: all

## Libraries/frameworks involved (for context7-modernizer)
- **Brevo transactional email API v3** (`POST /v3/smtp/email`, already checked by context7-modernizer: `api-key` header, `sender/to/subject/htmlContent/textContent/attachment[{name, content(base64)}]/replyTo`, 201 `{messageId}`, errors `{code, message}`). No npm package, just the built-in `fetch`.
- **Railway**: outbound SMTP is blocked below Pro (the reason for Brevo HTTPS); `TZ`, `DB_PATH`, `BACKUP_DIR` env already set.
- **Express 5.3** (`Router`, async error propagation, `res.attachment`) — new routers `roster.js`, `mail.js`.
- **node:sqlite** (Node 22.14): `ALTER TABLE … ADD COLUMN` with `CHECK`/`DEFAULT`, `VACUUM INTO ?` (bound parameter, outside transactions) for the pre-migration snapshot, ROLLBACK on a failed migration, `lastInsertRowid`.
- **pdfkit 0.20.2**: `rect().fill()` cell backgrounds, landscape A4, text in cells (roster PDF).
- **exceljs 4.4.0**: column changes, autoFilter range.
- **node:test / supertest 7.3.1**: unchanged usage.
- **Global `fetch` / `AbortSignal.timeout` / `redirect:'error'` / body stream reader** (Node 22) for the roster import and Brevo.
- **Intl.DateTimeFormat().resolvedOptions().timeZone** (tz report), `process.env.TZ` set at runtime in the DST test file.
- **CSS** `position:sticky` on table cells (with `border-collapse:separate`), and `color-mix()` only behind hex fallbacks.

## Definition of done
- `npm test` is green: the existing 132 tests (with only the intentional expectation updates: `user_version` 2, state keys, Gross removed) plus all new tests.
- Migration 2 runs on a copy of a v1 DB with data and takes a pre-migration snapshot next to the DB (on `/data` in production). Raw `clock_in/clock_out` values are byte-identical before and after. A failing migration rolls back fully.
- With no roster data, **or with `roundFrom` unset or later than the shift**, every pay number equals the previous version (backup fixtures v1/v2 still give the same `paid/net`).
- **Deploy runbook (before pushing to Railway):** (1) Admin → Settings → Download backup from production. (2) Locally, import it into a fresh v1 DB (checkout of the current `main`), copy that DB, then run the new build's migration 2 on the copy. (3) Run a throwaway script that calls `week()` for **every past week** on both DBs, so `paid` and `net` can be diffed per employee. They must be **identical** while `roundFrom` is unset. (4) Run the roster import dry-run against the live URL and check offset +1 and the sample lines. (5) Deploy, then confirm the startup log shows the pre-migration snapshot path under `/data`. (6) Set `roundFrom` to a future Monday only after the owner agrees.
- The rounding tables in Tasks 10–11 pass exactly. The UI Shifts page, Weekly Report, xlsx, payroll PDF and payslip show the same paid hours for the same shift (e2e asserts this).
- The roster tab works on a 375 px phone and on desktop: add/edit/delete entries, copy/clear week, PDF, overview hours, and undo for each.
- A dry-run import against the fixture shows `offsetDays: 1` and correct Monday mapping. Applying it twice changes 0 cells the second time, including after an employee rename (idMap). Created staff get unique codes.
- Past-day roster changes report and audit `(past: re-prices N shifts)`, and the UI confirms when N > 0.
- Payslip email works against a fake Brevo `fetch` in tests. Without `BREVO_API_KEY`/`MAIL_FROM` the API returns 503 and the UI explains it. A concurrent email-all for the same week gets 409. No secret appears in the code, DB, backups or logs. No SMTP code or nodemailer dependency.
- The kiosk stays black/white (theme test), and its only change is the "Rostered today" line. Admin tabs and shift types are colour-coded in light and dark, with contrast ≥ 4.5:1.
- Backup v3 round-trips everything. v1/v2 backups still import.
- The README documents TZ (set), Brevo setup and the roster import.

## Risks
- **Server timezone on Railway (low now):** `TZ=Australia/Sydney` is set. If it were lost, the server would compute roster times in UTC. Mitigation: the tz alert (Task 40) and the README env table.
- **Email deliverability (medium):** Brevo with a Gmail sender address can be spam-filtered or rejected under DMARC, and a key with "Authorised IPs" on will fail from Railway. Mitigation: README steps, a test send to the owner first, a custom-domain sender recommended, per-employee `failed: <Brevo message>` results, a 15 s timeout so a request never hangs, and the 409 double-send guard plus "last emailed" info.
- **Pay correctness:** rounding changes real wages. Mitigation: exact rule tables in tests, `roundFrom` effective date (no retroactive change), actual vs paid always visible, per-shift OT approval, `rounding` switch to turn it off, raw punches never mutated, and repricing counts on past-day roster changes.
- **Fair Work / award compliance (high, owner decision):** the rounding rules mostly favour the employer: early starts are unpaid, overtime is capped unless approved, late starts round **up** and early finishes round **down**. Australian awards and the Fair Work Act can require payment for all time worked, and one-sided rounding can be unlawful. Mitigation: keep the OVER flag and anomaly, per-shift OT approval, the rounding switch, `roundFrom`, and actual-vs-paid on every screen and export. **The owner must confirm the policy against their award before setting `roundFrom`.**
- **Import date offset:** if the old app was ever used from a UTC-or-west device, some keys would not be shifted. Mitigation: default +1 with an override, persisted per import, a dry-run weekday-distribution warning and sample lines for confirmation. Evidence of a consistent +1 day in the live data (12 Sun–Sat blocks).
- **History drift:** salary, rate and pay-type edits re-price past weeks (as rates already do). Fixed items use `from/to` to avoid this. If true history is needed later, add effective-dated pay records (out of scope).
- **Live DB migration:** `ALTER TABLE` on the Railway volume. Mitigation: a pre-migration snapshot (Task 2) and additive-only columns, so rollback = copy the snapshot back.
- **Undo stack size:** an import touches ~1,100 rows in one undo entry (a few hundred KB in memory per session, capped at 30 entries). Acceptable. If it becomes a problem, the import can be made non-undoable like a backup restore.
- **`fixed_items` as JSON:** not queryable in SQL (not needed). Validated on every write and on backup import.
- **Generated codes** for imported staff could be guessed by co-workers before they are handed out. Mitigation: the codes are random and shown once, and the admin can change them.
- **Old roster app** keeps running and may diverge after the import. The user decides when to retire it. The import can be re-run at any time (idempotent per cell, though it overwrites edits made here to cells that exist in the source; the dry run shows `changedCells`, `pastDayCells`, `repricedShifts`).
- **In-memory email lock** is per process. A restart mid-send releases it, but the audit shows what was already sent, and the confirm dialog shows "last emailed". Railway runs a single instance.

## Changelog (gstack-leader review + context7 findings)
- T1: migrate rollback test (failed migration leaves user_version and no partial table); ALTER ADD COLUMN rules.
- T2: snapshot goes to `path.dirname(dbPath)`, uses a bound `VACUUM INTO ?` outside transactions, has a unique name, and its path is logged.
- T7: `roundFrom` (Monday or null) + server-managed `rosterImport` setting.
- T9: early-clock-in fallback (6:30 → 9:00), OFF-ROSTER tag; E from local wall-clock; DST tests in `test/pay.dst.test.js`.
- T10: 6:30 → 9:00 case. T11: DST finish cases.
- T12: break deduction per breakMode on the paid span (one test per mode, cap); `roundFrom` gate test.
- T13: week before `roundFrom` is unchanged.
- T16: off-roster `med` anomaly.
- T18: `mailConfigured` from Brevo env.
- T20/T21/T23: `repriced` count, `dryRun`, audit suffix `(past: re-prices N shifts)`.
- T22: default offset +1 with override; persisted `{offsetDays, idMap}`; detection is only a weekday-distribution warning; dry run adds `pastDayCells`/`repricedShifts`; rename re-run test.
- T23: CLI removed; fetch hardening (`redirect:'error'`, `res.ok`, 5 MB cap, 502s).
- T24: kiosk birthday flag removed; identify roster + calcAll only.
- T28: pdfkit fill/clip/paging details.
- T29 + T31b merged: Brevo-only `src/mail.js` (no nodemailer/SMTP, fake fetch tests).
- T30: per-week email-all lock (409), email-status endpoint, messageId in audit.
- T32/T34: hex tokens as source of truth; sticky-column CSS rules; T34 overview shrunk to hours column + per-day count + total.
- T36/T38: repricing confirm; email-all confirm shows last sent, button disabled while sending.
- T41: reduced to the kiosk "Rostered today" line (no late toast, no birthday).
- T42: `roundFrom` input with next-Monday pre-fill.
- T43: Brevo README (verified sender, Authorised IPs off, deliverability), `TZ=Australia/Sydney` (set); readme test updated.
- T44: e2e with fake Brevo fetch, no CLI, no kiosk toast.
- Assumptions 3, 4, 6, 7, 8, 8a, 12, 13, 14, 19, 20; Questions resolved; API table; DoD deploy runbook; Risks (Fair Work, deliverability, lock).

## Answers from the user (2026-10-30)
1. **Railway plan: Hobby/Trial/Free** → outbound SMTP is blocked. Email goes through an HTTPS email API. Use **Brevo** (transactional email API `POST https://api.brevo.com/v3/smtp/email`, header `api-key`, attachments as base64 `attachment:[{name,content}]`; free tier ~300/day; sender is the user's verified Gmail address — no domain needed). Implement `src/mail.js` with a provider adapter: `MAIL_PROVIDER=brevo` (`BREVO_API_KEY`, `MAIL_FROM`, optional `MAIL_FROM_NAME`) using built-in `fetch` (no new dependency), and keep the SMTP adapter (`MAIL_PROVIDER=smtp`, nodemailer) only if cheap — otherwise drop SMTP entirely. Task 31b becomes mandatory and is rewritten for Brevo instead of Resend. Tests use a fake `fetch`/transport, never the network.
2. **Timezone: Australia/Sydney.** `TZ=Australia/Sydney` has been set on the Railway service (done by the main agent). Keep the tz-mismatch dashboard alert.

*Reconciled:* answer 1's optional SMTP adapter was settled by gstack-leader change 8: **Brevo only**, with no `MAIL_PROVIDER` switch, no nodemailer and no SMTP. Task 29 (merged with the former 31b) is the single mail task.

---

## Build status (2026-10-30, main agent)
All tasks built test-first except where noted: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29(+31b merged), 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41 (roster line only), 42, 43, 44. `npm test` → 210/210. Real-browser check (headless Chrome, desktop + 390 px phone): all admin tabs, roster grid + cell editor, import preview/apply, no console errors, no horizontal overflow on phone.

Deviations / notes for review:
- **Red step skipped** for Task 13's two week tests (the roster-aware `week()` was written together with Tasks 9–12) and the Task 44 e2e (written after all parts existed).
- **PDF tests** check pure line builders (`payrollLine`, `payslipSummary`, `timesheetRow`, `rosterLabel`) instead of text inside the PDF: embedded-font PDFs are glyph-encoded and not searchable.
- `rosterLabel` lives in `src/shared/format.js` (used by the browser grid and the roster PDF) and is re-exported from `pdf.js`.
- Kiosk: identify returns today's roster entries; the kiosk shows "Rostered today: …" (no late toast, no birthday — per leader cut).
- The app error handler now exposes the message of deliberate `HttpError`s with status ≥ 500 (502 roster fetch, 503 email not set up); other 5xx stay generic and logged.
- `test/helpers.js` `makeTestApp` passes extra options (`fetch`, `mailer`) through to `createApp`.
