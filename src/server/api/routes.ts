import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Db } from '../db/index.js';
import { itemDetail, libraryItems, listLibraries, personDetail } from '../db/queries.js';
import { imageWidths, type ImageCache } from '../images/cache.js';
import type { SyncService } from '../sync/service.js';

export interface ApiDeps {
    db: Db;
    sync: SyncService;
    images: ImageCache;
    version: string;
}

const idParam = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer', minimum: 1 } }
} as const;

// Distinguishes this process's data versions from a previous run's, since the counter restarts at 0
const bootId = randomUUID().slice(0, 8);

export const registerApiRoutes = (app: FastifyInstance, { db, sync, images, version }: ApiDeps): void => {
    app.get('/api/libraries', async () => ({
        version,
        libraries: listLibraries(db),
        sync: sync.status()
    }));

    // The whole library in one response. Browsers revalidate with the ETag, which changes whenever a sync writes data.
    app.get<{ Params: { id: number } }>('/api/libraries/:id/items', { schema: { params: idParam } }, async (request, reply) => {
        const etag = `W/"${bootId}-${sync.dataVersion()}-${request.params.id}"`;
        reply.header('Cache-Control', 'no-cache').header('ETag', etag);
        if (request.headers['if-none-match'] === etag) {
            return reply.code(304).send();
        }
        const result = libraryItems(db, request.params.id);
        if (!result) return reply.code(404).send({ error: 'Library not found' });
        return { ...result, sync: sync.status() };
    });

    app.get<{ Params: { id: number } }>('/api/items/:id', { schema: { params: idParam } }, async (request, reply) => {
        const item = itemDetail(db, request.params.id);
        return item ?? reply.code(404).send({ error: 'Item not found' });
    });

    app.get<{ Params: { id: number } }>('/api/people/:id', { schema: { params: idParam } }, async (request, reply) => {
        const person = personDetail(db, request.params.id);
        return person ?? reply.code(404).send({ error: 'Person not found' });
    });

    // Starts a sync in the background; ?full=1 re-fetches every title's credits
    app.post<{ Querystring: { full?: string } }>('/api/sync', async (request, reply) => {
        const full = request.query.full === '1' || request.query.full === 'true';
        const alreadyRunning = sync.isRunning();
        void sync.run({ full });
        return reply.code(202).send({ started: !alreadyRunning, status: sync.status() });
    });

    app.get('/api/sync/status', async () => sync.status());

    // Artwork resized by Plex and cached on disk. URLs that carry a version (?v=) change whenever the
    // artwork does, so browsers may keep them forever; unversioned URLs are cached for a day.
    app.get<{ Params: { kind: 'poster' | 'person'; id: number }; Querystring: { w?: number; v?: string } }>('/api/images/:kind/:id', {
        schema: {
            params: {
                type: 'object',
                required: ['kind', 'id'],
                properties: { kind: { type: 'string', enum: ['poster', 'person'] }, id: { type: 'integer', minimum: 1 } }
            },
            querystring: {
                type: 'object',
                properties: { w: { type: 'integer', minimum: 1, maximum: imageWidths[imageWidths.length - 1] }, v: { type: 'string', maxLength: 64 } }
            }
        }
    }, async (request, reply) => {
        const image = await images.get(request.params.kind, request.params.id, request.query.w ?? 160);
        if (!image) return reply.code(404).send({ error: 'Image not found' });
        reply
            .type(image.contentType)
            .header('Cache-Control', request.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=86400');
        return reply.send(createReadStream(image.path));
    });
};
