import type { PlexContainer, PlexDirectory, PlexItem } from './types.js';

export class PlexError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'PlexError';
    }
}

export interface PlexClientOptions {
    url: string;
    token: string;
    timeoutMs?: number;
}

// All access to Plex goes through here. The token is sent as a header, never in a URL that could be logged.
export class PlexClient {
    private readonly url: string;
    private readonly token: string;
    private readonly timeoutMs: number;

    constructor({ url, token, timeoutMs = 120_000 }: PlexClientOptions) {
        this.url = url.replace(/\/+$/, '');
        this.token = token;
        this.timeoutMs = timeoutMs;
    }

    private async request(path: string, accept: string): Promise<Response> {
        let response: Response;
        try {
            response = await fetch(this.url + path, {
                headers: { Accept: accept, 'X-Plex-Token': this.token },
                signal: AbortSignal.timeout(this.timeoutMs)
            });
        } catch (error) {
            throw new PlexError(`Could not reach Plex at ${this.url}: ${(error as Error).message}`);
        }
        if (!response.ok) {
            throw new PlexError(`Plex returned ${response.status} for ${path.split('?')[0]}`, response.status);
        }
        return response;
    }

    private async json<T>(path: string): Promise<T> {
        const response = await this.request(path, 'application/json');
        return (await response.json()) as T;
    }

    async libraries(): Promise<PlexDirectory[]> {
        const body = await this.json<PlexContainer<never>>('/library/sections');
        return body.MediaContainer?.Directory ?? [];
    }

    // Every item in a library. Plex truncates tag lists here (3 actors, 2 directors/genres...).
    async libraryItems(libraryKey: string): Promise<PlexItem[]> {
        const body = await this.json<PlexContainer<PlexItem>>(`/library/sections/${encodeURIComponent(libraryKey)}/all?includeGuids=1`);
        return body.MediaContainer?.Metadata ?? [];
    }

    // Every episode of a show. Tag lists are truncated here as in library listings.
    async episodes(showRatingKey: string): Promise<PlexItem[]> {
        const body = await this.json<PlexContainer<PlexItem>>(`/library/metadata/${encodeURIComponent(showRatingKey)}/allLeaves`);
        return body.MediaContainer?.Metadata ?? [];
    }

    // Full metadata (complete cast and crew) for several items in one request
    async metadata(ratingKeys: string[]): Promise<PlexItem[]> {
        if (ratingKeys.length === 0) return [];
        const keys = ratingKeys.map(encodeURIComponent).join(',');
        const body = await this.json<PlexContainer<PlexItem>>(`/library/metadata/${keys}?includeGuids=1`);
        return body.MediaContainer?.Metadata ?? [];
    }

    // Artwork resized by Plex's photo transcoder; source is a Plex path or an absolute image URL
    async transcodeImage(source: string, width: number, height: number): Promise<{ body: Buffer; contentType: string }> {
        const query = new URLSearchParams({
            url: source,
            width: String(width),
            height: String(height),
            minSize: '1',
            upscale: '0'
        });
        const response = await this.request(`/photo/:/transcode?${query}`, 'image/*');
        return {
            body: Buffer.from(await response.arrayBuffer()),
            contentType: response.headers.get('content-type') ?? 'image/jpeg'
        };
    }
}
