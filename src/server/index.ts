import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = openDatabase(join(config.dataDir, 'mediadata.db'));
const app = await buildApp({ config, db });

const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    db.close();
    process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
