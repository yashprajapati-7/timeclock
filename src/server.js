// Entry point: config → database → admin PIN → snapshots → HTTP server.
import { loadConfig } from './config.js';
import { openDb, migrate, pendingMigrations } from './db.js';
import { createApp } from './app.js';
import { ensureAdminPin } from './routes/auth.js';
import { snapshot, snapshotBeforeMigrate, prune } from './snapshot.js';
import { addAudit } from './repo.js';
import { gracefulShutdown } from './shutdown.js';
import { createMailer } from './mail.js';

const config = loadConfig();
const db = openDb(config.dbPath);
// Existing database about to be upgraded: keep a rollback copy on the same volume first.
if(pendingMigrations(db) > 0 && db.get("SELECT 1 x FROM sqlite_master WHERE name = 'employees'")){
  console.log(`Pre-migration snapshot: ${snapshotBeforeMigrate(db)}`);
}
migrate(db);
await ensureAdminPin(db);

function backupNow(){
  try{
    const file = snapshot(db, config.backupDir, Date.now());
    prune(config.backupDir, config.backupKeep);
    if(file) addAudit(db, { ts: Date.now(), actor: 'System', action: 'Snapshot', detail: file });
  }catch(e){ console.error('Snapshot failed:', e.message); }
}
backupNow();
setInterval(backupNow, 24 * 3600 * 1000).unref();

const server = createApp({ db, trustProxy: config.trustProxy, rosterImportUrl: config.rosterImportUrl, backupDir: config.backupDir, mailer: createMailer(process.env) }).listen(config.port, config.host, () => {
  console.log(`Time Clock running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Database: ${config.dbPath}`);
});

const shutdown = gracefulShutdown({ server, db });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
