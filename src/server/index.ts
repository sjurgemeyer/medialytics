import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { buildApp } from './app.js';
import { startSyncSchedule } from './sync/scheduler.js';
import { resolveVersion } from './version.js';

const config = loadConfig();
const db = openDatabase(join(config.dataDir, 'mediadata.db'));
const version = resolveVersion();
const app = await buildApp({ config, db, version });
app.log.info({ version }, 'starting MediaData');

let stopSchedule: () => void = () => {};

const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stopSchedule();
    await app.close();
    db.close();
    process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
stopSchedule = startSyncSchedule(app.sync, config.syncIntervalMinutes);
