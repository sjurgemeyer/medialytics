import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { schemaVersion, type Db } from './db/index.js';

export interface AppDeps {
    config: Config;
    db: Db;
}

// The frontend scripts call Plex directly and expect the server URL and token substituted in
const plexConfiguredScripts = ['scripts.js', 'cast-crew.js'];

export const buildApp = async ({ config, db }: AppDeps): Promise<FastifyInstance> => {
    const app = Fastify({ logger: { level: config.logLevel } });

    await app.register(fastifyCompress);

    app.get('/api/health', async () => ({
        status: 'ok',
        schemaVersion: schemaVersion(db)
    }));

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
