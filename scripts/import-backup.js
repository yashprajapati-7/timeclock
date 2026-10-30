// Usage: npm run import -- <backup.json> [--db <path>] [--replace]
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { importBackup } from '../src/backup.js';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db');
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : loadConfig().dbPath;
const fail = msg => { console.error(msg); process.exit(1); };

if(!file) fail('Usage: npm run import -- <backup.json> [--db <path>] [--replace]');
let json;
try{ json = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch(e){ fail(`Cannot read ${file}: ${e.message}`); }

const db = openDb(dbPath);
migrate(db);
const used = db.get('SELECT (SELECT COUNT(*) FROM employees) + (SELECT COUNT(*) FROM shifts) n').n;
if(used && !args.includes('--replace')){ db.close(); fail('Database not empty, use --replace to overwrite it'); }
try{
  const c = await importBackup(db, json);
  console.log(`Imported ${c.employees} employees, ${c.shifts} shifts, ${c.adjustments} adjustments, ${c.audit} audit entries into ${dbPath}`);
}catch(e){ fail(`Import failed: ${e.message}`); }
finally{ db.close(); }
