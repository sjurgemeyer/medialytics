import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/server/db/index.js';
import { PlexClient } from '../src/server/plex/client.js';
import { buildApp } from '../src/server/app.js';
import { snapWidth } from '../src/server/images/cache.js';
import type { LibraryItemsResponse } from '../src/server/db/queries.js';
import { FakePlex, fakeImage } from './fixtures/fake-plex.js';
import { testConfig } from './helpers.js';

describe('images', () => {
    let plex: FakePlex;
    let app: FastifyInstance;
    let dataDir: string;
    let library: LibraryItemsResponse;

    const transcodes = () => plex.requests.filter(path => path.startsWith('/photo/:/transcode'));
    const get = (url: string) => app.inject({ method: 'GET', url });

    beforeAll(async () => {
        plex = new FakePlex({ movies: 6, shows: 0, castSize: 5 });
        await plex.listen();
        const config = testConfig({ plexUrl: plex.url, plexToken: plex.token });
        dataDir = config.dataDir;
        app = await buildApp({ config, db: openDatabase(':memory:'), plex: new PlexClient({ url: plex.url, token: plex.token }) });
        await app.sync.run();
        library = (await get('/api/libraries/1/items')).json();
    });

    afterAll(async () => {
        await app.close();
        await plex.close();
    });

    it('snaps requested widths up to a stored size', () => {
        expect(snapWidth(1)).toBe(80);
        expect(snapWidth(100)).toBe(160);
        expect(snapWidth(320)).toBe(320);
        expect(snapWidth(5000)).toBe(640);
    });

    it('fetches a poster through Plex once, then serves it from disk', async () => {
        const item = library.items[0];
        plex.requests.length = 0;
        const first = await get(`/api/images/poster/${item.id}?w=150&v=${item.imageVersion}`);
        expect(first.statusCode).toBe(200);
        expect(first.headers['content-type']).toBe('image/png');
        expect(first.headers['cache-control']).toContain('immutable');
        const thumb = plex.library('1').items.find(source => source.title === item.title)!.thumb!;
        expect(first.rawPayload.equals(fakeImage(thumb))).toBe(true);
        expect(transcodes()).toHaveLength(1);
        const params = new URLSearchParams(transcodes()[0].split('?')[1]);
        expect(params.get('url')).toBe(thumb);
        expect(params.get('width')).toBe('160');

        const second = await get(`/api/images/poster/${item.id}?w=150`);
        expect(second.statusCode).toBe(200);
        expect(second.headers['cache-control']).toBe('public, max-age=86400');
        expect(transcodes()).toHaveLength(1);
        expect(readdirSync(join(dataDir, 'images', 'poster'))).toHaveLength(1);
    });

    it('serves person headshots from their absolute photo URLs', async () => {
        const personId = library.items[0].actors[0];
        expect(library.people[personId].hasThumb).toBe(true);
        expect(library.people[personId].imageVersion).toMatch(/^[0-9a-f]{10}$/);
        plex.requests.length = 0;
        const response = await get(`/api/images/person/${personId}?w=80`);
        expect(response.statusCode).toBe(200);
        expect(new URLSearchParams(transcodes()[0].split('?')[1]).get('url')).toMatch(/^https:\/\/metadata-static\.plex\.tv\/people\//);
    });

    it('fetches each image only once when requested concurrently', async () => {
        const item = library.items[1];
        plex.requests.length = 0;
        const responses = await Promise.all(Array.from({ length: 5 }, () => get(`/api/images/poster/${item.id}?w=320`)));
        expect(responses.every(response => response.statusCode === 200)).toBe(true);
        expect(transcodes()).toHaveLength(1);
    });

    it('returns 404 for unknown ids and when Plex cannot provide the image', async () => {
        expect((await get('/api/images/poster/999999')).statusCode).toBe(404);
        plex.failRequest = path => (path === '/photo/:/transcode' ? 500 : undefined);
        expect((await get(`/api/images/poster/${library.items[2].id}?w=640`)).statusCode).toBe(404);
        plex.failRequest = () => undefined;
    });

    it('rejects unknown kinds and out-of-range widths', async () => {
        expect((await get('/api/images/backdrop/1')).statusCode).toBe(400);
        expect((await get('/api/images/poster/1?w=5000')).statusCode).toBe(400);
    });
});
