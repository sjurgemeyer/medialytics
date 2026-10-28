import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { schemaVersion, type Db } from './db/index.js';
import { PlexClient } from './plex/client.js';
import { SyncService, type SyncOptions } from './sync/service.js';
import { registerApiRoutes } from './api/routes.js';

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

// The frontend scripts call Plex directly and expect the server URL and token substituted in
const plexConfiguredScripts = ['scripts.js', 'cast-crew.js'];

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
    registerApiRoutes(app, { db, sync });

    for (const script of plexConfiguredScripts) {
        app.get(`/js/${script}`, async (_request, reply) => {
            const source = await readFile(join(config.publicDir, 'js', script), 'utf8');
            reply.type('application/javascript; charset=utf-8');
            return source.replaceAll('SERVER_IP', config.plexUrl).replaceAll('SERVER_TOKEN', config.plexToken);
        });
    }

    app.get('/official', async (_request, reply) => reply.sendFile('official.html'));

    await app.register(fastifyStatic, { root: config.publicDir });

    return app;
};
