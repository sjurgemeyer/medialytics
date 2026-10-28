import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
    plexUrl: string;
    plexToken: string;
    port: number;
    host: string;
    dataDir: string;
    publicDir: string;
    syncIntervalMinutes: number;
    logLevel: string;
}

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

const positiveNumber = (value: string | undefined, fallback: number, name: string): number => {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative number, got "${value}"`);
    }
    return parsed;
};

// SERVER_IP / SERVER_TOKEN are the variable names Medialytics used, accepted so an existing .env keeps working
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
    const plexUrl = (env.PLEX_URL || env.SERVER_IP || '').replace(/\/+$/, '');
    const plexToken = env.PLEX_TOKEN || env.SERVER_TOKEN || '';
    if (!plexUrl || !plexToken) {
        throw new Error('PLEX_URL and PLEX_TOKEN must be set');
    }
    return {
        plexUrl,
        plexToken,
        port: positiveNumber(env.PORT, 3000, 'PORT'),
        host: env.HOST || '0.0.0.0',
        dataDir: resolve(env.DATA_DIR || resolve(projectRoot, 'data')),
        publicDir: resolve(env.PUBLIC_DIR || resolve(projectRoot, 'public')),
        syncIntervalMinutes: positiveNumber(env.SYNC_INTERVAL_MINUTES, 15, 'SYNC_INTERVAL_MINUTES'),
        logLevel: env.LOG_LEVEL || 'info'
    };
};
