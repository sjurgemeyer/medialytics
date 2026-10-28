import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/server/config.js';

export const tempDir = (): string => mkdtempSync(join(tmpdir(), 'mediadata-test-'));

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
    ...loadConfig({ PLEX_URL: 'http://plex.test:32400', PLEX_TOKEN: 'test-token', DATA_DIR: tempDir() }),
    logLevel: 'silent',
    ...overrides
});
