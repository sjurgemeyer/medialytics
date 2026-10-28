import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import type { PlexClient } from '../plex/client.js';

export type ImageKind = 'poster' | 'person';

export interface CachedImage {
    path: string;
    contentType: string;
}

export interface ImageLogger {
    warn(object: object, message?: string): void;
}

// Requested widths snap up to one of these, which bounds how many sizes of each image are stored
export const imageWidths = [80, 160, 320, 640] as const;

const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
};
const contentTypes = Object.fromEntries(Object.entries(extensions).map(([type, extension]) => [extension, type]));

export const snapWidth = (requested: number): number =>
    imageWidths.find(width => width >= requested) ?? imageWidths[imageWidths.length - 1];

// Allows a few image fetches from Plex at once so a page full of new images doesn't flood it
class Limiter {
    private active = 0;
    private readonly queue: (() => void)[] = [];

    constructor(private readonly max: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) {
            await new Promise<void>(resolve => this.queue.push(resolve));
        }
        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            this.queue.shift()?.();
        }
    }
}

// Artwork resized by Plex and cached on disk under <dataDir>/images/<kind>/, keyed by source and width.
// Plex artwork paths change when the artwork does, so a cached file never goes stale.
export class ImageCache {
    private readonly root: string;
    private readonly inFlight = new Map<string, Promise<CachedImage | null>>();
    private readonly limiter = new Limiter(4);
    private readonly sources;

    constructor(dataDir: string, private readonly db: Db, private readonly plex: PlexClient, private readonly log: ImageLogger) {
        this.root = join(dataDir, 'images');
        this.sources = {
            poster: db.prepare('SELECT thumb FROM items WHERE id = ?'),
            person: db.prepare('SELECT thumb FROM people WHERE id = ?')
        };
    }

    // Resolves to null when the item or person doesn't exist or has no artwork
    async get(kind: ImageKind, id: number, requestedWidth: number): Promise<CachedImage | null> {
        const row = this.sources[kind].get(id) as { thumb: string | null } | undefined;
        if (!row?.thumb) return null;
        const width = snapWidth(requestedWidth);
        const key = createHash('sha1').update(`${row.thumb}|${width}`).digest('hex');
        const directory = join(this.root, kind);

        const cached = await this.findCached(directory, key);
        if (cached) return cached;

        const pending = this.inFlight.get(key);
        if (pending) return pending;
        const download = this.download(row.thumb, width, directory, key).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, download);
        return download;
    }

    private async findCached(directory: string, key: string): Promise<CachedImage | null> {
        for (const extension of Object.values(extensions)) {
            const path = join(directory, `${key}.${extension}`);
            try {
                await stat(path);
                return { path, contentType: contentTypes[extension] };
            } catch {
                // not cached in this format
            }
        }
        return null;
    }

    private async download(source: string, width: number, directory: string, key: string): Promise<CachedImage | null> {
        // Posters and headshots are both portrait; Plex keeps the aspect ratio within this box
        const height = Math.round(width * 1.5);
        let image: { body: Buffer; contentType: string };
        try {
            image = await this.limiter.run(() => this.plex.transcodeImage(source, width, height));
        } catch (error) {
            this.log.warn({ err: error, width }, 'image fetch failed');
            return null;
        }
        const contentType = image.contentType.split(';')[0].trim().toLowerCase();
        const extension = extensions[contentType];
        if (!extension) {
            this.log.warn({ contentType }, 'Plex returned an unexpected image type');
            return null;
        }
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${key}.${extension}`);
        // Write then rename, so a concurrent reader never sees a partial file
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, image.body);
        await rename(temporary, path);
        return { path, contentType };
    }
}
