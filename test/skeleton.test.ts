import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { migrate, openDatabase, schemaVersion } from '../src/server/db/index.js';
import { migrations } from '../src/server/db/migrations.js';
import { buildApp } from '../src/server/app.js';
import { testConfig } from './helpers.js';

describe('config', () => {
    it('reads PLEX_URL and PLEX_TOKEN, trimming trailing slashes', () => {
        const config = loadConfig({ PLEX_URL: 'http://plex:32400/', PLEX_TOKEN: 'abc' });
        expect(config.plexUrl).toBe('http://plex:32400');
        expect(config.plexToken).toBe('abc');
        expect(config.port).toBe(3000);
        expect(config.syncIntervalMinutes).toBe(15);
    });

    it('accepts the Medialytics variable names', () => {
        const config = loadConfig({ SERVER_IP: 'http://plex:32400', SERVER_TOKEN: 'abc' });
        expect(config.plexUrl).toBe('http://plex:32400');
        expect(config.plexToken).toBe('abc');
    });

    it('requires the Plex URL and token', () => {
        expect(() => loadConfig({})).toThrow(/PLEX_URL and PLEX_TOKEN/);
    });

    it('rejects a malformed sync interval', () => {
        expect(() => loadConfig({ PLEX_URL: 'x', PLEX_TOKEN: 'y', SYNC_INTERVAL_MINUTES: 'often' })).toThrow(/SYNC_INTERVAL_MINUTES/);
    });
});

describe('database', () => {
    it('applies every migration once', () => {
        const db = openDatabase(':memory:');
        const latest = Math.max(...migrations.map(migration => migration.version));
        expect(schemaVersion(db)).toBe(latest);
        expect(migrate(db)).toBe(latest);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => (row as { name: string }).name);
        expect(tables).toEqual(expect.arrayContaining(['libraries', 'items', 'people', 'credits', 'tags', 'item_tags', 'item_guids', 'sync_runs']));
    });
});

describe('http app', () => {
    it('reports health and schema version', async () => {
        const app = await buildApp({ config: testConfig(), db: openDatabase(':memory:') });
        const response = await app.inject({ method: 'GET', url: '/api/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: 'ok' });
        await app.close();
    });

    it('serves the frontend', async () => {
        const app = await buildApp({ config: testConfig(), db: openDatabase(':memory:') });
        const response = await app.inject({ method: 'GET', url: '/' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toMatch(/text\/html/);
        await app.close();
    });

    it('fills in the Plex URL and token for the scripts that call Plex', async () => {
        const app = await buildApp({ config: testConfig(), db: openDatabase(':memory:') });
        const response = await app.inject({ method: 'GET', url: '/js/scripts.js' });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain("const serverIp = 'http://plex.test:32400'");
        expect(response.body).not.toContain("'SERVER_TOKEN'");
        await app.close();
    });
});
