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
        expect(credit).toMatchObject({ title: items.items[0].title, watched: items.items[0].watched, hasThumb: items.items[0].hasThumb, libraryTitle: expect.any(String), libraryType: 'movie' });
        const years = person.credits.map((c: { year: number | null }) => c.year).filter((year: number | null) => year !== null);
        expect(years).toEqual([...years].sort((a, b) => b - a));
    });

    describe('shows', () => {
        interface Credit { personId: number; name: string; kind: string; showCredit: boolean; episodeCount: number | null; character: string | null }

        const showDetail = async () => {
            const shows = (await get('/api/libraries/2/items')).json() as LibraryItemsResponse;
            const source = plex.library('2').items[0];
            const listed = shows.items.find(item => item.ratingKey === source.ratingKey)!;
            return { source, episodes: plex.episodes.get(source.ratingKey)!, listed, detail: (await get(`/api/items/${listed.id}`)).json() };
        };

        it('lists watched episodes and every episode with its air date', async () => {
            const { source, episodes, listed, detail } = await showDetail();
            expect(listed).toMatchObject({ leafCount: episodes.length, viewedLeafCount: source.viewedLeafCount });
            expect(detail.episodes).toHaveLength(episodes.length);
            expect(detail.episodes[0]).toMatchObject({ season: 1, episode: 1, title: 'Episode 1', airDate: episodes[0].originallyAvailableAt, watched: !!episodes[0].viewCount });
        });

        it('counts the episodes behind each credit, including people credited only on episodes', async () => {
            const { source, episodes, detail } = await showDetail();
            const credits = detail.credits as Credit[];
            const countIn = (kind: 'Director' | 'Writer' | 'Role', name: string) => episodes.filter(episode => episode[kind].some(tag => tag.tag === name)).length;

            // Series regulars are show credits, with the episodes they appear in
            const lead = credits.find(credit => credit.kind === 'actor' && credit.name === source.Role[0].tag)!;
            expect(lead).toMatchObject({ showCredit: true, character: 'Character 1', episodeCount: countIn('Role', lead.name) });

            // Directors are credited only on episodes
            const directors = credits.filter(credit => credit.kind === 'director');
            expect(directors.length).toBeGreaterThan(0);
            for (const director of directors) {
                expect(director).toMatchObject({ showCredit: false, episodeCount: countIn('Director', director.name) });
            }
            expect(directors.map(director => director.episodeCount)).toEqual([...directors.map(director => director.episodeCount)].sort((a, b) => b! - a!));

            // The director's page lists the show with their episode count
            const person = (await get(`/api/people/${directors[0].personId}`)).json();
            const onShow = person.credits.find((credit: { itemId: number; kind: string }) => credit.itemId === detail.id && credit.kind === 'director');
            expect(onShow).toMatchObject({ showCredit: false, episodeCount: directors[0].episodeCount, libraryType: 'show', leafCount: episodes.length });
        });

        it('gives movies no episode data', async () => {
            const movies = (await get('/api/libraries/1/items')).json() as LibraryItemsResponse;
            const detail = (await get(`/api/items/${movies.items[0].id}`)).json();
            expect(detail.episodes).toBeNull();
            expect(detail.credits.every((credit: Credit) => credit.episodeCount === null && credit.showCredit)).toBe(true);
        });
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
