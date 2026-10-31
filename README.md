# Time Clock

Employee time-clock **kiosk** + **admin** app with a real database, PDF and Excel exports.

- Staff clock in/out and take breaks on the kiosk with a 4-digit code.
- Admins manage employees, shifts, break rules, tiered pay (Rate 1 for the first N hours a week, Rate 2 after), allowances/deductions, and see a live dashboard, alerts, a shift timeline and a full audit log, with undo.
- Everything is stored in a **SQLite database** (`data/timeclock.db`) on the server.
- Exports: **Excel** payroll workbook (Payroll / Shifts / Adjustments sheets), **PDF** weekly payroll report, **PDF** timesheet + payslip per employee, CSV (payroll, shifts, audit log) and a JSON backup.

## Requirements

- Windows, macOS or Linux with **Node.js 22.13 or newer** (`node -v`). Nothing to compile: the database uses Node's built-in `node:sqlite`.

## Install and run

```bash
npm install
npm start
```

Open **http://localhost:3000**. The kiosk appears; tap **Admin** and sign in with the default admin PIN **`0000`**. Change it straight away under Admin → Settings → Change admin PIN (the dashboard keeps reminding you until you do).

Stop the server with `Ctrl+C`.

## Moving your data from the old browser-only version

The old app kept everything inside the browser that opened `index.html`. To bring it across:

1. Open the **same `index.html` you have always used** — same file, same browser. (A copy at another path, or another browser, cannot see your data.)
2. Admin → Settings → **Download backup**. Keep the `.json` file safe.
3. Start this app (`npm start`), sign in as admin with `0000`, go to Settings → **Restore from backup** and pick the file.
   Or from a terminal: `npm run import -- path\to\timeclock_backup.json` (add `--replace` if the database already has data).
4. Check the employees, shifts and the Weekly Report. The admin PIN is now the one from your old app.
5. **Only then delete** the old `index.html` if you want to. Nothing in this project moves or changes it.

Both old backup formats (v1 and v2) are accepted.

## Where the data lives

| What | Where |
|---|---|
| Database | `data/timeclock.db` |
| Write-ahead log | `data/timeclock.db-wal` and `data/timeclock.db-shm` — part of the database while the server runs. **Never copy only the `.db` file of a running server**; use Download backup or a snapshot. |
| Automatic snapshots | `data/backups/timeclock-YYYY-MM-DD.db` |

**Snapshots** are taken when the server starts and every 24 hours; the newest 14 are kept (`BACKUP_KEEP`). To restore one: stop the server, copy the snapshot over `data/timeclock.db` (delete `timeclock.db-wal` / `-shm` first), start again.

You can also download a portable JSON backup any time from Admin → Settings → Download backup.

## Roster and pay rounding

The **Roster** tab is the weekly staff × day grid (Cafe, Bakery, Training, Delivery, Bake, Bakery YC, Off). Tap a day to add shifts (type `9.30` + AM/PM, or `17:00`) or use the presets, press **Done**, then **Save roster** to store the changes. You can also copy a week forward, clear a week, or download the **Roster PDF**. Page 1 is the roster to post up for staff, with no hours on it. The last page is an **admin-only overview** with everyone's rostered hours per day, the week total and days off.

**Import old roster** copies everything from the old GJ06 roster app (or an exported JSON file). It always shows a preview first: the date range, matched staff, new staff (they get a random kiosk code, shown once), and how many already-worked shifts would be re-priced. The old app saved every day one day early (a UTC bug), so the import moves dates **+1 day** by default; you can change that in the preview. Re-running the import is safe — it remembers which old staff member is which employee and changes nothing that is already the same.

When **Rounding starts** (Settings → Pay rules) is set to a Monday, paid times follow the roster from that week on:

- Clock-in or clock-out within **±6 minutes** of the rostered time → paid from/to the rostered time.
- Late start → rounded **up** to the next quarter hour (9:08 → 9:15). Tagged **LATE**.
- Early start → paid from the rostered start (while still clocked in before the start, nothing is earned yet).
- A shift that finishes at or before the rostered start → not matched to the roster; paid actual time.
- Leaving early → rounded **down** to the quarter hour. Tagged **EARLY**.
- Staying past the rostered finish → overtime is paid (rounded down to the quarter hour) and tagged **OT** on the Shifts page and payslip.
- No roster that day → actual times.

Raw clock times are never changed: the Shifts page always shows actual and paid times side by side, and earlier weeks are never re-priced. **Note:** most of these rules favour the employer. Check them against your award / Fair Work obligations before relying on them; you can switch rounding off at any time.

## Employees, payslips and reminders

Employees can be paid **hourly** (Rate 1 for the first N hours a week, Rate 2 after), a **fixed rate** (one rate for every hour) or a **fixed weekly salary**. Each can have an email, phone, birthday, start date and **fixed weekly allowances/deductions** that apply automatically every week they are paid. The dashboard shows birthdays and work anniversaries coming up in the next 7 days.

**Emailing payslips** uses [Brevo](https://www.brevo.com) (free plan ≈300 emails/day), because Railway's Hobby plan blocks normal email (SMTP):

1. Create a free Brevo account and add your sender address under *Senders & IPs* (verify it).
2. Create an API key (*SMTP & API → API keys*). Under *Security → Authorised IPs*, turn IP blocking **off** for this key — Railway's address changes.
3. Set `BREVO_API_KEY` and `MAIL_FROM` (and optionally `MAIL_FROM_NAME`, `MAIL_REPLY_TO`) on the server.
4. Send yourself one payslip first (Weekly Report → **Email**) and check it arrives in the inbox, not spam. A Gmail address as `MAIL_FROM` may be flagged by Gmail; a small domain of your own (e.g. `payroll@yourshop.com.au`, verified in Brevo) is the reliable option.

Each send is written to the audit log; "Email all payslips" shows when that week was last sent and cannot run twice at once.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Interface to listen on. Only this computer can connect by default. |
| `DB_PATH` | `data/timeclock.db` | Database file |
| `BACKUP_DIR` | `data/backups` | Snapshot folder |
| `BACKUP_KEEP` | `14` | Snapshots to keep |
| `TZ` | system | Timezone used for days, weeks and roster times. On Railway this is set: `TZ=Australia/Sydney`. |
| `BREVO_API_KEY` | – | Brevo API key for payslip emails (keep it secret; set it as a Railway variable) |
| `MAIL_FROM` | – | Verified Brevo sender address |
| `MAIL_FROM_NAME`, `MAIL_REPLY_TO` | – | Optional sender name and reply-to address |
| `ROSTER_IMPORT_URL` | old roster app | Where **Import old roster** fetches from |

Before upgrading a live database the server saves a copy next to it (`timeclock-premigrate-v1-….db`).

On Windows PowerShell: `$env:PORT=8080; npm start`.

### Kiosk on a tablet or another computer

Start with `HOST=0.0.0.0` (PowerShell: `$env:HOST="0.0.0.0"; npm start`) and open `http://<this-computer's-IP>:3000` on the tablet. Only do this on a network you trust: anyone on it can reach the kiosk, and the admin area is protected only by the admin PIN (5 wrong tries lock it for 60 seconds).

### Start automatically when Windows boots

Use **Task Scheduler** → Create Task → Trigger "At startup" → Action "Start a program":
- Program: `node`
- Arguments: `--disable-warning=ExperimentalWarning src/server.js`
- Start in: this project folder

## Security

- Admin PIN stored as a salted **scrypt** hash; old-app hashes are upgraded on first login.
- Admin sessions use an HttpOnly, SameSite=Strict cookie and expire after the idle time set in Settings (default 5 minutes).
- 5 wrong admin PINs → 60 s lockout; 5 wrong kiosk codes → 30 s lockout; both are written to the audit log.
- The kiosk API only ever returns the name and hours of the employee whose code was typed — never rates, codes or other staff.
- Every state-changing API call must be JSON (cross-site form posts are rejected).

## Development

```bash
npm test
```

Runs the whole suite with Node's built-in test runner (unit, API, export and end-to-end tests).

| Folder | Contents |
|---|---|
| `src/shared/` | Pay and formatting code used by **both** the server and the browser |
| `src/` | Express app, database, auth, validation, undo, backup, snapshots |
| `src/reports/` | Report model, Excel (`exceljs`) and PDF (`pdfkit`) generation |
| `public/` | The web UI (`index.html`, `app.js`, `api.js`) |
| `scripts/import-backup.js` | `npm run import` |
| `test/` | Tests and fixtures |

### API overview

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/kiosk/info` | anyone | Company, theme, on-shift counts |
| `POST /api/kiosk/identify` `{pin}` | anyone | Who is this code |
| `POST /api/kiosk/punch` `{pin,type}` | anyone | `in` / `bs` / `be` / `out` |
| `POST /api/auth/login` `{pin}` · `/logout` · `GET /me` · `POST /pin` | admin | Session and PIN |
| `GET /api/admin/state` · `GET /audit` | admin | Data for the admin screens |
| `POST/PUT/DELETE /api/admin/employees`, `/shifts`, `/adjustments`; `PUT /settings` | admin | Changes (undoable) |
| `POST /api/admin/shifts/:id/clock-out` · `POST /undo` | admin | Force clock-out, undo |
| `GET /api/admin/backup` · `POST /import` · `POST /erase` | admin | Backup and restore |
| `GET /api/admin/export/payroll.xlsx` · `payroll.pdf` · `payslips.pdf?emp=` · `audit.csv` | admin | Exports (`?week=YYYY-MM-DD`) |
