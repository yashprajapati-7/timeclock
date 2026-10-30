import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root resolved from this file, never from process.cwd().
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '127.0.0.1',
    dbPath: env.DB_PATH || path.join(ROOT, 'data', 'timeclock.db'),
    backupDir: env.BACKUP_DIR || path.join(ROOT, 'data', 'backups'),
    backupKeep: Number(env.BACKUP_KEEP) || 14,
    // Number of reverse proxies in front of the app (1 on Railway); false when serving directly.
    trustProxy: Number(env.TRUST_PROXY) || false,
  };
}
