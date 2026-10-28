import { createHash } from 'node:crypto';
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
    viewedLeafCount: number | null;  // watched episodes
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
    imageVersion: string | null;     // changes when the person's photo changes
}

const imageVersion = (thumb: string | null): string | null =>
    thumb ? createHash('sha1').update(thumb).digest('hex').slice(0, 10) : null;

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
            child_count AS childCount, leaf_count AS leafCount, viewed_leaf_count AS viewedLeafCount, added_at AS addedAt, last_viewed_at AS lastViewedAt,
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
        SELECT c.item_id AS itemId, c.kind, p.id AS personId, p.name, p.thumb
        FROM credits c JOIN people p ON p.id = c.person_id JOIN items i ON i.id = c.item_id
        WHERE i.library_id = @libraryId AND (@onlyItemId IS NULL OR i.id = @onlyItemId)
        ORDER BY c.item_id, c.kind, c.billing_order`).all(params) as {
        itemId: number; kind: string; personId: number; name: string; thumb: string | null;
    }[];
    for (const { itemId, kind, personId, name, thumb } of credits) {
        const item = items.get(itemId);
        if (!item) continue;
        people[personId] ??= { name, hasThumb: thumb !== null, imageVersion: imageVersion(thumb) };
        if (kind === 'actor') item.actors.push(personId);
        else if (kind === 'director') item.directors.push(personId);
        else if (kind === 'writer') item.writers.push(personId);
    }

    return { library, people, items: [...items.values()] };
};

// Per (kind, person) totals of a show's episode credits; the character is the one played most often
interface EpisodeTally {
    count: number;
    character: string | null;
}

const tallyKey = (id: number, kind: string, personId: number) => `${id}|${kind}|${personId}`;

const tallyEpisodeCredits = (rows: { id: number; kind: string; personId: number; character: string | null }[]): Map<string, EpisodeTally> => {
    const tallies = new Map<string, EpisodeTally & { characters: Map<string, number> }>();
    for (const { id, kind, personId, character } of rows) {
        const key = tallyKey(id, kind, personId);
        const tally = tallies.get(key) ?? { count: 0, character: null, characters: new Map() };
        tally.count++;
        if (character) tally.characters.set(character, (tally.characters.get(character) ?? 0) + 1);
        tallies.set(key, tally);
    }
    for (const tally of tallies.values()) {
        tally.character = [...tally.characters].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    return tallies;
};

export interface DetailCredit {
    personId: number;
    name: string;
    kind: string;
    billingOrder: number;
    character: string | null;
    hasThumb: boolean;
    imageVersion: string | null;
    // Shows: whether the credit is on the show itself (series cast) rather than only on some of its episodes,
    // and how many episodes credit the person; null for movies and for shows whose episodes aren't synced yet
    showCredit: boolean;
    episodeCount: number | null;
}

export interface EpisodeSummary {
    id: number;
    season: number | null;
    episode: number | null;
    title: string | null;
    airDate: string | null;                   // YYYY-MM-DD
    durationMs: number | null;
    watched: boolean;
}

export interface ItemDetail extends ApiItem {
    library: { id: number; title: string; type: string };
    summary: string | null;
    externalIds: Record<string, string>;
    // Show credits by kind and billing order, then people credited only on episodes, most episodes first
    credits: DetailCredit[];
    episodes: EpisodeSummary[] | null;        // shows only, in season and episode order
}

export const itemDetail = (db: Db, itemId: number): ItemDetail | undefined => {
    const row = db.prepare('SELECT library_id AS libraryId, summary, episodes_signature IS NOT NULL AS episodesListed FROM items WHERE id = ?')
        .get(itemId) as { libraryId: number; summary: string | null; episodesListed: number } | undefined;
    if (!row) return undefined;
    const result = libraryItems(db, row.libraryId, itemId);
    const base = result?.items[0];
    if (!result || !base) return undefined;
    const isShow = result.library.type === 'show';
    const hasEpisodes = isShow && row.episodesListed === 1;
    const externalIds = Object.fromEntries((db.prepare('SELECT provider, external_id AS id FROM item_guids WHERE item_id = ?').all(itemId) as { provider: string; id: string }[])
        .map(({ provider, id }) => [provider, id]));

    const tallies = hasEpisodes ? tallyEpisodeCredits(db.prepare(`
        SELECT e.show_id AS id, ec.kind, ec.person_id AS personId, ec.character
        FROM episode_credits ec JOIN episodes e ON e.id = ec.episode_id
        WHERE e.show_id = ? ORDER BY e.season, e.episode`).all(itemId) as { id: number; kind: string; personId: number; character: string | null }[]) : new Map<string, EpisodeTally>();
    const people = db.prepare('SELECT id, name, thumb FROM people WHERE id = ?');
    const toCredit = (credit: { personId: number; kind: string; billingOrder: number; character: string | null; name: string; thumb: string | null }, showCredit: boolean): DetailCredit => {
        const tally = tallies.get(tallyKey(itemId, credit.kind, credit.personId));
        return {
            personId: credit.personId,
            name: credit.name,
            kind: credit.kind,
            billingOrder: credit.billingOrder,
            character: credit.character ?? tally?.character ?? null,
            hasThumb: credit.thumb !== null,
            imageVersion: imageVersion(credit.thumb),
            showCredit,
            episodeCount: hasEpisodes ? tally?.count ?? 0 : null
        };
    };

    const credits = (db.prepare(`
        SELECT c.person_id AS personId, p.name, c.kind, c.billing_order AS billingOrder, c.character, p.thumb
        FROM credits c JOIN people p ON p.id = c.person_id
        WHERE c.item_id = ? ORDER BY c.kind, c.billing_order`).all(itemId) as { personId: number; name: string; kind: string; billingOrder: number; character: string | null; thumb: string | null }[])
        .map(credit => toCredit(credit, true));
    const onShow = new Set(credits.map(credit => tallyKey(itemId, credit.kind, credit.personId)));
    const episodeOnly = [...tallies.entries()]
        .filter(([key]) => !onShow.has(key))
        .map(([key, tally]) => {
            const [, kind, personId] = key.split('|');
            const person = people.get(Number(personId)) as { id: number; name: string; thumb: string | null };
            return toCredit({ personId: person.id, kind, billingOrder: 0, character: null, name: person.name, thumb: person.thumb }, false);
        })
        .sort((a, b) => a.kind.localeCompare(b.kind) || b.episodeCount! - a.episodeCount! || a.name.localeCompare(b.name));
    episodeOnly.forEach((credit, index) => {
        credit.billingOrder = index;
    });

    const episodes = isShow ? (db.prepare(`
        SELECT id, season, episode, title, air_date AS airDate, duration_ms AS durationMs,
            (last_viewed_at IS NOT NULL OR COALESCE(view_count, 0) > 0) AS watched
        FROM episodes WHERE show_id = ?
        ORDER BY season IS NULL, season, episode IS NULL, episode, air_date`).all(itemId) as (Omit<EpisodeSummary, 'watched'> & { watched: number })[])
        .map(episode => ({ ...episode, watched: episode.watched === 1 })) : null;

    const { id, title, type } = result.library;
    return { ...base, library: { id, title, type }, summary: row.summary, externalIds, credits: [...credits, ...episodeOnly], episodes };
};

export interface PersonCredit {
    itemId: number;
    libraryId: number;
    libraryTitle: string;
    libraryType: string;
    title: string;
    titleSort: string;
    year: number | null;
    rating: number | null;
    criticRating: number | null;
    watched: boolean;
    leafCount: number | null;                 // shows: episodes
    viewedLeafCount: number | null;           // shows: watched episodes
    hasThumb: boolean;
    imageVersion: number | null;
    kind: string;
    billingOrder: number;
    character: string | null;
    // Shows: whether the credit is on the show itself, and how many of its episodes credit the person
    // (null for movies and for shows whose episodes aren't synced yet)
    showCredit: boolean;
    episodeCount: number | null;
}

export interface PersonDetail {
    id: number;
    name: string;
    hasThumb: boolean;
    imageVersion: string | null;
    credits: PersonCredit[];                  // newest first; a title appears once per kind of credit
}

export const personDetail = (db: Db, personId: number): PersonDetail | undefined => {
    const person = db.prepare('SELECT id, name, thumb FROM people WHERE id = ?').get(personId) as { id: number; name: string; thumb: string | null } | undefined;
    if (!person) return undefined;
    const itemColumns = `
        i.id AS itemId, i.library_id AS libraryId, l.title AS libraryTitle, l.type AS libraryType, i.title,
        COALESCE(i.title_sort, i.title) AS titleSort, i.year, i.audience_rating AS rating, i.critic_rating AS criticRating,
        (i.last_viewed_at IS NOT NULL OR COALESCE(i.view_count, 0) > 0) AS watched,
        i.leaf_count AS leafCount, i.viewed_leaf_count AS viewedLeafCount,
        i.thumb IS NOT NULL AS hasThumb, i.updated_at AS imageVersion, i.episodes_signature IS NOT NULL AS episodesListed`;
    // Credits on titles, then credits only on episodes of a show, one row per show and kind
    const rows = db.prepare(`
        SELECT * FROM (
            SELECT ${itemColumns}, c.kind, c.billing_order AS billingOrder, c.character, 1 AS showCredit
            FROM credits c JOIN items i ON i.id = c.item_id JOIN libraries l ON l.id = i.library_id
            WHERE c.person_id = @personId
            UNION ALL
            SELECT DISTINCT ${itemColumns}, ec.kind, 0 AS billingOrder, NULL AS character, 0 AS showCredit
            FROM episode_credits ec JOIN episodes e ON e.id = ec.episode_id
                JOIN items i ON i.id = e.show_id JOIN libraries l ON l.id = i.library_id
            WHERE ec.person_id = @personId
                AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.item_id = i.id AND c.person_id = @personId AND c.kind = ec.kind)
        )
        ORDER BY year IS NULL, year DESC, titleSort, kind`).all({ personId }) as (Omit<PersonCredit, 'watched' | 'hasThumb' | 'showCredit' | 'episodeCount'> & {
        watched: number; hasThumb: number; showCredit: number; episodesListed: number;
    })[];
    const tallies = tallyEpisodeCredits(db.prepare(`
        SELECT e.show_id AS id, ec.kind, ec.person_id AS personId, ec.character
        FROM episode_credits ec JOIN episodes e ON e.id = ec.episode_id
        WHERE ec.person_id = ? ORDER BY e.season, e.episode`).all(personId) as { id: number; kind: string; personId: number; character: string | null }[]);
    const credits = rows.map(({ episodesListed, ...credit }) => {
        const tally = tallies.get(tallyKey(credit.itemId, credit.kind, personId));
        return {
            ...credit,
            character: credit.character ?? tally?.character ?? null,
            watched: credit.watched === 1,
            hasThumb: credit.hasThumb === 1,
            showCredit: credit.showCredit === 1,
            episodeCount: credit.libraryType === 'show' && episodesListed === 1 ? tally?.count ?? 0 : null
        };
    });
    return { id: person.id, name: person.name, hasThumb: person.thumb !== null, imageVersion: imageVersion(person.thumb), credits };
};
