# Plan: Full-stack Time Clock (Node + SQLite + REST API + PDF/Excel exports)

## Goal
Turn the single-file, localStorage-only `index.html` kiosk/admin app into a small full-stack app: an Express server with a SQLite database that stores employees, shifts, breaks, weekly adjustments, settings and the audit log. The existing UI (same look and features) talks to a REST API. Admin auth is enforced on the server. The kiosk can only punch by employee code. Payroll can be exported as PDF and Excel on the server, existing backups can be imported once, and everything is covered by automated tests. It runs with `npm install` and `npm start` at http://localhost:3000.

### What the current code does (read from `index.html`, 1229 lines)
- `Store` (lines 216-293): one JSON blob in localStorage `timeclock.v2` (falls back to `timeclock.v1`). Schema v1→v2 migration adds `audit`. Snapshot undo stack (30), audit capped at 1000, cross-tab `storage` sync.
- `Pay` (lines 301-366): `policyBreak`, `shift`, `week`, `totals`, `anomalies`. It is pure apart from reading `db()` (global state) and `empName`/`fmtDay` inside `anomalies`. Week = local Monday 00:00 to +7 days. A shift belongs to the week and the day (`dayIndex(sh.in)`) where it **starts**. Minutes are rounded per shift and per break. `ded = min(total, policy|actual|max)`. Tier split: `h1 = min(paid, tierHours)`, `h2 = paid - tier`. Net = gross + allowances - deductions. An inactive employee with no shifts and no adjustments is skipped.
- `Hash` (lines 196-213): `sha256:` hex of `"${salt}:${pin}"`, with an `fnv:` fallback. A v1 backup may hold a plaintext `settings.adminPin`. The default PIN is `0000` (`defaultPin: true`).
- Kiosk: 4-digit code. 5 wrong codes lock the keypad for 30 s. Punch types are `in`, `bs`, `be` and `out`. `out` also closes an open break.
- Admin: 5 wrong PINs lock for 60 s. Idle auto-lock after `adminTimeoutMin`. Tabs: Dashboard, Weekly Report, Shifts (timeline + table), Employees, Audit Log, Settings (break rules, PIN change, backup / restore / erase).
- Validation in `Forms.shiftSave` (lines 1111-1137): out must be after in. Breaks must be inside the shift and must not overlap each other. A shift must not overlap another shift of the same employee. `validPin`: exactly 4 digits and unique. An employee who has shifts cannot be deleted (only set inactive).
- Exports today: CSV in the browser (payroll, shifts, audit) and a JSON backup (`JSON.stringify(db())`).

## Chosen approach (and why) / Rejected alternatives

### Approach A (CHOSEN): "Thin server, shared pure pay module, keep the UI's render code"
- **Backend:** Node 22 + Express 5 using ES modules (`"type": "module"`). `createApp({ db, clock })` factory, so tests can pass an in-memory DB and a fake clock.
- **Database:** SQLite through the built-in **`node:sqlite`** (`DatabaseSync`). All access goes through one small wrapper, `src/db.js` (`prepare/get/all/run/tx`), so moving to `better-sqlite3` later only touches that file.
  - *Why `node:sqlite` rather than `better-sqlite3`:* nothing native to install on Windows (no prebuilt binary, no node-gyp or Visual Studio Build Tools fallback), and its synchronous API looks like better-sqlite3's. Node 22.13+ ships it without a flag. The cost is that it is marked experimental and prints an `ExperimentalWarning`, which we hide with `--disable-warning=ExperimentalWarning` in the npm scripts. We hand-write a `tx()` helper (BEGIN/COMMIT/ROLLBACK) because node:sqlite has no `.transaction()`.
- **Shared pure code:** `src/shared/format.js` and `src/shared/pay.js` are ES modules with **no** DOM or global state. The server imports them for reports and exports. The browser imports the same files from `/shared/*.js`, which Express serves statically, so the UI's numbers and the exports' numbers are always the same code. `Pay.*` changes from reading `db()` to taking `data = { settings, employees, shifts, adj }` as an argument.
- **Frontend:** `public/index.html` (current markup and CSS, unchanged) and `public/app.js` (current script as an ES module). `Store` becomes a remote cache: `GET /api/admin/state` fills it, and every mutation is an API call followed by a refresh. The view, chart, dialog and event code stays almost as it is. No build step, no framework.
- **Auth:** the admin PIN is hashed with `crypto.scrypt` and salted. Sessions use a random 32-byte token sent as an `HttpOnly; SameSite=Strict` cookie. Only a SHA-256 of the token is stored in the DB. The session expires after `adminTimeoutMin` of inactivity, enforced on the server. Lockout is 5 failures, then 60 s (admin) or 30 s (kiosk), per client IP, and it is written to the audit log. Legacy `sha256:`/`fnv:`/plaintext hashes from backups are accepted once and re-hashed to scrypt on the first successful login.
- **Kiosk API:** public endpoints return only the company name, theme, idle timeout, tier hours, currency, counts of people on shift and on break, and whether any employees exist. `identify` and `punch` take the employee code and return **only that employee's** name, their open shift and their today/week hours. The server's clock is the time of every punch.
- **Exports:** `exceljs` (xlsx) and `pdfkit` (pdf) are built from one tested report model, `src/reports/model.js`.

### Approach B (rejected): server computes everything, the UI becomes a thin view of server-rendered JSON reports
- Pros: one place for logic, and the client never holds the raw data.
- Cons: the dashboard, timeline, live open-shift hours and anomalies would need a new endpoint each, which means a much larger UI rewrite. The user asked us to keep the UI and its features.
- Risk: high regression risk in a UI that has no tests.

### Approach C (rejected): keep localStorage and add a "sync to server" endpoint, or SQLite in the browser via WASM
- Pros: very little UI change.
- Cons: the server would not be the source of truth. Admin auth would still run in the browser, and the kiosk could still read all data. That fails the "auth done properly on the server" and "kiosk must not read admin data" requirements.

### Database alternative considered: `better-sqlite3`
It is mature, fast and has `.transaction()`. It needs a prebuilt native binary for Node 22 on win-x64, and if one is missing it falls back to compiling with node-gyp, which is the biggest risk to "just `npm install`" on Windows. Because of the `src/db.js` wrapper, switching later is a one-file change (noted under Risks).

## Assumptions (defaults chosen; not blocking)
1. **Timezone:** all week and day boundaries use the **server's local timezone** (kiosk and server sit at the same site). The README documents setting `TZ` if needed. Pay functions take `ws` (week-start ms) and use local `Date`, as they do today.
2. **Employee codes stay in plaintext** in the DB. The admin "Show codes" feature and the uniqueness checks need them, and hashing a 4-digit space adds no real security. Only the admin API ever returns them, and the kiosk never does.
3. **Admin PIN:** first start (or erase) sets `0000` with `defaultPin=true`, the same as today. It must be at least 4 characters.
4. **Lockouts** are in memory and per client IP (`req.ip`). A restart clears them, and each lockout is written to the audit log.
5. **Audit log** is no longer capped at 1000 rows in the DB. The UI shows the latest 300 (as now), and the CSV export includes everything.
6. **Undo** moves to the server: a per-session stack of up to 30 "before images", cleared on logout, so it behaves as today.
7. **Cross-tab sync:** instead of the `storage` event, the admin UI re-fetches state on focus and every 30 s. The kiosk polls `/api/kiosk/info` every 10 s.
8. **Bind address:** `HOST=127.0.0.1`, `PORT=3000` by default. The README explains `HOST=0.0.0.0` for a kiosk tablet on the LAN.
9. **CSV exports** (payroll and shifts) stay in the browser, built from state, unchanged. The audit CSV moves to the server so that it holds the full log.
10. **The root `index.html` is never moved or deleted by us.** It is the current v2 app (localStorage key `timeclock.v2`, backup `v:2`, admin PIN as `adminPinHash` (`sha256:`/`fnv:` prefix) + `adminSalt`). First migration step: the user opens the **same root `index.html` they always use** (same path, same browser, so its localStorage is still there) and clicks Admin → Settings → "Download backup". Then they import it. They delete the root file themselves, only after checking the import. The importer accepts both v1 backups (no `v`, plaintext `settings.adminPin`) and v2 backups. An optional read-only reference copy may be put in `legacy/index.html`, but it is **never** the export source: a copy at another path or origin cannot see the original localStorage. The server serves only `public/`, never the root file.
11. **Currency symbols such as `₹`** are not in the standard PDF fonts (WinAnsi). The PDF therefore embeds a Unicode TTF (DejaVu Sans Mono from the `dejavu-fonts-ttf` npm package, which suits the monospace look) instead of the built-in Courier.
12. **Money stays as JS floats**, rounded only for display, to match current behaviour exactly. (Moving to integer cents is out of scope.)

## Questions for the user
None blocking. (Please confirm assumptions 1, 2 and 8 if your setup differs: several sites or timezones, or a kiosk tablet on another device.)

## Target layout
```
package.json            "type":"module", engines node>=22.13, scripts: start, test, import
.gitignore              node_modules/, data/
README.md
index.html              EXISTING v2 app – left untouched (user exports the backup from it, deletes it only after verifying import)
legacy/index.html       optional read-only reference copy (NOT an export source)
data/                   timeclock.db (+ -wal/-shm files), backups/ snapshots (created at runtime)
src/
  config.js             PORT, HOST, DB_PATH, BACKUP_DIR, BACKUP_KEEP defaults (+ env); paths resolved from import.meta.url
  errors.js             ValidationError, HttpError(status, message)
  snapshot.js           snapshot(db, dir, now) via VACUUM INTO + prune(dir, keep)
  server.js             entry: openDb -> migrate -> ensureAdminPin -> snapshot + 24h timer -> createApp -> listen
  app.js                createApp({db, clock}) – express, json, static, routes, error handler
  db.js                 openDb(path), tx(), migrate()
  migrations.js         [sqlSchemaV1, ...] using PRAGMA user_version
  repo.js               data access (employees, shifts+breaks, adjustments, settings, audit, loadData)
  validate.js           pure validators (pin, employee, shift, settings, adjustment)
  punch.js              punch(db, empId, type, now) state machine
  undo.js               per-session undo stack using row before-images
  backup.js             normalizeBackup / importBackup / exportBackup
  auth/hash.js          scrypt hashPin / verifyPin (+legacy sha256/fnv/plain) / needsRehash
  auth/sessions.js      create / touch / destroy session, cookie helpers
  auth/lockout.js       createLockout({max, ms, clock})
  routes/auth.js        /api/auth/*
  routes/kiosk.js       /api/kiosk/*
  routes/admin.js       /api/admin/* (CRUD, state, undo, backup, import, erase)
  routes/exports.js     /api/admin/export/*
  reports/model.js      buildWeekReport(data, ws, now)
  reports/xlsx.js       payrollWorkbook(report) -> Buffer
  reports/pdf.js        payrollPdf(report), payslipsPdf(report, empIds) -> Buffer
  shared/format.js      browser+node: pad, ymd, dayIndex, startOfWeek, addDays, fmtHM, fmtMin, fmtDay, fmtTime, num, H, MIN, DAYS
  shared/pay.js         browser+node: policyBreak, shift, week, totals, anomalies
scripts/import-backup.js
public/index.html       markup + CSS from legacy file
public/api.js           fetch wrapper
public/app.js           UI logic (ES module)
test/helpers.js         makeTestApp(), fakeClock(), loginAgent(), local-date helper d(y,m,d,h,mi)
test/fixtures/backup-v1.json, backup-v2.json
test/*.test.js
```

## Database schema (migration 1)
```sql
CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL UNIQUE CHECK(length(pin)=4),
  rate1 REAL, rate2 REAL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE shifts (id TEXT PRIMARY KEY, emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  clock_in INTEGER NOT NULL, clock_out INTEGER, CHECK(clock_out IS NULL OR clock_out > clock_in));
CREATE INDEX shifts_emp_in ON shifts(emp_id, clock_in);
CREATE INDEX shifts_open ON shifts(emp_id) WHERE clock_out IS NULL;
CREATE TABLE breaks (id INTEGER PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  start_at INTEGER NOT NULL, end_at INTEGER);
CREATE TABLE adjustments (id INTEGER PRIMARY KEY, week_start TEXT NOT NULL, emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('allowance','deduction')), label TEXT NOT NULL, amount REAL NOT NULL, position INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);          -- JSON-encoded values
CREATE TABLE audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX audit_ts ON audit(ts DESC);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
```
Breaks columns are named `start_at`/`end_at` (`end` is an SQL keyword). The repo maps them to the legacy `{start, end}` shape. Pragmas on open: `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`. Times are epoch milliseconds (as in the legacy data). The admin hash is stored as the settings keys `adminPinHash` and `defaultPin`. `GET` responses filter settings through a `PUBLIC_SETTINGS` allow-list, so the hash is never returned.

## REST API
| Method & path | Auth | Purpose |
|---|---|---|
| GET `/api/kiosk/info` | none | `{company, theme, currency, tierHours, kioskIdleSec, hasEmployees, defaultPin, onShift, onBreak}` |
| POST `/api/kiosk/identify` `{pin}` | none (lockout 5/30 s) | `{employee:{id,name}, shift:{in,breaks}|null, todayPaid, weekPaid}` |
| POST `/api/kiosk/punch` `{pin,type}` | none (lockout) | performs `in/bs/be/out`, returns `{type, name, at, calc}`. Returns 409 if the transition is invalid |
| POST `/api/auth/login` `{pin}` | none (lockout 5/60 s) | sets the `tc_admin` cookie. Returns 401 `{remaining}` or 429 `{retryAfter}` |
| POST `/api/auth/logout` | admin | destroys the session and clears undo |
| GET `/api/auth/me` | admin | `{defaultPin, adminTimeoutMin}` |
| POST `/api/auth/pin` `{current,next}` | admin | changes the PIN |
| GET `/api/admin/state` | admin | `{settings, employees, shifts, adj, undoLabel}` in the legacy shape (adj items include `id`) |
| GET `/api/admin/audit?q=&limit=300` | admin | audit rows, newest first |
| POST/PUT/DELETE `/api/admin/employees[/:id]` | admin | CRUD. DELETE returns 409 if the employee has shifts |
| POST/PUT/DELETE `/api/admin/shifts[/:id]` | admin | CRUD with validation. 422 on validation errors |
| POST `/api/admin/shifts/:id/clock-out` | admin | force clock-out |
| POST `/api/admin/adjustments` / DELETE `/api/admin/adjustments/:id` | admin | add or remove an allowance or deduction |
| PUT `/api/admin/settings` | admin | partial update, validated |
| POST `/api/admin/undo` | admin | undo the last action in this session |
| GET `/api/admin/backup` | admin | legacy-compatible v2 JSON download |
| POST `/api/admin/import` | admin | replace all data with a backup (body limit 10 MB) |
| POST `/api/admin/erase` `{confirm:"ERASE"}` | admin | wipe all data and reset the PIN to 0000 |
| GET `/api/admin/export/payroll.xlsx?week=YYYY-MM-DD` | admin | Excel workbook |
| GET `/api/admin/export/payroll.pdf?week=` | admin | weekly payroll PDF |
| GET `/api/admin/export/payslips.pdf?week=&emp=<id|all>` | admin | per-employee timesheet + payslip, one page per employee |
| GET `/api/admin/export/audit.csv` | admin | full audit CSV (same escaping as the legacy `CSV.cell`) |

Every state-changing request (POST/PUT/DELETE) under `/api/`, **including `/api/kiosk/*` and `/api/auth/*`**, must send `Content-Type: application/json`, otherwise 415 `{error}`. Together with SameSite=Strict cookies this is the CSRF defence. Errors are JSON `{error: "message"}`. Express 5 forwards rejected promises to the error handler. All mutations write to the audit log (actor `Admin`, an employee name for punches, or `System`).

---

## Tasks
Every test runs with `node --test` (built-in runner). `npm test` = `node --disable-warning=ExperimentalWarning --test "test/**/*.test.js"`. A single file: `node --disable-warning=ExperimentalWarning --test test/<file>.test.js`. Below, `RUN(x)` means `node --disable-warning=ExperimentalWarning --test test/x.test.js`. Tests build dates with local `new Date(y, m-1, d, h, mi)` (helper `d()`), so they pass in any timezone. **Each test is written first, seen failing (red), then made to pass (green).**

### Phase 0 – Scaffold

### Task 1: Project scaffold and config
- Files: `package.json`, `.gitignore`, `src/config.js`, optional `legacy/index.html` (read-only reference copy), `test/config.test.js`. **The root `index.html` is not moved, renamed or edited.**
- Change: `npm init`. Set `"type":"module"` and `"engines":{"node":">=22.13"}`. Scripts: `start` = `node --disable-warning=ExperimentalWarning src/server.js`, `test` as above, `import` = `node --disable-warning=ExperimentalWarning scripts/import-backup.js`. `.gitignore`: `node_modules/`, `data/`. `config.js` exports `loadConfig(env = process.env)` → `{ port: 3000, host: '127.0.0.1', dbPath: <projectRoot>/data/timeclock.db, backupDir: <projectRoot>/data/backups, backupKeep: 14 }`, with `PORT`, `HOST`, `DB_PATH`, `BACKUP_DIR` and `BACKUP_KEEP` overrides. `projectRoot` comes from `fileURLToPath(new URL('..', import.meta.url))`, **never from `process.cwd()`**, and is exported as `ROOT` for other modules (`public/`, `src/shared/`). Install deps: `express@5 exceljs pdfkit dejavu-fonts-ttf`, dev `supertest`. Optionally copy the root `index.html` to `legacy/index.html` as a reference. The root file stays in place for the whole project: it is the user's only export source, and the user deletes it after checking the import.
- Test first: `test/config.test.js` › "loadConfig returns defaults" (port 3000, host 127.0.0.1, dbPath ends with `data\\timeclock.db` or `data/timeclock.db`) and "env overrides" (`{PORT:'4000', DB_PATH:':memory:', BACKUP_KEEP:'3'}` → port 4000, dbPath `:memory:`, backupKeep 3). "paths independent of cwd": after `process.chdir(os.tmpdir())` (restored in `t.after`), a fresh `loadConfig({})` dbPath still starts with `ROOT`. "root index.html untouched": the file exists at the project root. Run: `RUN(config)`.
- Depends on: none

### Phase 1 – Shared pure modules (lock in current behaviour)

### Task 2: `src/shared/format.js`
- Files: `src/shared/format.js`, `test/format.test.js`
- Change: move these from legacy lines 150-182 without changing their behaviour: `H, MIN, DAYS, pad, num, clamp, trunc, initials, ymd, dayIndex, startOfWeek, addDays, fmtHM, fmtMin, fmtElapsed, fmtTime, fmtDay, fmtStamp, toLocalInput, fromLocalInput, niceStep`, plus `money(n, currency)` (now takes the currency as an argument instead of reading `db()`). Also `safeText(v)`, which prefixes `'` to strings starting with `= + - @` (legacy `CSV.cell` rule), plus `csvCell`/`csvBuild` built on it. No DOM use.
- Test first: `test/format.test.js`: `fmtHM(7.5)==='7:30'`, `fmtHM(-0.25)==='-0:15'`, `fmtHM(0)==='0:00'`, `fmtMin(90)==='1:30'`; `startOfWeek(d(2026,10,28,15))` equals `d(2026,10,26)` (Monday 00:00); Sunday `d(2026,11,1,23)` → `d(2026,10,26)`; `dayIndex(Sunday)===6`; `ymd(d(2026,1,5))==='2026-01-05'`; `money(-3.5,'₹')==='-₹3.50'`; `num('abc')===0`; `safeText('=SUM(A1)')==="'=SUM(A1)"`, `safeText('-5')==='-5'`, `safeText('@x')==="'@x"`. Run: `RUN(format)`.
- Depends on: 1

### Task 3: `pay.policyBreak` + `pay.shift`
- Files: `src/shared/pay.js`, `test/pay.shift.test.js`
- Change: port `policyBreak(hours, rules)` and `shift(sh, settings, now)` exactly as written (rounding to whole minutes, open shift/break uses `now`, `ded = min(totalMin, mode…)`).
- Test first: with rules `[{h:4,m:15},{h:5,m:30},{h:7,m:60},{h:10,m:90}]`: `policyBreak(3.99)=0`, `(4)=15`, `(6.5)=30`, `(10)=90`, unsorted rules give the same result. `shift` for 09:00-17:00 with a 20-min break: policy → total 8, actual 20, policy 60, ded 60, paid 7. actual → ded 20, paid 7.6667 (approximately). greater → ded 60. A 45-min actual break on a 5 h shift in greater mode → ded 45. An open shift with `now` = in + 3 h and an open break started 30 min before `now` → actual 30, open true. Ded capped: policy 90 on a 1-min shift with a rule `{h:0,m:90}` → ded 1, paid 0. Run: `RUN(pay.shift)`.
- Depends on: 2

### Task 4: `pay.week` + `pay.totals`
- Files: `src/shared/pay.js`, `test/pay.week.test.js`
- Change: `week(data, ws, now)` where `data = {settings, employees, shifts, adj}`. Same algorithm as legacy lines 315-336. `totals(rows)` unchanged.
- Test first: (a) tier split: tierHours 24, rates 20/30, five 6 h shifts with policy breaks (30 min each) → paid 27.5, h1 24, h2 3.5, gross 585. (b) overnight: a shift Sun 22:00 → Mon 06:00 is counted in the week of its Sunday at `days[6]` and **not** in the next week. (c) a shift starting exactly at next Monday 00:00 is excluded. (d) adjustments under key `'2026-10-26|e1'`: allowance 50 and deduction 20 → net = gross + 30. (e) an inactive employee with no shifts/adj is absent, and an inactive employee with a shift is present. (f) rate `''`/`null` → r1 0, p1 0. (g) `totals` sums `days` and `net` across rows. (h) an open shift uses `now` and sets `open:true`. Run: `RUN(pay.week)`.
- Depends on: 3

### Task 5: `pay.anomalies`
- Files: `src/shared/pay.js`, `test/pay.anomalies.test.js`
- Change: `anomalies(data, ws, now)`. Resolve names from `data.employees` and use `fmtHM`/`fmtDay` from `format.js`. Same rules: default PIN (high, `tab:'settings'`), open shift > `maxShiftHours` (high), open break > 2 h (med), overlapping shifts within the week (high), active employee with no rate1 (low, `empId`).
- Test first: assert `level` plus `shiftId`/`empId`/`tab` and that `msg` contains the employee name (no locale-dependent text). Include a negative case: an open shift of 13 h with max 14 → no alert. Run: `RUN(pay.anomalies)`.
- Depends on: 4

### Phase 2 – Database

### Task 6: `src/db.js` + migration 1
- Files: `src/db.js`, `src/migrations.js`, `test/db.test.js`
- Change: `openDb(path)` → wrapper `{ raw, get(sql, params), all(sql, params), run(sql, params), exec(sql), tx(fn), close() }` over `node:sqlite` `DatabaseSync`. Sets the pragmas. `migrate(db)` applies the pending SQL from `migrations.js` inside a tx and sets `PRAGMA user_version`. Creates the parent directory for file paths (`fs.mkdirSync(dirname, {recursive:true})`). `tx` supports nesting with SAVEPOINTs, so repo functions can be composed.
- Test first: `test/db.test.js`: "migrate creates all tables" (sqlite_master contains the 8 tables and `user_version` = 1). "migrate is idempotent" (running it twice is fine). "foreign keys on" (deleting a shift cascades to its breaks, and inserting a shift for a missing employee throws). "tx rolls back on throw" (no row persisted). "opens file db in a new dir" (temp dir via `fs.mkdtempSync(os.tmpdir())`, file exists afterwards). Run: `RUN(db)`.
- Depends on: 1

### Task 6a: `src/errors.js`
- Files: `src/errors.js`, `test/errors.test.js`
- Change: `class ValidationError extends Error` (`status = 422`, optional `details` array) and `class HttpError extends Error` (`constructor(status, message)`). Both set `name`. This is the only place these classes are defined. Tasks 9, 14, 15, 17 and 22 import from here.
- Test first: `new HttpError(409, 'x')` → `instanceof Error`, `.status === 409`, `.message === 'x'`, `.name === 'HttpError'`. `new ValidationError('bad', ['a'])` → `.status === 422`, `.details` deep-equals `['a']`. Run: `RUN(errors)`.
- Depends on: 1

### Task 7: Repo – settings, employees, audit
- Files: `src/repo.js`, `test/repo.basic.test.js`
- Change: `DEFAULT_SETTINGS` (copy of legacy lines 220-231 without the hash fields) and `PUBLIC_SETTINGS` keys. `getSettings(db)` merges defaults with stored rows. `setSettings(db, patch)`. `listEmployees`, `getEmployee`, `findEmployeeByPin(db, pin)` (active only), `createEmployee`, `updateEmployee`, `deleteEmployee`, `employeeHasShifts`. `addAudit(db, {ts, actor, action, detail})`, `listAudit(db, {q, limit})` (LIKE search over actor/action/detail, newest first). Row mapping: `active` INTEGER to boolean, `rate1/rate2` null stays null.
- Test first: settings defaults returned on an empty DB, and a patch persists while untouched keys keep their defaults. The employee round-trip keeps the legacy shape `{id,name,pin,rate1,rate2,active}`. A duplicate pin throws. `findEmployeeByPin` ignores inactive employees. `listAudit({q:'clock'})` filters case-insensitively, and the limit is respected. Run: `RUN(repo.basic)`.
- Depends on: 6

### Task 8: Repo – shifts, breaks, adjustments, `loadData`
- Files: `src/repo.js`, `test/repo.shifts.test.js`
- Change: (breaks rows map `start_at`/`end_at` ↔ `{start, end}`) `getShift`, `listShifts(db, {from, to, empId})`, `openShiftFor(db, empId)`, `saveShift(db, {id, empId, in, out, breaks})` (upsert, replacing the breaks inside a tx), `deleteShift`. `listAdjustments(db)` → legacy map `{'YYYY-MM-DD|empId': [{id,type,label,amount}]}` ordered by position. `addAdjustment`, `deleteAdjustment`. `loadData(db)` → `{settings, employees, shifts, adj}` in exactly the shape `pay.js` expects.
- Test first: a shift with 2 breaks round-trips to `{id,empId,in,out:null,breaks:[{start,end}]}` with breaks sorted by start. Re-saving with 1 break leaves 1 break row. `openShiftFor` returns only the open shift. The adjustments map key format is correct. `pay.week(loadData(db), ws, now)` gives the same result as the hand-built fixture from Task 4(a). Run: `RUN(repo.shifts)`.
- Depends on: 4, 7

### Phase 3 – PIN hashing, backup import/export

### Task 9: Fixtures + `normalizeBackup`
- Files: `test/fixtures/backup-v1.json` (v1: **no `v` key**, no `audit`, plaintext `settings.adminPin:"1234"`, rate `""`), `test/fixtures/backup-v2.json` (the exact format the current root `index.html` downloads: `v:2`, 3 employees with one inactive, 6 shifts including an overnight and an open one, 2 adjustments, audit entries, `settings.adminPinHash:"sha256:<hex>"` + `settings.adminSalt:"<hex>"`, `defaultPin:false`), `test/fixtures/backup-v2-fnv.json` (the same but with an `fnv:<hex>` hash), `src/backup.js`, `test/backup.normalize.test.js`
- Change: `normalizeBackup(json)` is a port of legacy `normalize` + `valid`. It migrates v1→v2 and validates the structure (employees/shifts arrays, required fields and types, numeric timestamps, 4-digit pins, `out > in`). It throws `ValidationError` (from `src/errors.js`) with a readable message that lists the first problems. The v2 fixture's sha256 hash is computed from the known PIN `4321` (the fixture is generated by a small one-off snippet in the test file's comment, using `createHash('sha256').update(salt+':4321')`).
- Test first: v1 (no `v`) → `v:2`, `audit:[]`, `adminPin` kept for the later rehash. Both the v2 sha256 and v2 fnv fixtures are accepted. v2 is unchanged in counts. `{}` → throws. A shift with a non-numeric `in` → throws with a message containing "shift". Run: `RUN(backup.normalize)`.
- Depends on: 6a, 8

### Task 10: `src/auth/hash.js` (scrypt + legacy verify)
- Files: `src/auth/hash.js`, `test/hash.test.js`
- Change: `hashPin(pin)` → `scrypt$16384$8$1$<saltB64>$<hashB64>` (64-byte key, `crypto.scrypt` promisified, 16-byte random salt). `verifyPin(pin, stored)` supports `scrypt$…`, legacy `"<salt>|sha256:<hex>"` (`sha256(salt+':'+pin)`) and `"<salt>|fnv:<hex>"` (FNV-1a port from legacy lines 204-206). It always compares with `crypto.timingSafeEqual` and returns false (it never throws) on malformed input. `needsRehash(stored)` is true for anything that is not scrypt.
- Test first: hash + verify succeeds for the right PIN and fails for the wrong one. Two hashes of the same PIN differ (salt). A legacy sha256 vector built in the test verifies. A legacy fnv vector (computed with the ported function and pinned to a literal hex) verifies. Garbage `"abc"` → false. `needsRehash` behaves correctly. Run: `RUN(hash)`.
- Depends on: 1

### Task 11: `importBackup` / `exportBackup`
- Files: `src/backup.js`, `test/backup.import.test.js`
- Change: `importBackup(db, json, {replace:true, now})` in one tx: delete all rows, insert employees (`'' → NULL` rate), shifts + breaks, adjustments (split the key, keep the order), audit, and settings (copy known keys, combine the legacy v2 `adminSalt` + `adminPinHash` (`sha256:…` or `fnv:…`) into `adminPinHash = "<salt>|sha256:…"` / `"<salt>|fnv:…"`, or for a v1 plaintext `adminPin` → `hashPin()` scrypt; `defaultPin` from the backup or `pin==='0000'`). Add an audit entry `System / Backup restored`. Returns counts. `exportBackup(db)` → `{v:2, settings (incl. adminPinHash, defaultPin), employees, shifts, adj, audit}`, using the same keys as the legacy format.
- Test first: importing the v2 fixture gives counts 3/6/2 and `pay.week(loadData)` equals `pay.week(fixtureAsLegacyData)` for the fixture week (the core regression check: same numbers as the old app). `importBackup(exportBackup(db))` into a fresh DB gives a deep-equal `loadData`. An invalid backup throws and the existing data stays unchanged (rollback). v1 import → `adminPinHash` starts with `scrypt$` and `verifyPin('1234')` is true. v2 sha256 import → `verifyPin('4321', adminPinHash)` is true, and the same for the fnv fixture. Run: `RUN(backup.import)`.
- Depends on: 9, 10

### Task 12: CLI `scripts/import-backup.js`
- Files: `scripts/import-backup.js`, `test/cli.import.test.js`
- Change: `npm run import -- <file.json> [--db <path>] [--replace]`. Opens and migrates the DB. If any employees or shifts already exist and `--replace` is missing, it exits 1 with "Database not empty, use --replace". Otherwise it imports and prints `Imported 3 employees, 6 shifts, 2 adjustments, N audit entries`.
- Test first: `execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning','scripts/import-backup.js', fixture, '--db', tmpDb])` → stdout matches `/Imported 3 employees, 6 shifts/`. Running it a second time without `--replace` → exit code 1, and with `--replace` → 0. Run: `RUN(cli.import)`.
- Depends on: 11

### Phase 4 – Auth

### Task 13: Sessions + lockout modules
- Files: `src/auth/sessions.js`, `src/auth/lockout.js`, `test/auth.units.test.js`
- Change: `createSession(db, now)` → raw token (32 random bytes, base64url), storing `sha256(token)`. `touchSession(db, token, now, timeoutMin)` → true and updates `last_seen` if `now - last_seen <= timeoutMin*60000`, otherwise deletes the row and returns false. `destroySession`, `destroyAllSessions`, `purgeExpiredSessions(db, now, timeoutMin)` (deletes every row with `last_seen` older than the timeout). `parseCookies(header)`. `createLockout({max:5, ms:60000, clock})` → `{check(key) → {locked, retryAfterSec}, fail(key) → {locked, remaining}, reset(key)}`.
- Test first: with a fake clock, a session is valid at +4 min with a 5 min timeout and invalid at +5 min 1 s (and the row is gone). The DB never contains the raw token. Lockout: 4 fails → remaining 1. The 5th → locked with retryAfter 60. After +60 s it unlocks with the counter reset. `reset` clears it. `purgeExpiredSessions` removes the 2 stale rows and keeps 1 fresh row. Run: `RUN(auth.units)`.
- Depends on: 6, 10

### Task 14: `createApp` + auth routes + `requireAdmin`
- Files: `src/app.js`, `src/routes/auth.js`, `src/server.js`, `test/helpers.js`, `test/auth.api.test.js`
- Change: `createApp({db, clock = Date.now})`: `express.json({limit:'10mb'})`, basic security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`), a `requireJson` middleware on `/api` that answers 415 to any POST/PUT/DELETE without `Content-Type: application/json` (this covers kiosk, auth and admin), and a JSON error handler (`ValidationError` → 422, `HttpError(status)` → status, both imported from `src/errors.js`; anything else → 500 with a generic message, logged). `ensureAdminPin(db)` sets the `0000` scrypt hash when none exists. The auth routes are those in the table. Login calls `purgeExpiredSessions` first, rehashes legacy hashes on success, writes the audit entries `Admin login`, `Admin locked out` (System, "5 wrong admin PINs") and `Admin logout`, and sets the cookie `tc_admin` with `{httpOnly:true, sameSite:'strict', path:'/'}`. The `requireAdmin` middleware 401s without a valid session and touches `last_seen`. `server.js` wires config → openDb → migrate → ensureAdminPin → listen and logs the URL. `test/helpers.js`: `makeTestApp({clock})` (`:memory:` DB) and `loginAgent(app, pin='0000')` (supertest agent with the cookie).
- Test first: `test/auth.api.test.js`: a fresh app logs in with `0000` → 200, `set-cookie` contains `HttpOnly` and `SameSite=Strict`, and `/api/auth/me` → `{defaultPin:true}`. A wrong PIN → 401 `{remaining:4}`. 5 wrong → 429 with `retryAfter`, and even the correct PIN is 429 until the fake clock passes +60 s. Idle beyond `adminTimeoutMin` → `/api/auth/me` 401. Logout → 401 afterwards. PIN change: wrong current → 422, mismatch handled by the client, a short PIN → 422, success → `defaultPin:false` and the old PIN is rejected. A legacy sha256 hash (seeded via `setSettings`) logs in and is rehashed to `scrypt$`. A login posted as `text/plain` → 415. An expired session row is gone after the next login. Run: `RUN(auth.api)`.
- Depends on: 6a, 7, 13

### Phase 5 – Kiosk API

### Task 15: `src/punch.js` state machine
- Files: `src/punch.js`, `test/punch.test.js`
- Change: `punch(db, emp, type, now)` in a tx. `in` (no open shift) creates a shift. `bs` (open shift, no open break) adds a break. `be` (open break) closes it. `out` (open shift) closes the open break first, then sets `out`. Any other transition throws `HttpError` (from `src/errors.js`) `(409, 'Already clocked in' | 'Not clocked in' | 'Not on break' | 'Already on break')`. Writes the audit entry with actor = employee name and action = `Clock in | Break start | Break end | Clock out`. Detail is a short message like the legacy one but locale-neutral (`HH:MM` from `pad`). Returns `{type, at: now, shift, calc: pay.shift(...)}`.
- Test first: full sequence in → bs → be → out, with the result `calc.paid` correct for the fake times. Double `in` → 409. `be` without a break → 409. `out` during a break → that break's end equals out. There are 4 audit rows with the right actor. Run: `RUN(punch)`.
- Depends on: 6a, 8

### Task 16: Kiosk routes
- Files: `src/routes/kiosk.js`, `src/app.js`, `test/kiosk.api.test.js`
- Change: `GET /api/kiosk/info`, `POST /api/kiosk/identify`, `POST /api/kiosk/punch` as specified. A per-IP kiosk lockout of 5 fails / 30 s, writing the audit entry `Kiosk / Keypad locked / 5 wrong codes`. `identify` computes `todayPaid` (shifts whose `ymd(in)` is today) and `weekPaid` using `pay.week(loadData)`. The response contains no rates, no other employees and no pins.
- Test first: `info` keys are exactly the allow-list (assert `Object.keys` deep-equal). There is no `employees` key, and the JSON string contains no employee pin from the fixture. `identify` with a wrong pin → 401 `{remaining:4}`, and 5 → 429. An inactive employee → 401. A correct pin → `{employee:{id,name}}` only (no pin or rates). The punch flow updates `info.onShift` 0→1 and `onBreak` 0→1→0. `POST /api/kiosk/punch` sent as `text/plain` (valid body text) → 415 and no shift is created. **Isolation:** without a cookie, `GET /api/admin/state`, `/api/admin/audit`, `/api/admin/backup` and `/api/admin/export/payroll.xlsx` → 401 (written now; it stays green as those routes appear). Run: `RUN(kiosk.api)`.
- Depends on: 14, 15

### Phase 6 – Admin API

### Task 17: `src/validate.js`
- Files: `src/validate.js`, `test/validate.test.js`
- Change: pure functions that throw `ValidationError` (from `src/errors.js`): `validatePin(pin, employees, exceptId)` (legacy `validPin`). `validateEmployee(body)` → `{name (trimmed, required), pin, rate1/rate2 (''→null, ≥0 numbers), active}`. `validateShift({empId,in,out,breaks}, otherShiftsOfEmp)` is a port of legacy lines 1111-1128 (out > in; each break start ≥ in, start < out, end ≤ out, end > start; an open break with a closed shift → end = out; breaks sorted and non-overlapping; no clash with another shift of the same employee). `validateSettings(patch)` clamps as in legacy `settingsSave` (company default, tier ≥0, idle ≥5, timeout ≥1, maxShift ≥1, `breakMode ∈ {policy,actual,greater}`, `theme ∈ {auto,light,dark}`, rules filtered `h>0` and sorted) and rejects unknown keys. `validateAdjustment({week,empId,type,label,amount})` (amount > 0, week is a Monday `YYYY-MM-DD`, label defaults to `'—'`).
- Test first: one test per rule, including the edge cases "break ends exactly at clock-out is OK", "clash with an open shift (out null) is detected", "settings with `adminPinHash` key → rejected", "week not a Monday → rejected". Run: `RUN(validate)`.
- Depends on: 2, 6a

### Task 18: Admin routes – state, audit, employees, settings
- Files: `src/routes/admin.js`, `src/app.js`, `test/admin.employees.test.js`
- Change: `GET /state` (settings via `PUBLIC_SETTINGS` + `defaultPin`, employees with pins, shifts, adj, `undoLabel` placeholder null), `GET /audit`, employee POST/PUT/DELETE (409 when the employee has shifts; ids from `crypto.randomUUID()`), `PUT /settings`. Every mutation writes audit details like the legacy ones (`Add employee` / name, `Edit employee`, `Delete employee`, `Update settings`, `Theme`).
- Test first: create → it appears in `/state`, and the audit has `Add employee`. A duplicate pin → 422 with message "already used". Delete with shifts → 409. Settings `{breakMode:'policy'}` → `/state` reflects it. `{adminPinHash:'x'}` → 422. `/state` never contains `adminPinHash` (string search). Run: `RUN(admin.employees)`.
- Depends on: 14, 17

### Task 19: Admin routes – shifts, force clock-out, adjustments
- Files: `src/routes/admin.js`, `test/admin.shifts.test.js`
- Change: shift POST/PUT/DELETE through `validateShift`. `POST /shifts/:id/clock-out` (409 if already closed; ends the open break). Adjustments POST/DELETE. Audit actions: `Add shift`, `Edit shift`, `Delete shift`, `Force clock-out`, `Add adjustment`, `Remove adjustment`.
- Test first: an overlapping shift → 422 "Overlaps". A break outside the shift → 422. Edit replaces the breaks. Force clock-out on an open shift with an open break → both closed at the fake `now`. An adjustment appears in `/state.adj['2026-10-26|<id>']` with an `id`, and DELETE removes it (when it was the last one the key is gone). Run: `RUN(admin.shifts)`.
- Depends on: 18

### Task 20: Server-side undo
- Files: `src/undo.js`, `src/routes/admin.js`, `src/routes/auth.js` (clear on logout), `test/undo.test.js`
- Change: `withUndo(db, sessionKey, action, fn)` captures a before-image of each touched row (`{table:'employees'|'shifts'|'adjustments'|'settings', id, before: row+children|null}`), runs `fn` in a tx, then captures the **after-image** of the same rows (`after: row+children|null`) and pushes `{action, entries:[{table,id,before,after}]}` to an in-memory `Map<sessionHash, stack>` (max 30). `undo()` runs in one tx. It first re-reads every touched row and compares it (canonical JSON, breaks included) with its stored after-image. If any row differs (for example a kiosk punch, another admin, or an import changed it since), it throws `HttpError(409, 'Data changed since this action; cannot undo')`, and the entry **stays on the stack**. Otherwise it restores in reverse order (null → delete, otherwise upsert, with shifts restoring their breaks), writes the audit entry `Admin / Undo / <action>` and returns the label. Wrap the undoable admin mutations (everything except PIN change, theme and punches, matching the legacy `undoable` flags). Return `undoLabel` in `/state`. `POST /api/admin/undo` → `{undone: label}` or `{undone:null}`.
- Test first: delete a shift with breaks → undo restores the identical shift and breaks. Edit an employee → undo restores the old name and pin. Add an adjustment → undo removes it. Update settings → undo restores the previous rules. The stack is per session (agent B cannot undo agent A's change). After logout and login the stack is empty. The 31st push drops the oldest. **Conflict:** the admin edits an open shift (changes `in`), then a kiosk punch `out` closes that shift, then `POST /undo` → 409 with exactly `{error:"Data changed since this action; cannot undo"}`. The shift is still clocked out with the kiosk's `out` time, and `/state.undoLabel` is still `Edit shift`. Run: `RUN(undo)`.
- Depends on: 16, 19

### Task 21: Backup / import / erase routes
- Files: `src/routes/admin.js`, `test/admin.backup.test.js`
- Change: `GET /backup` (`Content-Disposition: attachment; filename="timeclock_backup_YYYY-MM-DD.json"`, audit `Backup downloaded`). `POST /import` (normalize + `importBackup`, returning counts, clearing all undo stacks, keeping the current admin session valid). `POST /erase` (needs `confirm:'ERASE'`, otherwise 422; wipes data, re-runs `ensureAdminPin`, audit `Erase all data`).
- Test first: import the v2 fixture → `/state` counts match. Then `/backup` → `normalizeBackup` succeeds and the employee/shift counts are equal (round trip). After import, logging in requires the fixture PIN `4321` (after a logout). Invalid JSON structure → 422 and the data is unchanged. Erase without confirm → 422, and with it → 0 employees and `defaultPin:true`. Run: `RUN(admin.backup)`.
- Depends on: 11, 20

### Phase 7 – Reports, Excel, PDF

### Task 22: Report model
- Files: `src/reports/model.js`, `test/report.model.test.js`
- Change: `buildWeekReport(data, ws, now, {empIds})` → `{company, currency, weekStart:'YYYY-MM-DD', weekEnd, tierHours, generatedAt, rows:[{empId,name,days[7],total,ded(min),paid,h1,h2,r1,r2,p1,p2,gross,allow,deduct,net,open, adjustments:[…], shifts:[{date,in,out,breaks:[{start,end}],calc}]}], totals, shiftsAll:[…sorted by in]}`. Rows sorted by name. It uses only `pay.week` and `pay.shift`, so the numbers match the UI exactly. `parseWeekParam(str)` → Monday ms (any date → its week), or throws a 400 `HttpError` (from `src/errors.js`) for an invalid value.
- Test first: on the imported v2 fixture, `report.totals.net` equals `pay.totals(pay.week(...)).net` (to 1e-9). Rows are sorted. Each row's `shifts` covers only that employee and week. The overnight shift appears with `out` on the next date. `parseWeekParam('2026-10-29')` = Monday 26th, and `'bad'` throws status 400. Run: `RUN(report.model)`.
- Depends on: 6a, 11

### Task 23: Excel workbook (`exceljs`)
- Files: `src/reports/xlsx.js`, `test/report.xlsx.test.js`
- Change: `payrollWorkbook(report)` → Buffer (`workbook.xlsx.writeBuffer()`). Sheet **Payroll**: title row (company + week), a header row matching the legacy CSV columns (`Employee`, Mon…Sun paid hrs, Worked hrs, Break deducted hrs, Paid hrs, `Hrs first N`, Rate 1, `Hrs after N`, Rate 2, Gross, Allowances, Deductions, Net pay), one row per employee as **numbers** (not strings), and a TOTAL row using `SUM()` formulas with a cached `result`. Formatting: bold inverted header (black fill, white font), `0.00` for hours, a currency format `"<sym>"#,##0.00` (quotes escaped), frozen header (`views:[{state:'frozen', ySplit:2}]`), autofilter, column widths, landscape page setup with fit-to-width. Sheet **Shifts**: Employee, Date, In, Out (or `OPEN`), Breaks (text `HH:MM–HH:MM; …`), Worked hrs, Break taken min, Break by rule min, Deducted min, Paid hrs. Sheet **Adjustments**: Employee, Type, Description, Amount. Workbook metadata: creator `Time Clock`, created = `generatedAt`. Every text cell (names, labels, descriptions) goes through `safeText(v)` from `format.js`, which prefixes `'` when the value starts with `= + - @` (the same rule as legacy `CSV.cell`: a leading `-` followed by a digit is a number and is left alone). It is always written as a string value, never as a formula.
- Test first: write the buffer and read it back with `new ExcelJS.Workbook().xlsx.load(buf)`. The sheet names are `['Payroll','Shifts','Adjustments']`. The header row values equal the expected array. The row for "Alice" has a numeric `Net pay` equal to the model's value. The TOTAL row's net cell has a formula containing `SUM(`. `numFmt` of the net cell contains the currency symbol. Payroll `views[0].state==='frozen'`. The Shifts row count equals `shiftsAll.length + 1`. An employee named `=HYPERLINK("x")` is stored as the string `'=HYPERLINK("x")` (no `formula` property), and an adjustment label `@cmd` → `'@cmd`. Run: `RUN(report.xlsx)`.
- Depends on: 22

### Task 24: PDF documents (`pdfkit`)
- Files: `src/reports/pdf.js`, `test/report.pdf.test.js`
- Change: `payrollPdf(report)` → Promise<Buffer> (collect the `data` chunks until `end`). A4 landscape. Header: company, "Weekly payroll", week range, generated-at. A table with the same columns as the Excel Payroll sheet, a bold TOTAL row, page breaks that repeat the header, and a footer "Page n of m" (`bufferPages:true`). The style follows the app: black rules and a monospace font. Font: register `DejaVuSansMono.ttf` and `DejaVuSansMono-Bold.ttf` from `dejavu-fonts-ttf/ttf/` (resolved with `createRequire(import.meta.url).resolve`) so that symbols such as `₹ € £` render. `payslipsPdf(report, empIds|'all')`: A4 portrait, **one page per employee**. Header (company, employee, week), a pay summary block (paid hours, h1×r1, h2×r2, gross, each allowance/deduction line, **Net pay**), then the timesheet table (date, in, out, breaks, worked, break deducted, paid) and a signature line. `info.Title` is set on both documents. Accepts `{compress}` to make tests easier.
- Test first: the buffer starts with `%PDF-` and ends with `%%EOF` (trimmed). `payslipsPdf` for 3 employees → the count of `/Type /Page\b` objects equals 3 (pdfkit writes page dicts uncompressed). The payroll report for a 40-employee synthetic dataset → page count > 1. The font check: the loaded font object reports `hasGlyphForCodePoint(0x20B9) === true` (fontkit API, called through the helper `loadFonts()` exported for the test). Payslips for an unknown employee id → throws `HttpError(404)`. Run: `RUN(report.pdf)`.
- Depends on: 22

### Task 25: Export routes
- Files: `src/routes/exports.js`, `src/app.js`, `test/exports.api.test.js`
- Change: the four export endpoints from the table. Correct `Content-Type` (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/pdf`, `text/csv; charset=utf-8`), `Content-Disposition: attachment; filename="payroll_2026-10-26.xlsx"`, `payroll_2026-10-26.pdf`, `payslips_2026-10-26.pdf` (or `payslip_<name-slug>_2026-10-26.pdf` for one employee), `audit_YYYY-MM-DD.csv`. The audit CSV uses the legacy `CSV.cell` escaping (moved into `format.js` as `safeText` + `csvCell`/`csvBuild` with a BOM, so cells starting with `= + - @` get a `'` prefix) and includes all audit rows. Every export writes an audit entry (`Export payroll xlsx`, …). `week` defaults to the current week.
- Test first: unauthenticated → 401 for all of them. Authenticated, with the fixture imported: the xlsx is 200, has the right content-type and filename and loads with ExcelJS. The PDFs are 200 and start with `%PDF-`. `week=bad` → 400 JSON. The audit CSV starts with the BOM, has a header `Timestamp,Who,Action,Detail` (quoted), and its row count equals the audit count + 1. An audit detail starting with `=` appears as `"'=..."`. Run: `RUN(exports.api)`.
- Depends on: 23, 24, 14

### Phase 8 – Frontend on the API

### Task 26: Copy the root app's markup/script into `public/` and serve statics (root `index.html` untouched)
- Files: `public/index.html`, `public/app.js`, `src/app.js`, `test/static.test.js`. **The root `index.html` stays untouched and is not served.**
- Change: move the `<style>` and markup into `public/index.html` and load `<script type="module" src="/app.js">`. Move the script body into `public/app.js`, importing from `/shared/format.js` and `/shared/pay.js` (delete the local duplicates in app.js). Express: `express.static(path.join(ROOT, 'public'))` and `app.use('/shared', express.static(path.join(ROOT, 'src/shared')))` with `Cache-Control: no-cache`. Paths come from `ROOT` (`import.meta.url`), never from cwd. At this step `Store` may still use localStorage, so the app keeps working while it is refactored. `Pay.*` call sites now pass `db()` explicitly (`Pay.week(db(), ws, now)`) and `money(n)` → `money(n, db().settings.currency)` through a local helper.
- Test first: `GET /` → 200 HTML containing `<script type="module" src="/app.js">`. `/app.js`, `/shared/pay.js` and `/shared/format.js` → 200 with `content-type` matching `/javascript/`. "shared modules have no DOM refs": the source of `src/shared/*.js` contains no `document`, `window` or `localStorage`. `/api/unknown` → 404 JSON (not the HTML). "cwd independent": `process.chdir(os.tmpdir())`, then `createApp(...)`, then `GET /app.js` → 200 (cwd restored in `t.after`). "root index.html untouched": it still exists, and `GET /` does not serve it (the response contains `type="module"`). "syntax check": `execFileSync(process.execPath, ['--check', 'public/app.js'])` exits 0. Run: `RUN(static)`.
- Depends on: 5, 14

### Task 27: Browser API client `public/api.js`
- Files: `public/api.js`, `test/api-client.test.js`
- Change: `api.get(path)`, `api.post/put/del(path, body)` with `credentials:'same-origin'` and a JSON body/content-type. They throw `ApiError {status, message, data}` built from `{error}`. A 401 on an `/api/admin` or `/api/auth/me` call dispatches `api.onUnauthorized` (a callback set by app.js). `api.download(path)` → sets `location.href` (the browser handles the attachment). It is a pure ES module with no top-level DOM access, so it can be tested in Node.
- Test first: stub `globalThis.fetch`. A post sends a JSON body, method and content-type. A `{error:'x'}` with status 422 rejects with `ApiError` status 422 and message 'x'. A 401 calls the `onUnauthorized` spy. A 204 resolves `null`. Extend `test/static.test.js` › "syntax check" to also run `node --check public/api.js`. Run: `RUN(api-client)` and `RUN(static)`.
- Depends on: 26

### Task 28: Kiosk UI on the API
- Files: `public/app.js`, `test/kiosk.flow.test.js`
- Change: the kiosk part of `Kiosk` uses `api`. `tick()` renders the clock from local time and shows the `onnow` text from the cached `/api/kiosk/info` (refreshed every 10 s and after each punch). `submit()` → `POST /api/kiosk/identify`; a 401 shows the toast "Code not recognised" plus shake; a 429 → `lockUntil = now + retryAfter*1000` with the existing countdown UI. `renderEmp()` uses the identify response (status, today/week, tier progress). `punch()` → `POST /api/kiosk/punch`, and the toast is built from the response (`calc.total/ded/paid` with `fmtHM`/`fmtMin`, time via `fmtTime(at)`). The kiosk keeps the entered PIN in memory only until the punch or idle reset, as today.
- Test first (API-level, mirrors exactly the sequence the kiosk UI performs): `test/kiosk.flow.test.js` › "kiosk sequence identify→in→identify shows on-shift→bs→be→out" asserts each response has the fields the UI reads (`employee.name`, `shift.in`, `shift.breaks`, `todayPaid`, `weekPaid`, `calc.paid`, `at`). Plus the static check "app.js kiosk does not call /api/admin" (the source between the `// ---------- Kiosk` and `// ---------- Admin` markers contains no `/api/admin`). Manual check (DoD list). Run: `RUN(kiosk.flow)`.
- Depends on: 16, 27

### Task 29a: Admin UI – RemoteStore, login/logout, refresh, onUnauthorized
- Files: `public/app.js`, `test/admin.session.flow.test.js`
- Change: replace `Store` with `RemoteStore { state, undoLabel, async refresh(), async call(method, path, body) /* → api, then refresh, then emit; disables the submitting form's buttons while in flight */ }`. Delete `Hash`, `ensureAdminPin`, `Store.persist/readDisk/syncFromDisk` and the `storage` listener. `Forms.adminLogin` → `POST /api/auth/login` (401 → "Wrong PIN (n tries left)" from `remaining`, 429 → the countdown from `retryAfter`), then `refresh()` and render. `Admin.logout` → `POST /api/auth/logout`. The idle timer stays client-side (it calls logout), and the server also expires the session: `api.onUnauthorized` → back to the kiosk with the toast "Admin session locked after inactivity". Refresh on `visibilitychange`/`focus` and every 30 s on the dashboard (replacing the `Admin.renderedAt` re-render). Views read `RemoteStore.state` through the existing `db()` helper.
- Test first: `test/admin.session.flow.test.js` › "login → state → idle expiry → 401 → login again": `/api/auth/login` responses carry `remaining`/`retryAfter` as the UI reads them. `/api/admin/state` has `settings`, `employees`, `shifts`, `adj`, `undoLabel`. After the fake clock passes the timeout, `/state` → 401. Static checks: `public/app.js` contains no `localStorage`, no `crypto.subtle`, and no `Hash.`; `node --check public/app.js` still passes. Run: `RUN(admin.session.flow)` and `RUN(static)`.
- Depends on: 20, 28

### Task 29b: Admin UI – CRUD mutations + server 422 toasts
- Files: `public/app.js`, `test/admin.crud.flow.test.js`
- Change: every Forms/Actions mutation calls its endpoint through `RemoteStore.call`: `empAdd`, `empSave`, `delEmp`, `shiftSave`, `delShift`, `forceOut`, `adjAdd`, `delAdj` (now by adjustment `id` instead of index), `settingsSave`, `themeCycle`, `pinChange`. The client still validates first for fast feedback (the existing toasts). `ApiError` 409/422 messages are shown as a toast (`Toast.show(err.message)`), and the modal stays open so the user can fix the input.
- Test first: `test/admin.crud.flow.test.js` › "CRUD as the UI does it": create an employee → shift → adjustment → edit settings → theme → delete the adjustment by `id`, asserting the shapes app.js reads (`state.employees[0].pin`, `state.adj[key][0].id`, `state.settings.theme`). An overlapping shift returns 422 with an `error` string suitable for a toast, and a duplicate pin returns 422 "already used". Run: `RUN(admin.crud.flow)` and `RUN(static)`.
- Depends on: 29a

### Task 29c: Admin UI – audit search + undo
- Files: `public/app.js`, `test/admin.audit-undo.flow.test.js`
- Change: Audit tab: `GET /api/admin/audit?q=&limit=300`, debounced 250 ms, rendered with the existing `auditRows` markup. The undo button and toast action → `POST /api/admin/undo`. `{undone:label}` → "Undone: label", `{undone:null}` → "Nothing to undo", and 409 → the server's message as a toast. The header shows `RemoteStore.undoLabel`.
- Test first: `test/admin.audit-undo.flow.test.js` › "delete shift → undo → audit shows Undo": `undoLabel` is `Delete shift` and then null after undo; `/audit?q=undo` returns the Undo row; and the conflict case returns 409 with an `error` string. Run: `RUN(admin.audit-undo.flow)` and `RUN(static)`.
- Depends on: 29b

### Task 30: Admin UI – exports, backup, restore, erase
- Files: `public/app.js`, `public/index.html` (no CSS changes needed; reuse `button`), `test/admin.backup.flow.test.js`
- Change: Weekly Report buttons: keep `Print`, `Export payroll CSV` and `Export shifts CSV` (client-side, unchanged), and add `Excel (.xlsx)`, `PDF report` and `Payslips PDF` → `api.download('/api/admin/export/…?week=' + ymd(ui.weekStart))`. Add a per-employee `Payslip` button in the report row actions (next to `± Adjust`). Audit tab `Export CSV` → `/api/admin/export/audit.csv`. Settings › Backup: the text changes to "All data is stored in the server database (data/timeclock.db). Daily snapshots are kept in data/backups." `Download backup` → `/api/admin/backup`. `Restore from backup` → read the file, `POST /api/admin/import` after the existing confirm modal. `Erase` → `POST /api/admin/erase {confirm:'ERASE'}`.
- Test first: `test/admin.backup.flow.test.js` › "restore then export": import the fixture through the API, then the xlsx/pdf/payslip URLs exactly as app.js builds them (`?week=2026-10-26`, `&emp=<id>`) return 200. The static check: `public/app.js` contains every export path string (`/api/admin/export/payroll.xlsx`, `payroll.pdf`, `payslips.pdf`, `audit.csv`, `/api/admin/backup`). Run: `RUN(admin.backup.flow)`.
- Depends on: 25, 29c

### Task 30a: Automatic DB snapshots
- Files: `src/snapshot.js`, `src/server.js`, `src/config.js` (already has `backupDir`/`backupKeep`), `test/snapshot.test.js`
- Change: `snapshot(db, dir, now)` → creates `dir` if needed and runs `VACUUM INTO '<dir>/timeclock-YYYY-MM-DD.db'` (local date of `now`). If that file already exists it is replaced by writing to a temp name and renaming it. Returns the path. Not supported for `:memory:` DBs, which return null. `prune(dir, keep)` keeps the newest `keep` files matching `timeclock-\d{4}-\d{2}-\d{2}\.db` and deletes the older ones (other files are left alone). `server.js` runs `snapshot` + `prune` once at startup and then every 24 h (`setInterval(...).unref()`), logging failures without crashing. It writes the audit entry `System / Snapshot / <file>`.
- Test first: `test/snapshot.test.js` › "snapshot opens and migrates cleanly": a file DB with one employee → `snapshot(db, tmp, d(2026,10,30))` → `timeclock-2026-10-30.db` exists; `openDb` + `migrate` on it succeed; the employee count is 1; `user_version` is 1. "same day overwrites": a second call the same day leaves one file. "prune keeps N": create 16 dated files plus `notes.txt` → `prune(dir, 14)` leaves the 14 newest dated files and `notes.txt`. "memory db" → null. Run: `RUN(snapshot)`.
- Depends on: 1, 6

### Phase 9 – Docs and full regression

### Task 31: End-to-end regression + README
- Files: `test/e2e.test.js`, `README.md`
- Change: an e2e test that starts the real `server.js` logic via `createApp` on a temp file DB (not memory), imports the fixture, does a kiosk day, makes an admin edit, exports, then **reopens the DB file** and checks that the data survived. README: requirements (Node ≥ 22.13), `npm install`, `npm start`, open http://localhost:3000, default admin PIN `0000` (change it right away), migrating from the old app (**export from the same `index.html` you always used** (same file, same browser), Admin → Settings → Download backup, then import through Admin → Restore from backup or `npm run import -- path\to\backup.json`. Check the employees, shifts and the weekly report, and **only then delete the old `index.html`**. Opening a copy at another path will not show your data. Both v1 and v2 backups are accepted.), where the data lives (`data/timeclock.db`; WAL mode also creates `timeclock.db-wal`/`-shm`, which belong to the DB, so never copy only the `.db` file while the server runs; use Download backup or the snapshots), automatic snapshots (`data/backups/timeclock-YYYY-MM-DD.db`, at startup and every 24 h, newest 14 kept, `BACKUP_DIR`/`BACKUP_KEEP`; to restore, stop the server and copy a snapshot over `data/timeclock.db`), starting at boot on Windows (Task Scheduler: "At startup" task running `npm start` in the project folder, or `node --disable-warning=ExperimentalWarning src/server.js`), env vars `PORT`/`HOST`/`DB_PATH`/`BACKUP_DIR`/`BACKUP_KEEP`/`TZ`, LAN kiosk (`HOST=0.0.0.0`, security note), `npm test`, and the API endpoint table.
- Test first: `test/e2e.test.js` › "data persists across restart" and "exports after kiosk day contain the new shift" (the xlsx Shifts sheet row count grows by 1). `test/readme.test.js` › README mentions `npm install`, `npm start`, `npm run import`, `0000`, "same `index.html`", "only then delete", `-wal`, `data/backups`, `Task Scheduler`. The README does **not** tell the user to export from `legacy/index.html`. Run: `RUN(e2e)` and `RUN(readme)`, then the full `npm test`.
- Depends on: 30, 30a

---

## Libraries/frameworks involved (for context7-modernizer)
| Library | Version target | What to check |
|---|---|---|
| **Node.js** `node:sqlite` (`DatabaseSync`, `StatementSync`) | Node 22.14 (installed) | Is it unflagged in 22.13+? Named-parameter syntax, `.get/.all/.run` return shapes, integer handling, `exec` for PRAGMA, and the ExperimentalWarning plus `--disable-warning` flag |
| **better-sqlite3** | latest (alternative only) | Prebuilt binary for win-x64 / Node 22, in case we swap |
| **Express** | 5.x | Express 5 changes: async error forwarding, path-to-regexp v8 route syntax, `req.query` getter, `express.json`/`express.static` options, `res.cookie` / `res.attachment` |
| **exceljs** | 4.x | `writeBuffer`/`load`, styles (fill/font/numFmt), `views` frozen panes, `autoFilter`, formula cells with `result`, `pageSetup` fitToWidth |
| **pdfkit** | 0.15+/0.17 | `bufferPages`/`switchToPage` for "Page n of m", `registerFont` with TTF, table drawing (manual vs the newer built-in `doc.table()` in recent versions), `info` metadata, `compress` option |
| **fontkit** (pdfkit dependency) | via pdfkit | `font.hasGlyphForCodePoint` API used in the test |
| **dejavu-fonts-ttf** | 2.37.x | Package file paths (`ttf/DejaVuSansMono.ttf`, `-Bold`), licence, `₹` (U+20B9) coverage. If it lacks `₹`, pick Noto Sans Mono TTF instead |
| **supertest** | 7.x | `request.agent(app)` cookie persistence, use with ESM |
| **node:test** / `node:assert` | Node 22 | `--test` glob support on Windows (quoted pattern in npm script), `describe/it`, `mock.timers` (optional), `t.after` cleanup. **Verify whether `--disable-warning=ExperimentalWarning` given to `node --test` reaches the per-file child processes**; if not, use `NODE_OPTIONS=--disable-warning=ExperimentalWarning` (cross-platform, e.g. set in a tiny `scripts/test.js` launcher, since `cmd.exe` has no inline env syntax) |
| SQLite `VACUUM INTO` | via node:sqlite | Available in the bundled SQLite version (≥3.27); behaviour with WAL |
| **node:crypto** | Node 22 | `scrypt` params/`maxmem`, `timingSafeEqual` (equal-length requirement), `randomBytes`, `randomUUID`, `createHash` |
| Google Fonts **Space Mono** | (frontend, unchanged) | No change; it still loads from fonts.googleapis.com |

## Definition of done
- `npm install` then `npm start` on Windows with Node 22.14 runs with no native build and no warnings printed. http://localhost:3000 shows the kiosk with the same look as today.
- `npm test` is green (every task's test file), including the regression checks that the pay numbers from the DB/API equal the legacy `Pay` numbers for the fixture.
- All data (employees, shifts, breaks, adjustments, settings, audit) lives in `data/timeclock.db` and survives a restart. `public/app.js` does not use localStorage.
- The kiosk endpoints return no admin data, and every `/api/admin/*` and export endpoint returns 401 without a session.
- The admin PIN is stored as scrypt. The session cookie is HttpOnly and SameSite=Strict, sessions idle out on the server, lockout works (5 tries), and legacy hashes are upgraded on login.
- Excel (Payroll / Shifts / Adjustments sheets, formatted) and PDF (weekly report, payslips one page per employee, `₹` renders) download from the Weekly Report tab.
- A legacy backup imports through the UI and through `npm run import`. `GET /api/admin/backup` re-imports losslessly.
- Manual smoke checklist passed: clock in/break/out on the kiosk, a wrong code 5× locks, admin login, add/edit/delete an employee, add/edit a shift with breaks (the timeline updates), force clock-out, adjustments, undo, change settings and see the report recalculate, theme cycle, change PIN, auto-lock after the timeout, print, open the Excel file in Excel, open the PDFs.
- The root `index.html` is still present and unchanged. The user deletes it only after checking the import.
- Snapshots appear in `data/backups` at startup, and at most 14 are kept.
- Undo refuses (409) when the data changed after the action, and nothing is lost.
- Every state-changing `/api/*` request without a JSON content-type gets 415.
- README is complete.

## Risks
- **`node:sqlite` is experimental.** Its API may change between Node releases. Mitigation: everything goes through `src/db.js`, `engines` pins `>=22.13`, and switching to `better-sqlite3` changes one file (add a `tx` mapping to `.transaction`).
- **Timezone/DST:** the server's local TZ decides week and day attribution. A server in a different TZ from the site would shift days. Mitigation: assumption 1, the README `TZ` note, and tests built with local dates. A DST-week shift is computed in real elapsed minutes (as today).
- **Float money:** totals could differ from Excel's own SUM by cents in rare cases. Mitigation: the SUM formulas carry cached results computed from the same numbers; integer cents are out of scope.
- **Kiosk PIN guessing over the LAN** (10k space, 5 tries/30 s per IP, and an IP can rotate). This matches legacy behaviour. Mitigation: default bind is 127.0.0.1, the README warns about `HOST=0.0.0.0`, and lockouts are audited.
- **Moving the UI from synchronous to async** (await on every mutation) can bring race conditions or double submits. Mitigation: `RemoteStore.call` disables the submitting form's buttons while in flight and always re-fetches state after a mutation.
- **The undo before-image approach** must cover every table each mutation touches (shift + breaks). Mitigation: the Task 20 tests cover each undoable action type.
- **The PDF font package** may not include `₹`, or its paths may differ. Mitigation: the Task 24 glyph test fails loudly, with Noto Sans Mono as the fallback.
- **Full state download** (`/api/admin/state` returns all shifts) grows over the years. It is fine for a small business (thousands of rows). Possible later improvement: a date-range query param.
- **Losing the user's existing data during migration:** the data only exists in the browser's localStorage for the root `index.html`'s origin. Mitigation: we never touch that file; the README says to export from it, import, check, and only then delete it; the importer accepts v1 and v2.
- **Undo after concurrent change** (a kiosk punch between an edit and its undo) could overwrite real punches. Mitigation: the after-image check returns 409 (Task 20).
- **Express 5 / exceljs / pdfkit API drift:** context7-modernizer checks these before coding starts.

---

## Build status (2026-10-30)
All tasks done: 1, 2, 3, 4, 5, 6, 6a, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29a, 29b, 29c, 30, 30a, 31. `npm test` → 115/115 passing. Real-browser smoke test (headless Chrome) passed.

Deviations from the plan (all deliberate):
- **Excel text cells** are written as plain string values with no `'` prefix (leader note 1): exceljs never turns a string into a formula, and a prefix would show a literal apostrophe. `safeText` is used only for CSV.
- **PDF tables** are drawn manually with `doc.text` + rules, not `doc.table()`: pdfkit 0.20.2 ships no docs/types for the table API, and context7-modernizer warned against guessing its options.
- **Tasks 28–30 tests** are combined in `test/ui.flows.test.js` plus `test/static.test.js` (same assertions, one file).
- **Red step skipped** for `test/backup.import.test.js` (Task 11) and `test/ui.flows.test.js` (Tasks 28–30): the code they cover was already written when the tests were added, so they went straight to green.
- **Payroll/shifts CSV** stay client-side (assumption 9); the audit CSV is server-side.
