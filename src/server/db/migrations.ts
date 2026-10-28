// Schema migrations, applied in order at startup. Never edit a released migration; add a new one.
export interface Migration {
    version: number;
    description: string;
    sql: string;
}

export const migrations: Migration[] = [
    {
        version: 1,
        description: 'Initial schema',
        sql: `
            CREATE TABLE libraries (
                id INTEGER PRIMARY KEY,
                plex_key TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                type TEXT NOT NULL,              -- 'movie' | 'show'
                last_synced_at INTEGER           -- epoch ms of the last completed sync
            );

            CREATE TABLE items (
                id INTEGER PRIMARY KEY,
                library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
                rating_key TEXT NOT NULL UNIQUE,
                guid TEXT,
                title TEXT NOT NULL,
                title_sort TEXT,
                year INTEGER,
                audience_rating REAL,
                critic_rating REAL,
                content_rating TEXT,
                duration_ms INTEGER,             -- per episode for shows
                studio TEXT,
                summary TEXT,
                child_count INTEGER,             -- seasons (shows)
                leaf_count INTEGER,              -- episodes (shows)
                added_at INTEGER,                -- epoch seconds, as Plex reports them
                updated_at INTEGER,
                last_viewed_at INTEGER,
                view_count INTEGER,
                thumb TEXT,
                art TEXT,
                credits_updated_at INTEGER       -- Plex updated_at when full credits were last fetched; NULL = never
            );
            CREATE INDEX items_library ON items(library_id);

            CREATE TABLE item_guids (
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                provider TEXT NOT NULL,          -- 'imdb' | 'tmdb' | 'tvdb' ...
                external_id TEXT NOT NULL,
                PRIMARY KEY (item_id, provider)
            );

            CREATE TABLE people (
                id INTEGER PRIMARY KEY,
                identity TEXT NOT NULL UNIQUE,   -- 'key:<plex tagKey>' when Plex has one, else 'name:<name>'
                name TEXT NOT NULL,
                tag_key TEXT,
                thumb TEXT
            );

            CREATE TABLE credits (
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                person_id INTEGER NOT NULL REFERENCES people(id),
                kind TEXT NOT NULL,              -- 'actor' | 'director' | 'writer'
                billing_order INTEGER NOT NULL,  -- position in Plex's list, 0 = top billed
                character TEXT,
                PRIMARY KEY (item_id, kind, person_id)
            );
            CREATE INDEX credits_person ON credits(person_id);

            CREATE TABLE tags (
                id INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,              -- 'genre' | 'country'
                name TEXT NOT NULL,
                UNIQUE (kind, name)
            );

            CREATE TABLE item_tags (
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id),
                position INTEGER NOT NULL,
                PRIMARY KEY (item_id, tag_id)
            );

            CREATE TABLE sync_runs (
                id INTEGER PRIMARY KEY,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                status TEXT NOT NULL,            -- 'running' | 'done' | 'failed'
                items_seen INTEGER NOT NULL DEFAULT 0,
                credits_fetched INTEGER NOT NULL DEFAULT 0,
                items_removed INTEGER NOT NULL DEFAULT 0,
                error TEXT
            );
        `
    },
    {
        version: 2,
        description: 'TV episodes and their credits',
        sql: `
            ALTER TABLE items ADD COLUMN viewed_leaf_count INTEGER;   -- watched episodes (shows)
            -- Show fields that change when its episodes do, as of the last episode listing; NULL = never listed
            ALTER TABLE items ADD COLUMN episodes_signature TEXT;

            CREATE TABLE episodes (
                id INTEGER PRIMARY KEY,
                show_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                rating_key TEXT NOT NULL UNIQUE,
                season INTEGER,
                episode INTEGER,
                title TEXT,
                air_date TEXT,                   -- YYYY-MM-DD
                duration_ms INTEGER,
                updated_at INTEGER,
                last_viewed_at INTEGER,
                view_count INTEGER,
                credits_updated_at INTEGER       -- Plex updated_at when full credits were last fetched; NULL = never
            );
            CREATE INDEX episodes_show ON episodes(show_id);

            CREATE TABLE episode_credits (
                episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                person_id INTEGER NOT NULL REFERENCES people(id),
                kind TEXT NOT NULL,              -- 'actor' | 'director' | 'writer'
                billing_order INTEGER NOT NULL,
                character TEXT,
                PRIMARY KEY (episode_id, kind, person_id)
            );
            CREATE INDEX episode_credits_person ON episode_credits(person_id);
        `
    }
];
