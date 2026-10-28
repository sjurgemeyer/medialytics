// A small stand-in for Plex Media Server's JSON API, covering the endpoints MediaData uses.
// Used by the tests, and runnable on its own for manual testing:
//   npx tsx test/fixtures/fake-plex.ts [movies] [castSize] [port]
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

export interface FakeTag {
    tag: string;
    tagKey?: string;
    role?: string;
    thumb?: string;
}

export interface FakeItem {
    ratingKey: string;
    guid: string;
    title: string;
    titleSort?: string;
    year?: number;
    audienceRating?: number;
    rating?: number;
    contentRating?: string;
    duration?: number;
    studio?: string;
    summary?: string;
    childCount?: number;
    leafCount?: number;
    addedAt: number;
    updatedAt: number;
    lastViewedAt?: number;
    viewCount?: number;
    thumb?: string;
    art?: string;
    Guid?: { id: string }[];
    Genre: FakeTag[];
    Country: FakeTag[];
    Director: FakeTag[];
    Writer: FakeTag[];
    Role: FakeTag[];
}

export interface FakeLibrary {
    key: string;
    title: string;
    type: 'movie' | 'show';
    items: FakeItem[];
}

export interface FakePlexOptions {
    movies?: number;
    shows?: number;
    castSize?: number;
    token?: string;
    seed?: number;
}

// Deterministic pseudo-random numbers so test data is stable between runs
const createRandom = (seed: number) => {
    let state = seed >>> 0;
    const next = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
    return {
        next,
        int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
        pick: <T>(list: T[]): T => list[Math.floor(next() * list.length)],
        sample: <T>(list: T[], count: number): T[] => {
            const copy = list.slice();
            const out: T[] = [];
            while (out.length < count && copy.length) {
                out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
            }
            return out;
        }
    };
};

const firstNames = ['Alex', 'Jamie', 'Chris', 'Taylor', 'Jordan', 'Morgan', 'Casey', 'Riley', 'Sam', 'Drew', 'Avery', 'Quinn', 'Harper', 'Rowan', 'Emery', 'Parker', 'Reese', 'Skyler', 'Logan', 'Blake'];
const lastNames = ['Smith', 'Lee', 'Park', 'Brown', 'Kim', 'Diaz', 'Wu', 'Chen', 'Ortiz', 'Patel', 'Nguyen', 'Garcia', 'Khan', 'Rossi', 'Novak', 'Silva', 'Haas', 'Okafor', 'Larsen', 'Moreau'];
const genres = ['Action', 'Comedy', 'Drama', 'Horror', 'Sci-Fi', 'Thriller', 'Romance', 'Animation', 'Documentary', 'Fantasy', 'Crime', 'Mystery'];
const countries = ['United States of America', 'United Kingdom', 'France', 'Japan', 'Canada', 'Germany', 'South Korea', 'Italy'];
const studios = ['Warner Bros.', 'Universal', 'Paramount', 'A24', 'Pixar', 'Lionsgate', 'Focus Features', 'Sony'];
const contentRatings = ['G', 'PG', 'PG-13', 'R', 'NR'];

// A 1x1 PNG returned for every image request
export const fakeImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export class FakePlex {
    readonly token: string;
    readonly libraries: FakeLibrary[];
    readonly requests: string[] = [];
    // Called before each response; return a status code to fail the request instead
    failRequest: (path: string) => number | undefined = () => undefined;
    private server?: Server;
    private nextKey = 1000;
    private readonly random;
    private readonly people: FakeTag[];
    private readonly castSize: number;

    constructor({ movies = 60, shows = 10, castSize = 12, token = 'test-token', seed = 7 }: FakePlexOptions = {}) {
        this.token = token;
        this.castSize = castSize;
        this.random = createRandom(seed);
        const names = firstNames.flatMap(first => lastNames.map(last => `${first} ${last}`));
        this.people = names.map((name, index) => ({
            tag: name,
            tagKey: `person-${index}`,
            thumb: `https://metadata-static.plex.tv/people/person-${index}.jpg`
        }));
        this.libraries = [
            { key: '1', title: 'Movies', type: 'movie', items: Array.from({ length: movies }, () => this.createItem('movie')) },
            { key: '2', title: 'TV Shows', type: 'show', items: Array.from({ length: shows }, () => this.createItem('show')) }
        ];
    }

    createItem(type: 'movie' | 'show'): FakeItem {
        const r = this.random;
        const key = String(this.nextKey++);
        const year = r.int(1955, 2025);
        const addedAt = 1_600_000_000 + r.int(0, 150_000_000);
        const cast = r.sample(this.people.slice(0, 150), 3).concat(r.sample(this.people, this.castSize - 3));
        const item: FakeItem = {
            ratingKey: key,
            guid: `plex://${type}/${key}`,
            title: `${type === 'movie' ? 'Movie' : 'Show'} ${key}`,
            year,
            audienceRating: Math.round(r.int(30, 98)) / 10,
            contentRating: r.pick(contentRatings),
            duration: (type === 'movie' ? r.int(80, 180) : r.pick([22, 44, 58])) * 60_000,
            studio: r.pick(studios),
            summary: `Summary of ${key}`,
            addedAt,
            updatedAt: addedAt,
            thumb: `/library/metadata/${key}/thumb/${addedAt}`,
            art: `/library/metadata/${key}/art/${addedAt}`,
            Guid: [{ id: `imdb://tt${String(1_000_000 + Number(key)).padStart(7, '0')}` }, { id: `tmdb://${Number(key) + 500}` }],
            Genre: r.sample(genres, 2).map(tag => ({ tag })),
            Country: [{ tag: r.pick(countries) }],
            Director: [{ ...r.pick(this.people.slice(0, 60)) }],
            Writer: r.sample(this.people.slice(0, 60), 2).map(person => ({ ...person })),
            Role: cast.map((person, index) => ({ ...person, role: `Character ${index + 1}` }))
        };
        if (r.next() < 0.8) item.rating = Math.round(r.int(20, 100)) / 10;
        if (r.next() < 0.45) {
            item.lastViewedAt = addedAt + 1000;
            item.viewCount = 1;
        }
        if (type === 'show') {
            item.childCount = r.int(1, 8);
            item.leafCount = item.childCount * 10;
        }
        return item;
    }

    library(key: string): FakeLibrary {
        const library = this.libraries.find(candidate => candidate.key === key);
        if (!library) throw new Error(`No library ${key}`);
        return library;
    }

    // Simulates a metadata edit in Plex
    touch(item: FakeItem, changes: Partial<FakeItem> = {}): void {
        Object.assign(item, changes);
        item.updatedAt += 100;
    }

    get url(): string {
        if (!this.server) throw new Error('FakePlex is not listening');
        const { port } = this.server.address() as AddressInfo;
        return `http://127.0.0.1:${port}`;
    }

    async listen(port = 0): Promise<string> {
        this.server = createServer((request, response) => this.handle(request, response));
        await new Promise<void>(resolve => this.server!.listen(port, '0.0.0.0', resolve));
        return this.url;
    }

    async close(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>(resolve => this.server!.close(() => resolve()));
        this.server = undefined;
    }

    // The library listing truncates tag lists the way Plex does, and only includes external ids when asked
    private listingItem(item: FakeItem, includeGuids: boolean) {
        const { Guid, ...rest } = item;
        return {
            ...rest,
            ...(includeGuids && Guid ? { Guid } : {}),
            Genre: item.Genre.slice(0, 2),
            Country: item.Country.slice(0, 2),
            Director: item.Director.slice(0, 2).map(({ tag }) => ({ tag })),
            Writer: item.Writer.slice(0, 2).map(({ tag }) => ({ tag })),
            Role: item.Role.slice(0, 3).map(({ tag }) => ({ tag }))
        };
    }

    private send(response: ServerResponse, status: number, body: unknown, contentType = 'application/json') {
        response.writeHead(status, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
        response.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    }

    private handle(request: IncomingMessage, response: ServerResponse) {
        const url = new URL(request.url ?? '/', 'http://fake-plex');
        this.requests.push(url.pathname + url.search);
        const token = request.headers['x-plex-token'] ?? url.searchParams.get('X-Plex-Token');
        if (token !== this.token) {
            return this.send(response, 401, { error: 'unauthorized' });
        }
        const failure = this.failRequest(url.pathname);
        if (failure) {
            return this.send(response, failure, { error: 'injected failure' });
        }
        const includeGuids = url.searchParams.get('includeGuids') === '1';
        const path = url.pathname;

        if (path === '/library/sections') {
            return this.send(response, 200, {
                MediaContainer: { Directory: this.libraries.map(({ key, title, type }) => ({ key, title, type })) }
            });
        }
        let match = path.match(/^\/library\/sections\/([^/]+)\/all$/);
        if (match) {
            const library = this.libraries.find(candidate => candidate.key === match![1]);
            if (!library) return this.send(response, 404, {});
            return this.send(response, 200, {
                MediaContainer: { size: library.items.length, viewGroup: library.type, Metadata: library.items.map(item => this.listingItem(item, includeGuids)) }
            });
        }
        match = path.match(/^\/library\/sections\/([^/]+)\/collections$/);
        if (match) {
            return this.send(response, 200, { MediaContainer: { size: 0 } });
        }
        match = path.match(/^\/library\/metadata\/([^/]+)$/);
        if (match) {
            const keys = match[1].split(',');
            const all = this.libraries.flatMap(library => library.items);
            const items = keys.map(key => all.find(item => item.ratingKey === key)).filter((item): item is FakeItem => !!item);
            return this.send(response, 200, {
                MediaContainer: {
                    size: items.length,
                    Metadata: items.map(({ Guid, ...rest }) => ({ ...rest, ...(includeGuids && Guid ? { Guid } : {}) }))
                }
            });
        }
        if (path === '/photo/:/transcode') {
            return this.send(response, url.searchParams.get('url') ? 200 : 400, fakeImage, 'image/png');
        }
        return this.send(response, 404, { error: 'not found' });
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const [movies = '180', castSize = '12', port = '32499'] = process.argv.slice(2);
    const plex = new FakePlex({ movies: Number(movies), castSize: Number(castSize) });
    plex.listen(Number(port)).then(url => console.log(`Fake Plex listening on ${url} (token: ${plex.token})`));
}
