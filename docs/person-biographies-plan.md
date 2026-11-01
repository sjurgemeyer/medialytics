# Plan: Biographical Information for People

**Status:** Draft. Sourcing is decided; how it appears in the app is still to design.
**Date:** 2026-11-01

## Goal

Add the following to each person, in order of importance:

1. Brief biography
2. Birth date and death date
3. Spouse and children
4. Movies they made that are not in the collection

## Decisions

- **TMDb** is the main source. You provide a free API key through `TMDB_API_KEY`. Without a key, the feature is switched off and person pages work as they do today.
- **Wikidata** provides spouses and children. It is also a fallback for missing birth and death dates.
- **Wikipedia** supplies the opening of the person's article, used only when TMDb has no biography.
- **Free usage only:** the background process stays well inside each service's free usage limits.
- **Movies first:** only people with at least one credit in a movie library are enriched. "Movies not in the collection" covers movies only.
- **Family:** we show whatever Wikidata has. A relative who is also in the library links to their own person page.

## Sources

| Information | Source | Where it comes from in the API |
|---|---|---|
| Biography | TMDb, falling back to Wikipedia | the person's `biography` field on TMDb, or the opening of their Wikipedia article |
| Birth and death date, birthplace | TMDb, falling back to Wikidata | TMDb's `birthday`, `deathday` and `place_of_birth` fields; Wikidata's date of birth and date of death |
| Spouse, with start and end dates | Wikidata | the spouse property, with its start-time and end-time qualifiers |
| Children | Wikidata | the child property |
| Movies not in the collection | TMDb | the person's `movie_credits`, minus movies whose TMDb ID is in the library |

**What Wikidata covers:** it lists children only when they are notable, and family data in general is reliable only for well-known people. Empty family sections are expected and fine.

## Identifying each person

People in our database have only a name and a Plex `tag_key`. Neither identifies them outside Plex, and matching on name alone fails for shared names. Instead, each person is identified through the movies they appear in. Every step below is an exact ID lookup, apart from step 2, which matches names within a single movie's credits:

1. **The movie's TMDb ID** comes from `item_guids`. A movie with only an IMDb ID is converted with TMDb's `/find/{imdb_id}`.
2. **Matching credits:** TMDb's `/movie/{id}/credits` lists the movie's cast and crew with TMDb person IDs. Each of our credits is matched to an entry by a normalised name:
   - an actor to a cast entry;
   - a director to a crew entry with job "Director";
   - a writer to a crew entry in the Writing department.

   When two entries share a name, the character name, or the person's position in the billing order, decides between them. A person who matches the same TMDb ID in two or more movies is confirmed.
3. **Person details:** TMDb's `/person/{id}` request, with `movie_credits` and `external_ids` added, returns the details, the full movie credits and the IMDb ID in **one request**.
4. **Wikidata:** a SPARQL query finds people by TMDb person ID, falling back to the IMDb ID. Each query covers about 50 people and returns their QIDs, birth and death dates, spouses and children. It also returns each relative's TMDb ID, which is used to link relatives who are in the library.
5. **Wikipedia:** an English article title comes from the person's Wikidata entry. The REST summary endpoint then returns the opening of that article, for people without a TMDb biography.

## Request budget

TMDb has no daily quota; its documented ceiling is about 40 to 50 requests a second per IP address. Wikidata asks for a descriptive User-Agent and limits each client to 60 seconds of query time a minute. We stay far below both limits:

| Setting | Value |
|---|---|
| Rate limit for TMDb | 2 requests a second, one at a time (configurable) |
| Rate limit for Wikidata | 1 batched query every 5 seconds |
| User-Agent | `MediaData/<version> (self-hosted Plex companion)` |
| Response to HTTP 429 or 5xx | back off, honour `Retry-After`, and pause the background pass for a few minutes |

**First pass for a library of 1,000 movies and about 15,000 people:**
- TMDb: about 1,000 credit requests plus 15,000 person requests, roughly 2.3 hours at 2 requests a second.
- Wikidata: about 300 batched queries, roughly 25 minutes.

**After the first pass:**
- New movies cost one credit request each, plus a person request for each new person.
- Refreshes are spread out, so they come to a few hundred requests a day.

## Fetching

### During sync

When a movie is new or changed, its TMDb credits are fetched. This job is queued, not run inline, so it never slows the Plex sync.

### Background pass

A single worker runs whenever there is work and the API key is set. Its order is:

1. people whose page was opened and who have no details yet;
2. people with no details yet, those with the most movie credits first;
3. details that have become stale.

Details are refreshed after 30 days, so a newly recorded death date appears within a month.

### When a person's page is opened

If the person has no details yet, they jump to the front of the queue and the page shows what is already known. The details appear the next time the page is opened. Fetching in the background, not when the page loads, keeps a single worker in charge of the request rate.

## Storage (migration 3)

```sql
ALTER TABLE items ADD COLUMN tmdb_credits_fetched_at INTEGER;

CREATE TABLE person_details (
    person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    tmdb_id INTEGER,
    imdb_id TEXT,
    wikidata_id TEXT,
    biography TEXT,
    biography_source TEXT,           -- 'tmdb' | 'wikipedia'
    birth_date TEXT,                 -- ISO date; may be year-only from Wikidata
    death_date TEXT,
    birth_place TEXT,
    fetched_at INTEGER,              -- NULL = not fetched yet
    requested_at INTEGER             -- set when a person's page asks for details
);
CREATE INDEX person_details_tmdb ON person_details(tmdb_id);

CREATE TABLE person_relations (
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,          -- 'spouse' | 'child'
    name TEXT NOT NULL,
    wikidata_id TEXT,
    tmdb_id INTEGER,                 -- links to a person in the library when it matches
    start_date TEXT,
    end_date TEXT
);

CREATE TABLE person_movie_credits (
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    tmdb_movie_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    release_date TEXT,
    role TEXT NOT NULL,              -- 'actor' | 'director' | 'writer'
    character TEXT,
    poster_path TEXT,
    PRIMARY KEY (person_id, tmdb_movie_id, role)
);
```

"Not in the collection" is worked out when a page is requested, by comparing against `item_guids`. Adding a movie to Plex therefore updates the list straight away, with no refetch.

## Code layout

- `src/server/tmdb/client.ts`: a typed TMDb client with the rate limiter and back-off.
- `src/server/wikidata/client.ts`: the SPARQL client and the Wikipedia summary lookup.
- `src/server/enrich/service.ts`: credit matching, the queue order, and writing the results.
- `src/server/enrich/scheduler.ts`: starts the worker after sync and restarts it after a pause.
- `test/fixtures/fake-tmdb.ts` and `fake-wikidata.ts`: fake servers for tests, in the same style as the existing fake Plex server.
- `/api/health`: reports progress, as people enriched out of eligible people.

## Attribution

TMDb's terms require the notice "This product uses the TMDB API but is not endorsed or certified by TMDB" with their logo, for example in a footer or an About panel. A Wikipedia biography needs a "From Wikipedia" credit with a link to the article. Wikidata is public domain and needs no credit.

## Next: how it appears in the app

Still to design, one section at a time:

1. Where the biography goes on the person page, and how much to show before a "more" link.
2. How birth and death dates are shown: on the person page, as life years in the hover popup, and possibly as age at release in credit tables.
3. How spouses and children are laid out, including links to relatives in the library.
4. How movies not in the collection are shown: a separate table or mixed with owned movies, plus posters and links to TMDb.
