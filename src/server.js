// Entry point: config → database → admin PIN → snapshots → HTTP server.
import { loadConfig } from './config.js';
import { openDb, migrate } from './db.js';
import { createApp } from './app.js';
import { ensureAdminPin } from './routes/auth.js';
import { snapshot, prune } from './snapshot.js';
import { addAudit } from './repo.js';

const config = loadConfig();
const db = openDb(config.dbPath);
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

const server = createApp({ db, trustProxy: config.trustProxy }).listen(config.port, config.host, () => {
  console.log(`Time Clock running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Database: ${config.dbPath}`);
});

const shutdown = () => { server.close(() => { db.close(); process.exit(0); }); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
