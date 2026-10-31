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
  // 2: roster, richer employees (pay type, contact, dates, recurring items), overtime approval. Additive only.
  `
  ALTER TABLE employees ADD COLUMN role TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'hourly' CHECK(pay_type IN ('hourly','salary'));
  ALTER TABLE employees ADD COLUMN weekly_salary REAL;
  ALTER TABLE employees ADD COLUMN email TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN phone TEXT NOT NULL DEFAULT '';
  ALTER TABLE employees ADD COLUMN birthday TEXT;
  ALTER TABLE employees ADD COLUMN start_date TEXT;
  ALTER TABLE employees ADD COLUMN fixed_items TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE shifts ADD COLUMN ot_ok INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE roster (id INTEGER PRIMARY KEY,
    emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('CAFE','BAKERY','TRAINING','OFF','DELIVERY','BAKE','BAKERY YC')),
    start_hm TEXT, end_hm TEXT, position INTEGER NOT NULL,
    CHECK((type IN ('CAFE','BAKERY','TRAINING')) = (start_hm IS NOT NULL AND end_hm IS NOT NULL)));
  CREATE INDEX roster_day_emp ON roster(day, emp_id);
  `,
  // 3: allow the 'fixed' pay type (one rate for all hours). SQLite can't alter a CHECK, so employees is rebuilt
  // (create new → copy with rowid → drop old → rename new; foreign keys off so children are untouched).
  { foreignKeysOff: true, sql: `
  CREATE TABLE employees_new (id TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL UNIQUE CHECK(length(pin)=4),
    rate1 REAL, rate2 REAL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT '', pay_type TEXT NOT NULL DEFAULT 'hourly' CHECK(pay_type IN ('hourly','fixed','salary')),
    weekly_salary REAL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', birthday TEXT, start_date TEXT,
    fixed_items TEXT NOT NULL DEFAULT '[]');
  INSERT INTO employees_new (rowid, id, name, pin, rate1, rate2, active, created_at, role, pay_type, weekly_salary, email, phone, birthday, start_date, fixed_items)
    SELECT rowid, id, name, pin, rate1, rate2, active, created_at, role, pay_type, weekly_salary, email, phone, birthday, start_date, fixed_items FROM employees;
  DROP TABLE employees;
  ALTER TABLE employees_new RENAME TO employees;
  ` },
  // 4: payments given to staff (cash or bank), recorded against the pay week they are for.
  `
  CREATE TABLE payments (id INTEGER PRIMARY KEY,
    emp_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    week_start TEXT NOT NULL, paid_on TEXT NOT NULL,
    method TEXT NOT NULL CHECK(method IN ('cash','bank')), amount REAL NOT NULL CHECK(amount > 0),
    note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  CREATE INDEX payments_week_emp ON payments(week_start, emp_id);
  `,
];
