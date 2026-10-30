// Ordered schema migrations; index + 1 = PRAGMA user_version after applying.
export const migrations = [
  `
  CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL UNIQUE CHECK(length(pin)=4),
    rate1 REAL, rate2 REAL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
  CREATE TABLE shifts (id TEXT PRIMARY KEY, emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    clock_in INTEGER NOT NULL, clock_out INTEGER, CHECK(clock_out IS NULL OR clock_out > clock_in));
  CREATE INDEX shifts_emp_in ON shifts(emp_id, clock_in);
  CREATE INDEX shifts_open ON shifts(emp_id) WHERE clock_out IS NULL;
  CREATE TABLE breaks (id INTEGER PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    start_at INTEGER NOT NULL, end_at INTEGER);
  CREATE INDEX breaks_shift ON breaks(shift_id);
  CREATE TABLE adjustments (id INTEGER PRIMARY KEY, week_start TEXT NOT NULL,
    emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('allowance','deduction')), label TEXT NOT NULL, amount REAL NOT NULL, position INTEGER NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
  CREATE INDEX audit_ts ON audit(ts DESC);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
  `,
];
