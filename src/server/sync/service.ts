import type { Db } from '../db/index.js';
import type { PlexClient } from '../plex/client.js';
import type { PlexItem, PlexTag } from '../plex/types.js';

export interface SyncLogger {
    info(object: object, message?: string): void;
    warn(object: object, message?: string): void;
    error(object: object, message?: string): void;
}

export interface SyncOptions {
    batchSize?: number;
    concurrency?: number;
}

export interface SyncStatus {
    state: 'idle' | 'running' | 'failed';
    runId: number | null;
    startedAt: number | null;
    finishedAt: number | null;
    // What the running sync is doing right now
    step: 'libraries' | 'listing' | 'credits' | 'episodes' | 'episode-credits' | null;
    library: string | null;
    itemsSeen: number;
    creditsFetched: number;
    creditsTotal: number;
    // Shows whose episode lists were fetched, and episodes whose full credits were fetched
    episodeListsFetched: number;
    episodeListsTotal: number;
    episodeCreditsFetched: number;
    episodeCreditsTotal: number;
    itemsRemoved: number;
    failedBatches: number;
    error: string | null;
    lastCompletedAt: number | null;
}

const supportedLibraryTypes = new Set(['movie', 'show']);
const creditKinds = [
    { field: 'Role', kind: 'actor' },
    { field: 'Director', kind: 'director' },
    { field: 'Writer', kind: 'writer' }
] as const;
const tagKinds = [
    { field: 'Genre', kind: 'genre' },
    { field: 'Country', kind: 'country' }
] as const;

// "imdb://tt0111161" -> ["imdb", "tt0111161"]; legacy agent guids carry the IMDb id directly
const parseGuid = (guid: string): [string, string] | null => {
    const match = /^([a-z]+):\/\/([^?]+)/.exec(guid);
    if (match) return [match[1], match[2]];
    const legacy = /^com\.plexapp\.agents\.imdb:\/\/(tt\d+)/.exec(guid);
    return legacy ? ['imdb', legacy[1]] : null;
};

const externalIds = (item: PlexItem): Map<string, string> => {
    const ids = new Map<string, string>();
    for (const guid of item.Guid ?? []) {
        const parsed = guid.id ? parseGuid(guid.id) : null;
        if (parsed && parsed[0] !== 'plex') ids.set(parsed[0], parsed[1]);
    }
    if (item.guid?.startsWith('com.plexapp.agents.imdb://')) {
        const parsed = parseGuid(item.guid);
        if (parsed && !ids.has('imdb')) ids.set(parsed[0], parsed[1]);
    }
    return ids;
};

const emptyCounts = () => ({
    itemsSeen: 0, creditsFetched: 0, creditsTotal: 0, itemsRemoved: 0, failedBatches: 0,
    episodeListsFetched: 0, episodeListsTotal: 0, episodeCreditsFetched: 0, episodeCreditsTotal: 0
});

// Show fields that change whenever its episodes do (added, removed, edited or watched)
const episodesSignature = (show: PlexItem): string =>
    [show.updatedAt, show.leafCount, show.viewedLeafCount, show.lastViewedAt].map(value => value ?? '').join('|');

interface CreditFetch {
    id: number;
    ratingKey: string;
    updatedAt: number | null;
}

const personIdentity = (tag: PlexTag): string => (tag.tagKey ? `key:${tag.tagKey}` : `name:${tag.tag}`);

const numberOrNull = (value: unknown): number | null => {
    const number = Number(value);
    return value === undefined || value === null || value === '' || !Number.isFinite(number) ? null : number;
};

export class SyncService {
    private current: Promise<SyncStatus> | null = null;
    private state: SyncStatus;
    private readonly batchSize: number;
    private readonly concurrency: number;
    private readonly statements;
    // Bumped whenever synced data changes, so API responses can be cached by version
    private version = 0;

    constructor(private readonly db: Db, private readonly plex: PlexClient, private readonly log: SyncLogger, options: SyncOptions = {}) {
        this.batchSize = options.batchSize ?? 50;
        this.concurrency = options.concurrency ?? 3;
        const last = db.prepare("SELECT MAX(finished_at) AS finished FROM sync_runs WHERE status = 'done'").get() as { finished: number | null };
        this.state = {
            state: 'idle', runId: null, startedAt: null, finishedAt: null, step: null, library: null,
            ...emptyCounts(), error: null,
            lastCompletedAt: last.finished
        };
        this.statements = {
            upsertLibrary: db.prepare(`
                INSERT INTO libraries (plex_key, title, type) VALUES (@key, @title, @type)
                ON CONFLICT (plex_key) DO UPDATE SET title = excluded.title, type = excluded.type
                RETURNING id`),
            libraries: db.prepare('SELECT id, plex_key AS key FROM libraries'),
            deleteLibrary: db.prepare('DELETE FROM libraries WHERE id = ?'),
            markLibrarySynced: db.prepare('UPDATE libraries SET last_synced_at = ? WHERE id = ?'),
            existingItems: db.prepare(`SELECT id, rating_key AS ratingKey, updated_at AS updatedAt, credits_updated_at AS creditsUpdatedAt,
                episodes_signature AS episodesSignature FROM items WHERE library_id = ?`),
            upsertItem: db.prepare(`
                INSERT INTO items (library_id, rating_key, guid, title, title_sort, year, audience_rating, critic_rating,
                    content_rating, duration_ms, studio, summary, child_count, leaf_count, viewed_leaf_count, added_at,
                    updated_at, last_viewed_at, view_count, thumb, art)
                VALUES (@libraryId, @ratingKey, @guid, @title, @titleSort, @year, @audienceRating, @criticRating,
                    @contentRating, @durationMs, @studio, @summary, @childCount, @leafCount, @viewedLeafCount, @addedAt,
                    @updatedAt, @lastViewedAt, @viewCount, @thumb, @art)
                ON CONFLICT (rating_key) DO UPDATE SET
                    library_id = excluded.library_id, guid = excluded.guid, title = excluded.title,
                    title_sort = excluded.title_sort, year = excluded.year, audience_rating = excluded.audience_rating,
                    critic_rating = excluded.critic_rating, content_rating = excluded.content_rating,
                    duration_ms = excluded.duration_ms, studio = excluded.studio, summary = excluded.summary,
                    child_count = excluded.child_count, leaf_count = excluded.leaf_count,
                    viewed_leaf_count = excluded.viewed_leaf_count, added_at = excluded.added_at,
                    updated_at = excluded.updated_at, last_viewed_at = excluded.last_viewed_at,
                    view_count = excluded.view_count, thumb = excluded.thumb, art = excluded.art
                RETURNING id`),
            deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
            deleteGuids: db.prepare('DELETE FROM item_guids WHERE item_id = ?'),
            insertGuid: db.prepare('INSERT INTO item_guids (item_id, provider, external_id) VALUES (?, ?, ?)'),
            deleteCredits: db.prepare('DELETE FROM credits WHERE item_id = ?'),
            deleteItemTags: db.prepare('DELETE FROM item_tags WHERE item_id = ?'),
            upsertPerson: db.prepare(`
                INSERT INTO people (identity, name, tag_key, thumb) VALUES (@identity, @name, @tagKey, @thumb)
                ON CONFLICT (identity) DO UPDATE SET
                    name = excluded.name,
                    tag_key = COALESCE(excluded.tag_key, people.tag_key),
                    thumb = COALESCE(excluded.thumb, people.thumb)
                RETURNING id`),
            insertCredit: db.prepare('INSERT OR IGNORE INTO credits (item_id, person_id, kind, billing_order, character) VALUES (?, ?, ?, ?, ?)'),
            upsertTag: db.prepare(`
                INSERT INTO tags (kind, name) VALUES (?, ?)
                ON CONFLICT (kind, name) DO UPDATE SET name = excluded.name
                RETURNING id`),
            insertItemTag: db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id, position) VALUES (?, ?, ?)'),
            markCreditsFetched: db.prepare('UPDATE items SET credits_updated_at = ? WHERE id = ?'),
            resetCredits: db.prepare('UPDATE items SET credits_updated_at = NULL, episodes_signature = NULL'),
            resetEpisodeCredits: db.prepare('UPDATE episodes SET credits_updated_at = NULL'),
            markEpisodesListed: db.prepare('UPDATE items SET episodes_signature = ? WHERE id = ?'),
            showEpisodes: db.prepare('SELECT id, rating_key AS ratingKey FROM episodes WHERE show_id = ?'),
            upsertEpisode: db.prepare(`
                INSERT INTO episodes (show_id, rating_key, season, episode, title, air_date, duration_ms, updated_at,
                    last_viewed_at, view_count)
                VALUES (@showId, @ratingKey, @season, @episode, @title, @airDate, @durationMs, @updatedAt,
                    @lastViewedAt, @viewCount)
                ON CONFLICT (rating_key) DO UPDATE SET
                    show_id = excluded.show_id, season = excluded.season, episode = excluded.episode,
                    title = excluded.title, air_date = excluded.air_date, duration_ms = excluded.duration_ms,
                    updated_at = excluded.updated_at, last_viewed_at = excluded.last_viewed_at,
                    view_count = excluded.view_count
                RETURNING id`),
            deleteEpisode: db.prepare('DELETE FROM episodes WHERE id = ?'),
            // Episodes never fetched in full, or edited in Plex since
            episodesNeedingCredits: db.prepare(`
                SELECT e.id, e.rating_key AS ratingKey, e.updated_at AS updatedAt
                FROM episodes e JOIN items i ON i.id = e.show_id
                WHERE i.library_id = ? AND (e.credits_updated_at IS NULL OR e.credits_updated_at < COALESCE(e.updated_at, 0))
                ORDER BY e.id`),
            deleteEpisodeCredits: db.prepare('DELETE FROM episode_credits WHERE episode_id = ?'),
            insertEpisodeCredit: db.prepare('INSERT OR IGNORE INTO episode_credits (episode_id, person_id, kind, billing_order, character) VALUES (?, ?, ?, ?, ?)'),
            markEpisodeCreditsFetched: db.prepare('UPDATE episodes SET credits_updated_at = ? WHERE id = ?'),
            deleteOrphanPeople: db.prepare(`
                DELETE FROM people WHERE id NOT IN (SELECT person_id FROM credits UNION SELECT person_id FROM episode_credits)`),
            deleteOrphanTags: db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM item_tags)'),
            startRun: db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running') RETURNING id"),
            finishRun: db.prepare(`
                UPDATE sync_runs SET finished_at = @finishedAt, status = @status, items_seen = @itemsSeen,
                    credits_fetched = @creditsFetched, items_removed = @itemsRemoved, error = @error
                WHERE id = @id`)
        };
    }

    status(): SyncStatus {
        return { ...this.state };
    }

    dataVersion(): number {
        return this.version;
    }

    isRunning(): boolean {
        return this.current !== null;
    }

    // Starts a sync, or returns the one already running. full re-fetches credits for every item.
    run({ full = false }: { full?: boolean } = {}): Promise<SyncStatus> {
        if (!this.current) {
            this.current = this.execute(full).finally(() => {
                this.current = null;
            });
        }
        return this.current;
    }

    private async execute(full: boolean): Promise<SyncStatus> {
        const startedAt = Date.now();
        const runId = (this.statements.startRun.get(startedAt) as { id: number }).id;
        this.state = {
            ...this.state, state: 'running', runId, startedAt, finishedAt: null, step: 'libraries', library: null,
            ...emptyCounts(), error: null
        };
        this.log.info({ runId, full }, 'sync started');
        try {
            if (full) {
                this.statements.resetCredits.run();
                this.statements.resetEpisodeCredits.run();
            }
            await this.syncLibraries();
            this.db.transaction(() => {
                this.statements.deleteOrphanPeople.run();
                this.statements.deleteOrphanTags.run();
            })();
            const finishedAt = Date.now();
            const failed = this.state.failedBatches > 0;
            this.state = {
                ...this.state, state: 'idle', step: null, library: null, finishedAt, lastCompletedAt: finishedAt,
                error: failed ? `${this.state.failedBatches} request(s) to Plex failed; they will be retried on the next sync` : null
            };
            this.finishRun('done');
            this.log.info({ runId, ...this.summary() }, 'sync finished');
        } catch (error) {
            this.state = { ...this.state, state: 'failed', step: null, finishedAt: Date.now(), error: (error as Error).message };
            this.finishRun('failed');
            this.log.error({ runId, err: error }, 'sync failed');
        }
        return this.status();
    }

    private summary() {
        const { itemsSeen, creditsFetched, itemsRemoved, failedBatches, episodeListsFetched, episodeCreditsFetched } = this.state;
        return { itemsSeen, creditsFetched, itemsRemoved, failedBatches, episodeListsFetched, episodeCreditsFetched };
    }

    private finishRun(status: 'done' | 'failed') {
        this.statements.finishRun.run({ id: this.state.runId, finishedAt: this.state.finishedAt, status, error: this.state.error, ...this.summary() });
    }

    private async syncLibraries() {
        const directories = (await this.plex.libraries()).filter(directory =>
            directory.key && directory.title && directory.type && supportedLibraryTypes.has(directory.type));

        const keep = new Set(directories.map(directory => directory.key));
        const removed = (this.statements.libraries.all() as { id: number; key: string }[]).filter(library => !keep.has(library.key));
        if (removed.length) {
            this.db.transaction(() => removed.forEach(library => this.statements.deleteLibrary.run(library.id)))();
            this.version++;
        }

        for (const directory of directories) {
            const libraryId = (this.statements.upsertLibrary.get({ key: directory.key, title: directory.title, type: directory.type }) as { id: number }).id;
            this.state.library = directory.title!;
            await this.syncLibrary(libraryId, directory.key!, directory.type!);
        }
    }

    private async syncLibrary(libraryId: number, libraryKey: string, type: string) {
        this.state.step = 'listing';
        const listing = (await this.plex.libraryItems(libraryKey)).filter(item => item.ratingKey && item.title);
        this.state.itemsSeen += listing.length;

        const existing = new Map((this.statements.existingItems.all(libraryId) as {
            id: number; ratingKey: string; updatedAt: number | null; creditsUpdatedAt: number | null; episodesSignature: string | null;
        }[]).map(row => [row.ratingKey, row]));

        // Upsert every listed item; collect the ones whose full credits or episode lists need (re)fetching
        const needsCredits: CreditFetch[] = [];
        const needsEpisodes: { id: number; ratingKey: string; signature: string }[] = [];
        this.db.transaction(() => {
            for (const item of listing) {
                const previous = existing.get(item.ratingKey!);
                existing.delete(item.ratingKey!);
                const itemId = this.upsertItem(libraryId, item);
                const updatedAt = numberOrNull(item.updatedAt);
                const creditsCurrent = previous?.creditsUpdatedAt != null && (updatedAt === null || previous.creditsUpdatedAt >= updatedAt);
                if (!creditsCurrent) {
                    needsCredits.push({ id: itemId, ratingKey: item.ratingKey!, updatedAt });
                    // Until full credits arrive, show the truncated ones from the listing
                    if (previous?.creditsUpdatedAt == null) this.writeDetails(itemId, item);
                }
                const signature = episodesSignature(item);
                if (type === 'show' && previous?.episodesSignature !== signature) {
                    needsEpisodes.push({ id: itemId, ratingKey: item.ratingKey!, signature });
                }
            }
            // Anything left in `existing` is no longer in Plex
            for (const gone of existing.values()) {
                this.statements.deleteItem.run(gone.id);
                this.state.itemsRemoved++;
            }
        })();
        this.version++;

        this.state.step = 'credits';
        this.state.creditsTotal += needsCredits.length;
        const failedBefore = this.state.failedBatches;
        await this.fetchCredits(needsCredits, (id, detail) => {
            this.writeDetails(id, detail);
            this.statements.markCreditsFetched.run(numberOrNull(detail.updatedAt) ?? 0, id);
        }, count => {
            this.state.creditsFetched += count;
        });

        if (type === 'show') await this.syncEpisodes(libraryId, needsEpisodes);

        if (this.state.failedBatches === failedBefore) {
            this.statements.markLibrarySynced.run(Date.now(), libraryId);
        }
    }

    // Runs task over every entry, a few at a time
    private async forEachConcurrently<T>(entries: T[], task: (entry: T) => Promise<void>) {
        let next = 0;
        const worker = async () => {
            while (next < entries.length) await task(entries[next++]);
        };
        await Promise.all(Array.from({ length: Math.min(this.concurrency, entries.length) }, worker));
    }

    // Fetches full metadata in batches and hands each item to write, inside one transaction per batch
    private async fetchCredits(items: CreditFetch[], write: (id: number, detail: PlexItem) => void, onBatch: (count: number) => void) {
        const batches: CreditFetch[][] = [];
        for (let i = 0; i < items.length; i += this.batchSize) {
            batches.push(items.slice(i, i + this.batchSize));
        }
        await this.forEachConcurrently(batches, async batch => {
            try {
                const full = await this.plex.metadata(batch.map(item => item.ratingKey));
                const byKey = new Map(full.map(item => [item.ratingKey, item]));
                this.db.transaction(() => {
                    for (const item of batch) {
                        const detail = byKey.get(item.ratingKey);
                        if (detail) write(item.id, { ...detail, updatedAt: detail.updatedAt ?? item.updatedAt ?? 0 });
                    }
                })();
                this.version++;
                onBatch(batch.length);
            } catch (error) {
                this.state.failedBatches++;
                this.log.warn({ err: error, ratingKeys: batch.map(item => item.ratingKey) }, 'credit batch failed');
            }
        });
    }

    // Lists the episodes of every show that changed, then fetches full credits for new or edited episodes.
    // A show whose listing fails keeps its old signature, so it is listed again on the next sync.
    private async syncEpisodes(libraryId: number, shows: { id: number; ratingKey: string; signature: string }[]) {
        this.state.step = 'episodes';
        this.state.episodeListsTotal += shows.length;
        await this.forEachConcurrently(shows, async show => {
            try {
                const episodes = (await this.plex.episodes(show.ratingKey)).filter(episode => episode.ratingKey);
                this.db.transaction(() => {
                    const existing = new Map((this.statements.showEpisodes.all(show.id) as { id: number; ratingKey: string }[])
                        .map(row => [row.ratingKey, row.id]));
                    for (const episode of episodes) {
                        existing.delete(episode.ratingKey!);
                        this.statements.upsertEpisode.run({
                            showId: show.id,
                            ratingKey: episode.ratingKey,
                            season: numberOrNull(episode.parentIndex),
                            episode: numberOrNull(episode.index),
                            title: episode.title ?? null,
                            airDate: episode.originallyAvailableAt ?? null,
                            durationMs: numberOrNull(episode.duration),
                            updatedAt: numberOrNull(episode.updatedAt),
                            lastViewedAt: numberOrNull(episode.lastViewedAt),
                            viewCount: numberOrNull(episode.viewCount)
                        });
                    }
                    for (const goneId of existing.values()) this.statements.deleteEpisode.run(goneId);
                    this.statements.markEpisodesListed.run(show.signature, show.id);
                })();
                this.version++;
                this.state.episodeListsFetched++;
            } catch (error) {
                this.state.failedBatches++;
                this.log.warn({ err: error, ratingKey: show.ratingKey }, 'episode listing failed');
            }
        });

        this.state.step = 'episode-credits';
        const needsCredits = this.statements.episodesNeedingCredits.all(libraryId) as CreditFetch[];
        this.state.episodeCreditsTotal += needsCredits.length;
        await this.fetchCredits(needsCredits, (id, detail) => {
            this.statements.deleteEpisodeCredits.run(id);
            this.forEachCredit(detail, (person, kind, order, character) => this.statements.insertEpisodeCredit.run(id, person, kind, order, character));
            this.statements.markEpisodeCreditsFetched.run(numberOrNull(detail.updatedAt) ?? 0, id);
        }, count => {
            this.state.episodeCreditsFetched += count;
        });
    }

    // Calls add for every cast and crew credit in item, creating or updating the person
    private forEachCredit(item: PlexItem, add: (personId: number, kind: string, order: number, character: string | null) => void) {
        for (const { field, kind } of creditKinds) {
            (item[field] ?? []).filter(tag => tag.tag).forEach((tag, order) => {
                const person = this.statements.upsertPerson.get({
                    identity: personIdentity(tag), name: tag.tag, tagKey: tag.tagKey ?? null, thumb: tag.thumb ?? null
                }) as { id: number };
                add(person.id, kind, order, tag.role ?? null);
            });
        }
    }

    private upsertItem(libraryId: number, item: PlexItem): number {
        const row = this.statements.upsertItem.get({
            libraryId,
            ratingKey: item.ratingKey,
            guid: item.guid ?? null,
            title: item.title,
            titleSort: item.titleSort ?? null,
            year: numberOrNull(item.year),
            audienceRating: numberOrNull(item.audienceRating),
            criticRating: numberOrNull(item.rating),
            contentRating: item.contentRating ?? null,
            durationMs: numberOrNull(item.duration),
            studio: item.studio ?? null,
            summary: item.summary ?? null,
            childCount: numberOrNull(item.childCount),
            leafCount: numberOrNull(item.leafCount),
            addedAt: numberOrNull(item.addedAt),
            updatedAt: numberOrNull(item.updatedAt),
            lastViewedAt: numberOrNull(item.lastViewedAt),
            viewCount: numberOrNull(item.viewCount),
            viewedLeafCount: numberOrNull(item.viewedLeafCount),
            thumb: item.thumb ?? null,
            art: item.art ?? null
        }) as { id: number };
        const ids = externalIds(item);
        if (ids.size) {
            this.statements.deleteGuids.run(row.id);
            for (const [provider, externalId] of ids) this.statements.insertGuid.run(row.id, provider, externalId);
        }
        return row.id;
    }

    // Replaces an item's credits, genres, countries and external ids with those in `item`
    private writeDetails(itemId: number, item: PlexItem) {
        this.statements.deleteCredits.run(itemId);
        this.statements.deleteItemTags.run(itemId);
        // A person credited twice (e.g. two roles) keeps their first, highest billing
        this.forEachCredit(item, (person, kind, order, character) => this.statements.insertCredit.run(itemId, person, kind, order, character));
        for (const { field, kind } of tagKinds) {
            (item[field] ?? []).filter(tag => tag.tag).forEach((tag, position) => {
                const row = this.statements.upsertTag.get(kind, tag.tag) as { id: number };
                this.statements.insertItemTag.run(itemId, row.id, position);
            });
        }
        const ids = externalIds(item);
        if (ids.size) {
            this.statements.deleteGuids.run(itemId);
            for (const [provider, externalId] of ids) this.statements.insertGuid.run(itemId, provider, externalId);
        }
    }
}
