import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import type { Config } from './config.js';
import { schemaVersion, type Db } from './db/index.js';
import { PlexClient } from './plex/client.js';
import { SyncService, type SyncOptions } from './sync/service.js';
import { registerApiRoutes } from './api/routes.js';
import { ImageCache } from './images/cache.js';

declare module 'fastify' {
    interface FastifyInstance {
        sync: SyncService;
    }
}

export interface AppDeps {
    config: Config;
    db: Db;
    plex?: PlexClient;
    syncOptions?: SyncOptions;
}

export const buildApp = async ({ config, db, plex, syncOptions }: AppDeps): Promise<FastifyInstance> => {
    const app = Fastify({ logger: { level: config.logLevel } });
    const plexClient = plex ?? new PlexClient({ url: config.plexUrl, token: config.plexToken });
    const sync = new SyncService(db, plexClient, app.log, syncOptions);
    app.decorate('sync', sync);

    await app.register(fastifyCompress);

    app.get('/api/health', async () => ({
        status: 'ok',
        schemaVersion: schemaVersion(db)
    }));
    const images = new ImageCache(config.dataDir, db, plexClient, app.log);
    registerApiRoutes(app, { db, sync, images });

    await app.register(fastifyStatic, { root: config.publicDir });

    return app;
};
