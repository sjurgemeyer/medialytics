import type { Db } from './index.js';

export interface LibrarySummary {
    id: number;
    title: string;
    type: string;
    itemCount: number;
    lastSyncedAt: number | null;
}

export interface ApiItem {
    id: number;
    ratingKey: string;
    title: string;
    titleSort: string | null;
    year: number | null;
    rating: number | null;           // audience rating, 0-10
    criticRating: number | null;     // 0-10
    contentRating: string | null;
    durationMs: number | null;       // per episode for shows
    studio: string | null;
    childCount: number | null;       // seasons
    leafCount: number | null;        // episodes
    addedAt: number | null;          // epoch seconds
    lastViewedAt: number | null;     // epoch seconds
    viewCount: number | null;
    watched: boolean;
    imdbId: string | null;
    hasThumb: boolean;
    imageVersion: number | null;     // changes when Plex artwork changes
    genres: string[];
    countries: string[];
    actors: number[];                // person ids, in billing order
    directors: number[];
    writers: number[];
}

export interface ApiPerson {
    name: string;
    hasThumb: boolean;
}

export interface LibraryItemsResponse {
    library: LibrarySummary;
    people: Record<string, ApiPerson>;
    items: ApiItem[];
}

const librarySummarySql = `
    SELECT l.id, l.title, l.type, l.last_synced_at AS lastSyncedAt, COUNT(i.id) AS itemCount
    FROM libraries l LEFT JOIN items i ON i.library_id = l.id`;

export const listLibraries = (db: Db): LibrarySummary[] =>
    db.prepare(`${librarySummarySql} GROUP BY l.id ORDER BY l.title`).all() as LibrarySummary[];

export const getLibrary = (db: Db, libraryId: number): LibrarySummary | undefined => {
    const row = db.prepare(`${librarySummarySql} WHERE l.id = ? GROUP BY l.id`).get(libraryId) as LibrarySummary | undefined;
    return row;
};

// onlyItemId restricts the result to one item of the library
export const libraryItems = (db: Db, libraryId: number, onlyItemId: number | null = null): LibraryItemsResponse | undefined => {
    const library = getLibrary(db, libraryId);
    if (!library) return undefined;
    const params = { libraryId, onlyItemId };

    const rows = db.prepare(`
        SELECT id, rating_key AS ratingKey, title, title_sort AS titleSort, year, audience_rating AS rating,
            critic_rating AS criticRating, content_rating AS contentRating, duration_ms AS durationMs, studio,
            child_count AS childCount, leaf_count AS leafCount, added_at AS addedAt, last_viewed_at AS lastViewedAt,
            view_count AS viewCount, thumb IS NOT NULL AS hasThumb, updated_at AS imageVersion
        FROM items WHERE library_id = @libraryId AND (@onlyItemId IS NULL OR id = @onlyItemId)`).all(params) as (Omit<ApiItem, 'watched' | 'hasThumb' | 'imdbId' | 'genres' | 'countries' | 'actors' | 'directors' | 'writers'> & { hasThumb: number })[];

    const items = new Map<number, ApiItem>();
    for (const row of rows) {
        items.set(row.id, {
            ...row,
            hasThumb: row.hasThumb === 1,
            watched: row.lastViewedAt !== null || (row.viewCount ?? 0) > 0,
            imdbId: null,
            genres: [],
            countries: [],
            actors: [],
            directors: [],
            writers: []
        });
    }

    const imdbIds = db.prepare(`
        SELECT g.item_id AS itemId, g.external_id AS externalId
        FROM item_guids g JOIN items i ON i.id = g.item_id
        WHERE i.library_id = @libraryId AND (@onlyItemId IS NULL OR i.id = @onlyItemId) AND g.provider = 'imdb'`).all(params) as { itemId: number; externalId: string }[];
    for (const { itemId, externalId } of imdbIds) {
        const item = items.get(itemId);
        if (item) item.imdbId = externalId;
    }

    const tags = db.prepare(`
        SELECT it.item_id AS itemId, t.kind, t.name
        FROM item_tags it JOIN tags t ON t.id = it.tag_id JOIN items i ON i.id = it.item_id
        WHERE i.library_id = @libraryId AND (@onlyItemId IS NULL OR i.id = @onlyItemId)
        ORDER BY it.item_id, t.kind, it.position`).all(params) as { itemId: number; kind: string; name: string }[];
    for (const { itemId, kind, name } of tags) {
        const item = items.get(itemId);
        if (!item) continue;
        if (kind === 'genre') item.genres.push(name);
        else if (kind === 'country') item.countries.push(name);
    }

    const people: Record<string, ApiPerson> = {};
    const credits = db.prepare(`
        SELECT c.item_id AS itemId, c.kind, p.id AS personId, p.name, p.thumb IS NOT NULL AS hasThumb
        FROM credits c JOIN people p ON p.id = c.person_id JOIN items i ON i.id = c.item_id
        WHERE i.library_id = @libraryId AND (@onlyItemId IS NULL OR i.id = @onlyItemId)
        ORDER BY c.item_id, c.kind, c.billing_order`).all(params) as {
        itemId: number; kind: string; personId: number; name: string; hasThumb: number;
    }[];
    for (const { itemId, kind, personId, name, hasThumb } of credits) {
        const item = items.get(itemId);
        if (!item) continue;
        people[personId] ??= { name, hasThumb: hasThumb === 1 };
        if (kind === 'actor') item.actors.push(personId);
        else if (kind === 'director') item.directors.push(personId);
        else if (kind === 'writer') item.writers.push(personId);
    }

    return { library, people, items: [...items.values()] };
};

export interface ItemDetail extends ApiItem {
    summary: string | null;
    externalIds: Record<string, string>;
    credits: { personId: number; name: string; kind: string; billingOrder: number; character: string | null }[];
}

export const itemDetail = (db: Db, itemId: number): ItemDetail | undefined => {
    const row = db.prepare('SELECT library_id AS libraryId, summary FROM items WHERE id = ?').get(itemId) as { libraryId: number; summary: string | null } | undefined;
    if (!row) return undefined;
    const base = libraryItems(db, row.libraryId, itemId)?.items[0];
    if (!base) return undefined;
    const externalIds = Object.fromEntries((db.prepare('SELECT provider, external_id AS id FROM item_guids WHERE item_id = ?').all(itemId) as { provider: string; id: string }[])
        .map(({ provider, id }) => [provider, id]));
    const credits = db.prepare(`
        SELECT c.person_id AS personId, p.name, c.kind, c.billing_order AS billingOrder, c.character
        FROM credits c JOIN people p ON p.id = c.person_id
        WHERE c.item_id = ? ORDER BY c.kind, c.billing_order`).all(itemId) as ItemDetail['credits'];
    return { ...base, summary: row.summary, externalIds, credits };
};

export interface PersonDetail {
    id: number;
    name: string;
    hasThumb: boolean;
    credits: { itemId: number; libraryId: number; title: string; year: number | null; kind: string; billingOrder: number; character: string | null }[];
}

export const personDetail = (db: Db, personId: number): PersonDetail | undefined => {
    const person = db.prepare('SELECT id, name, thumb IS NOT NULL AS hasThumb FROM people WHERE id = ?').get(personId) as { id: number; name: string; hasThumb: number } | undefined;
    if (!person) return undefined;
    const credits = db.prepare(`
        SELECT i.id AS itemId, i.library_id AS libraryId, i.title, i.year, c.kind, c.billing_order AS billingOrder, c.character
        FROM credits c JOIN items i ON i.id = c.item_id
        WHERE c.person_id = ? ORDER BY i.year, i.title`).all(personId) as PersonDetail['credits'];
    return { id: person.id, name: person.name, hasThumb: person.hasThumb === 1, credits };
};
