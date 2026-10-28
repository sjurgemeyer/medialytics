import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/server/db/index.js';
import { PlexClient } from '../src/server/plex/client.js';
import { SyncService } from '../src/server/sync/service.js';
import { FakePlex } from './fixtures/fake-plex.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const metadataRequests = (plex: FakePlex) => plex.requests.filter(path => path.startsWith('/library/metadata/'));

describe('SyncService', () => {
    let plex: FakePlex;
    let db: Db;
    let sync: SyncService;

    beforeEach(async () => {
        plex = new FakePlex({ movies: 30, shows: 5, castSize: 12 });
        await plex.listen();
        db = openDatabase(':memory:');
        sync = new SyncService(db, new PlexClient({ url: plex.url, token: plex.token }), silentLog, { batchSize: 10, concurrency: 2 });
    });

    afterEach(async () => {
        await plex.close();
        db.close();
    });

    const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
    const itemId = (ratingKey: string) => (db.prepare('SELECT id FROM items WHERE rating_key = ?').get(ratingKey) as { id: number }).id;

    it('imports every movie and show library with full credits', async () => {
        const status = await sync.run();
        expect(status.state).toBe('idle');
        expect(status.itemsSeen).toBe(35);
        expect(status.creditsFetched).toBe(35);
        expect(count('SELECT COUNT(*) AS n FROM libraries')).toBe(2);
        expect(count('SELECT COUNT(*) AS n FROM items')).toBe(35);

        const movie = plex.library('1').items[0];
        const id = itemId(movie.ratingKey);
        const actors = db.prepare(`
            SELECT p.name, c.character FROM credits c JOIN people p ON p.id = c.person_id
            WHERE c.item_id = ? AND c.kind = 'actor' ORDER BY c.billing_order`).all(id) as { name: string; character: string }[];
        // Full cast, in billing order, rather than the 3 names the listing carries
        expect(actors.map(actor => actor.name)).toEqual([...new Set(movie.Role.map(role => role.tag))]);
        expect(actors[0].character).toBe('Character 1');
        expect(count("SELECT COUNT(*) AS n FROM item_guids WHERE item_id = ? AND provider = 'imdb'", id)).toBe(1);
        expect(count("SELECT COUNT(*) AS n FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ? AND t.kind = 'genre'", id)).toBe(2);
    });

    it('identifies people by Plex tagKey and drops placeholders from the listing', async () => {
        await sync.run();
        expect(count("SELECT COUNT(*) AS n FROM people WHERE identity LIKE 'name:%'")).toBe(0);
        const names = db.prepare('SELECT name, COUNT(*) AS n FROM people GROUP BY name HAVING n > 1').all();
        expect(names).toEqual([]);
    });

    it('skips credit fetches when nothing changed', async () => {
        await sync.run();
        plex.requests.length = 0;
        const status = await sync.run();
        expect(status.creditsFetched).toBe(0);
        expect(metadataRequests(plex)).toEqual([]);
    });

    it('refetches credits only for items Plex reports as updated', async () => {
        await sync.run();
        const movie = plex.library('1').items[3];
        plex.touch(movie, { Role: [{ tag: 'New Lead', tagKey: 'new-lead', role: 'Hero' }, ...movie.Role] });
        plex.requests.length = 0;

        const status = await sync.run();
        expect(status.creditsFetched).toBe(1);
        expect(metadataRequests(plex)).toEqual([`/library/metadata/${movie.ratingKey}?includeGuids=1`]);
        const top = db.prepare(`SELECT p.name FROM credits c JOIN people p ON p.id = c.person_id
            WHERE c.item_id = ? AND c.kind = 'actor' AND c.billing_order = 0`).get(itemId(movie.ratingKey)) as { name: string };
        expect(top.name).toBe('New Lead');
    });

    it('picks up watched state without refetching credits', async () => {
        await sync.run();
        const movie = plex.library('1').items.find(item => !item.lastViewedAt)!;
        movie.lastViewedAt = 1_800_000_000;
        movie.viewCount = 1;
        const status = await sync.run();
        expect(status.creditsFetched).toBe(0);
        const row = db.prepare('SELECT last_viewed_at AS lastViewedAt FROM items WHERE rating_key = ?').get(movie.ratingKey) as { lastViewedAt: number };
        expect(row.lastViewedAt).toBe(1_800_000_000);
    });

    it('removes items and libraries that are gone from Plex', async () => {
        await sync.run();
        const removed = plex.library('1').items.pop()!;
        const status = await sync.run();
        expect(status.itemsRemoved).toBe(1);
        expect(count('SELECT COUNT(*) AS n FROM items WHERE rating_key = ?', removed.ratingKey)).toBe(0);

        plex.libraries.splice(1, 1);
        await sync.run();
        expect(count('SELECT COUNT(*) AS n FROM libraries')).toBe(1);
        expect(count('SELECT COUNT(*) AS n FROM items')).toBe(29);
    });

    it('keeps going when a credit batch fails and retries it next time', async () => {
        let failures = 1;
        plex.failRequest = path => (path.startsWith('/library/metadata/') && failures-- > 0 ? 500 : undefined);
        const first = await sync.run();
        expect(first.state).toBe('idle');
        expect(first.failedBatches).toBe(1);
        expect(first.error).toMatch(/retried/);
        expect(count('SELECT COUNT(*) AS n FROM items WHERE credits_updated_at IS NULL')).toBe(10);
        // Items in the failed batch still show the listing's partial credits
        expect(count("SELECT COUNT(*) AS n FROM credits WHERE kind = 'actor'")).toBeGreaterThan(0);

        const second = await sync.run();
        expect(second.failedBatches).toBe(0);
        expect(second.creditsFetched).toBe(10);
        expect(count('SELECT COUNT(*) AS n FROM items WHERE credits_updated_at IS NULL')).toBe(0);
    });

    it('reports a failed run when Plex is unreachable or rejects the token', async () => {
        plex.failRequest = path => (path === '/library/sections' ? 401 : undefined);
        const status = await sync.run();
        expect(status.state).toBe('failed');
        expect(status.error).toMatch(/401/);
        const run = db.prepare('SELECT status FROM sync_runs ORDER BY id DESC').get() as { status: string };
        expect(run.status).toBe('failed');
    });

    it('re-fetches every item on a full sync', async () => {
        await sync.run();
        const status = await sync.run({ full: true });
        expect(status.creditsFetched).toBe(35);
    });

    it('shares one run between concurrent callers', async () => {
        const [a, b] = await Promise.all([sync.run(), sync.run()]);
        expect(a.runId).toBe(b.runId);
        expect(count('SELECT COUNT(*) AS n FROM sync_runs')).toBe(1);
    });
});
