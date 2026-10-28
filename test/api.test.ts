import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../src/server/db/index.js';
import { PlexClient } from '../src/server/plex/client.js';
import { buildApp } from '../src/server/app.js';
import type { LibraryItemsResponse } from '../src/server/db/queries.js';
import { FakePlex } from './fixtures/fake-plex.js';
import { testConfig } from './helpers.js';

describe('API', () => {
    let plex: FakePlex;
    let app: FastifyInstance;

    beforeAll(async () => {
        plex = new FakePlex({ movies: 20, shows: 4, castSize: 8 });
        await plex.listen();
        app = await buildApp({
            config: testConfig({ plexUrl: plex.url, plexToken: plex.token }),
            db: openDatabase(':memory:'),
            plex: new PlexClient({ url: plex.url, token: plex.token })
        });
        await app.sync.run();
    });

    afterAll(async () => {
        await app.close();
        await plex.close();
    });

    const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

    it('lists libraries with item counts and sync status', async () => {
        const body = (await get('/api/libraries')).json();
        expect(body.libraries.map((library: { title: string; itemCount: number }) => [library.title, library.itemCount]))
            .toEqual([['Movies', 20], ['TV Shows', 4]]);
        expect(body.sync.state).toBe('idle');
        expect(body.sync.lastCompletedAt).toEqual(expect.any(Number));
    });

    it('returns a library\'s items with people listed once and referenced by id', async () => {
        const movies = (await get('/api/libraries')).json().libraries[0];
        const response = await get(`/api/libraries/${movies.id}/items`);
        expect(response.statusCode).toBe(200);
        const body = response.json() as LibraryItemsResponse;
        expect(body.items).toHaveLength(20);

        const source = plex.library('1').items.find(item => item.title === body.items[0].title)!;
        const item = body.items[0];
        expect(item.actors.map(id => body.people[id].name)).toEqual([...new Set(source.Role.map(role => role.tag))]);
        expect(item.directors.map(id => body.people[id].name)).toEqual(source.Director.map(director => director.tag));
        expect(item.genres).toEqual(source.Genre.map(genre => genre.tag));
        expect(item.imdbId).toMatch(/^tt\d+$/);
        expect(item.rating).toBe(source.audienceRating);
        expect(item.criticRating).toBe(source.rating ?? null);
        expect(item.durationMs).toBe(source.duration);
        expect(item.watched).toBe(!!source.lastViewedAt);
        expect(item.hasThumb).toBe(true);
    });

    it('revalidates the items response with an ETag', async () => {
        const first = await get('/api/libraries/1/items');
        expect(first.headers['cache-control']).toBe('no-cache');
        const etag = first.headers.etag as string;
        expect(etag).toBeTruthy();
        const second = await get('/api/libraries/1/items', { 'if-none-match': etag });
        expect(second.statusCode).toBe(304);

        plex.touch(plex.library('1').items[0], { title: 'Renamed' });
        await app.sync.run();
        const third = await get('/api/libraries/1/items', { 'if-none-match': etag });
        expect(third.statusCode).toBe(200);
        expect(third.json().items.some((item: { title: string }) => item.title === 'Renamed')).toBe(true);
    });

    it('compresses large responses', async () => {
        const response = await get('/api/libraries/1/items', { 'accept-encoding': 'gzip' });
        expect(response.headers['content-encoding']).toBe('gzip');
    });

    it('returns item and person details', async () => {
        const items = (await get('/api/libraries/1/items')).json() as LibraryItemsResponse;
        const item = (await get(`/api/items/${items.items[0].id}`)).json();
        expect(item.externalIds.imdb).toMatch(/^tt/);
        expect(item.library).toMatchObject({ id: 1, type: 'movie' });
        const firstActor = item.credits.find((credit: { kind: string }) => credit.kind === 'actor');
        expect(firstActor.character).toBe('Character 1');
        expect(firstActor.imageVersion).toBe(items.people[firstActor.personId].imageVersion);

        const personId = items.items[0].actors[0];
        const person = (await get(`/api/people/${personId}`)).json();
        expect(person.name).toBe(items.people[personId].name);
        expect(person.imageVersion).toBe(items.people[personId].imageVersion);
        const credit = person.credits.find((c: { itemId: number }) => c.itemId === items.items[0].id);
        expect(credit).toMatchObject({ title: items.items[0].title, watched: items.items[0].watched, hasThumb: items.items[0].hasThumb, libraryTitle: expect.any(String) });
        const years = person.credits.map((c: { year: number | null }) => c.year).filter((year: number | null) => year !== null);
        expect(years).toEqual([...years].sort((a, b) => b - a));
    });

    it('returns 404 for unknown ids and 400 for malformed ones', async () => {
        expect((await get('/api/libraries/999/items')).statusCode).toBe(404);
        expect((await get('/api/items/999999')).statusCode).toBe(404);
        expect((await get('/api/people/999999')).statusCode).toBe(404);
        expect((await get('/api/items/abc')).statusCode).toBe(400);
    });

    it('starts a sync on request and reports its status', async () => {
        const response = await app.inject({ method: 'POST', url: '/api/sync' });
        expect(response.statusCode).toBe(202);
        expect(response.json().started).toBe(true);
        const again = await app.inject({ method: 'POST', url: '/api/sync' });
        expect(again.json().started).toBe(false);
        while (app.sync.isRunning()) await new Promise(resolve => setTimeout(resolve, 10));
        expect((await get('/api/sync/status')).json().state).toBe('idle');
    });

    it('never exposes the Plex token through the API', async () => {
        for (const url of ['/api/libraries', '/api/libraries/1/items', '/api/sync/status']) {
            expect((await get(url)).body).not.toContain(plex.token);
        }
    });
});
