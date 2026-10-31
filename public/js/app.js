// MediaData browser app: loads libraries from the MediaData API and renders the Cast & Crew page.
// Loaded after components.js and charts.js.

const ratingBounds = [0, 10];
const lengthStepMinutes = 5;
// Detail page addresses: #/item/<id> or #/person/<id>
const detailRoutePattern = /^#\/(item|person)\/(\d+)$/;

const parseDetailRoute = (hash) => {
    const match = detailRoutePattern.exec(hash);
    return match ? { kind: match[1], id: Number(match[2]) } : null;
};

// How many detail pages deep this history entry is; 0 for the main page or a detail page opened directly
const historyDetailDepth = () => (history.state && history.state.detailDepth) || 0;
// Results table rows rendered at a time; more are added as the table is scrolled
const resultsBatchSize = 50;
// Names shown in each director, writer and cast cell of the results table before "+N more"
const resultsNameLimit = 5;
const defaultBillingDepth = 10;
const billingDepthStorageKey = 'mediadata.billingDepth';
// Key the Medialytics fork keeps the depth under; read as a fallback so an existing setting carries over
const legacyBillingDepthStorageKey = 'medialytics.castBillingDepth';
const selectedLibraryStorageKey = 'mediadata.libraryId';
const filtersOpenStorageKey = 'mediadata.filtersOpen';

// Ranked category cards. ids: the item field holding person ids (crew), so rows can carry a person.
// billed: only the first billingDepth entries of each title count toward the ranking.
const categoryDefinitions = {
    actor: { label: 'Actor', plural: 'Actors', field: 'actors', ids: 'actorIds', modes: ['table', 'bar'], mode: 'table', limit: 200, billed: true, filter: 'actor' },
    director: { label: 'Director', plural: 'Directors', field: 'directors', ids: 'directorIds', modes: ['table', 'bar'], mode: 'table', limit: 200, filter: 'director' },
    writer: { label: 'Writer', plural: 'Writers', field: 'writers', ids: 'writerIds', modes: ['table', 'bar'], mode: 'table', limit: 200, filter: 'writer' },
    genre: { label: 'Genre', plural: 'Genres', field: 'genres', modes: ['bar', 'pie', 'table'], mode: 'table', limit: 40, filter: 'genre' },
    country: { label: 'Country', plural: 'Countries', field: 'countries', modes: ['bar', 'pie', 'table'], mode: 'table', limit: 100 }
};
const categoryKeys = Object.keys(categoryDefinitions);

const yearRatingSources = {
    audience: { field: 'rating', label: 'Audience Rating' },
    critic: { field: 'criticRating', label: 'Critic Rating' }
};

const parsePositiveInt = (value) => {
    const number = parseInt(value);
    return number >= 1 ? number : null;
};

// Total running time of titles; a show counts every episode
const formatRuntime = (items) => {
    const totalMinutes = items.reduce((sum, item) => sum + ((item.durationMs || 0) / 60000) * (item.leafCount || 1), 0);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = Math.round(totalMinutes % 60);
    return `${days} Days, ${hours} Hours, ${minutes} Mins`;
};

const formatDate = (epochSeconds) => (epochSeconds ? new Date(epochSeconds * 1000).toLocaleDateString() : 'Unknown');

const timeAgo = (epochMs) => {
    if (!epochMs) return 'never';
    const minutes = Math.round((Date.now() - epochMs) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
};

const emptyFilters = (yearBounds, lengthBounds) => ({
    actors: [],     // AND: every selected actor must appear
    director: null,
    writer: null,
    genres: [],     // OR within genres
    studios: [],    // OR within studios
    yearRange: yearBounds.slice(),
    ratingRange: ratingBounds.slice(),
    criticRatingRange: ratingBounds.slice(),
    lengthRange: lengthBounds.slice(), // minutes; movie libraries only
    watched: 'all'
});

// Options for a typeahead: [{ name, count, total }] sorted by count.
// total counts every item using the value; count only the values rankedAccessor returns
// (e.g. top-billed actors), so every value stays selectable while rankings ignore minor credits.
const countOptions = (items, accessor, rankedAccessor = accessor) => {
    const totals = {};
    const counts = {};
    items.forEach(item => {
        accessor(item).forEach(name => {
            totals[name] = (totals[name] || 0) + 1;
        });
        rankedAccessor(item).forEach(name => {
            counts[name] = (counts[name] || 0) + 1;
        });
    });
    // Frozen so Vue doesn't make thousands of option objects reactive when they're passed as props
    return Object.freeze(Object.keys(totals)
        .map(name => Object.freeze({ name, count: counts[name] || 0, total: totals[name] }))
        .sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name)));
};

// Ranked rows for a category card: [{ key, label, personId?, total, watched, unwatched }], largest first
const rankCategory = (items, definition, billingDepth) => {
    const rows = new Map();
    items.forEach(item => {
        let names = item[definition.field];
        let keys = definition.ids ? item[definition.ids] : names;
        if (definition.billed) {
            names = names.slice(0, billingDepth);
            keys = keys.slice(0, billingDepth);
        }
        keys.forEach((key, index) => {
            let row = rows.get(key);
            if (!row) {
                row = { key, label: names[index], personId: definition.ids ? key : null, total: 0, watched: 0 };
                rows.set(key, row);
            }
            row.total++;
            if (item.watched) row.watched++;
        });
    });
    return [...rows.values()]
        .map(row => ({ ...row, unwatched: row.total - row.watched }))
        .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
};

const tallyRows = (groups) => groups.map(({ key, label, items }) => {
    const watched = items.filter(item => item.watched).length;
    return { key, label, total: items.length, watched, unwatched: items.length - watched };
});

// API response -> the frozen, normalized items the page works with
const buildItems = (response) => {
    const name = (id) => (response.people[id] ? response.people[id].name : 'Unknown');
    return Object.freeze(response.items.map(item => Object.freeze({
        id: item.id,
        title: item.title,
        titleSort: (item.titleSort || item.title || '').toLowerCase(),
        year: item.year,
        rating: item.rating,
        criticRating: item.criticRating,
        durationMs: item.durationMs,
        length: item.durationMs ? Math.round(item.durationMs / 60000) || null : null,
        childCount: item.childCount || 0,
        leafCount: item.leafCount || 0,
        viewedLeafCount: item.viewedLeafCount || 0,
        addedAt: item.addedAt,
        watched: item.watched,
        imdbId: item.imdbId,
        studio: item.studio || '',
        hasThumb: item.hasThumb,
        imageVersion: item.imageVersion,
        genres: item.genres,
        countries: item.countries,
        actorIds: item.actors,
        actors: item.actors.map(name),
        directorIds: item.directors,
        directors: item.directors.map(name),
        writerIds: item.writers,
        writers: item.writers.map(name)
    })));
};

const api = {
    // Revalidates with the ETag from the previous response; resolves to null when nothing changed
    etags: new Map(),
    async getJson(url, { revalidate = false } = {}) {
        const headers = {};
        if (revalidate && api.etags.has(url)) headers['If-None-Match'] = api.etags.get(url);
        const response = await fetch(url, { headers });
        if (response.status === 304) return null;
        if (!response.ok) throw new Error(`${url} returned ${response.status}`);
        if (response.headers.get('ETag')) api.etags.set(url, response.headers.get('ETag'));
        return response.json();
    },
    async post(url) {
        const response = await fetch(url, { method: 'POST' });
        if (!response.ok) throw new Error(`${url} returned ${response.status}`);
        return response.json();
    }
};

const loadBillingDepth = () =>
    parsePositiveInt(storage.get(billingDepthStorageKey)) || parsePositiveInt(storage.get(legacyBillingDepthStorageKey)) || defaultBillingDepth;

const app = new Vue({
    el: '#app',
    data: {
        version: '',
        libraries: [],
        librariesLoaded: false,
        selectedLibraryId: null,
        library: null,
        loadingItems: false,
        error: null,
        sync: null,
        // Normalized, frozen items for the selected library; replaced whenever the API returns new data
        items: Object.freeze([]),
        // Person id -> { name, hasThumb, imageVersion } from the same response, frozen for the same reason
        people: Object.freeze({}),
        chartModes: Object.fromEntries(categoryKeys.map(key => [key, categoryDefinitions[key].mode]).concat([['decade', 'bar']])),
        limitInputs: Object.fromEntries(categoryKeys.map(key => [key, categoryDefinitions[key].limit])),
        limits: Object.fromEntries(categoryKeys.map(key => [key, categoryDefinitions[key].limit])),
        billingDepth: loadBillingDepth(),
        decadeDrilldown: { active: false, decade: '', prefix: '' },
        yearRatingSource: 'audience',
        filters: emptyFilters([1900, new Date().getFullYear()], [0, 240]),
        tableSearch: '',
        sortField: 'title',
        sortDirection: 'asc',
        visibleResultCount: resultsBatchSize,
        detailRoute: parseDetailRoute(location.hash),
        detailDepth: historyDetailDepth(),
        detailTitle: '',
        filtersOpen: storage.get(filtersOpenStorageKey) !== 'false',
        categoryDefinitions,
        categoryKeys,
        nameLimit: resultsNameLimit
    },
    computed: {
        itemsById() {
            return new Map(this.items.map(item => [item.id, item]));
        },
        isMovieLibrary() {
            return !!this.library && this.library.type === 'movie';
        },
        itemNoun() {
            return this.isMovieLibrary ? 'Movies' : 'Shows';
        },
        syncSummary() {
            const sync = this.sync;
            if (!sync) return '';
            if (sync.state === 'running') {
                if (sync.step === 'credits' && sync.creditsTotal) {
                    return `Syncing ${sync.library || ''}: full credits ${sync.creditsFetched.toLocaleString()} / ${sync.creditsTotal.toLocaleString()}`;
                }
                if (sync.step === 'episodes' && sync.episodeListsTotal) {
                    return `Syncing ${sync.library || ''}: episode lists ${sync.episodeListsFetched.toLocaleString()} / ${sync.episodeListsTotal.toLocaleString()}`;
                }
                if (sync.step === 'episode-credits' && sync.episodeCreditsTotal) {
                    return `Syncing ${sync.library || ''}: episode credits ${sync.episodeCreditsFetched.toLocaleString()} / ${sync.episodeCreditsTotal.toLocaleString()}`;
                }
                return `Syncing ${sync.library || 'libraries'} from Plex…`;
            }
            if (sync.state === 'failed') return `Last sync failed: ${sync.error}`;
            return `Last synced ${timeAgo(sync.lastCompletedAt)}${sync.error ? ` (${sync.error})` : ''}`;
        },
        // Full rankings per category of the filtered titles; the cards show the first `limits[key]` rows
        categories() {
            return Object.fromEntries(categoryKeys.map(key => [key, rankCategory(this.filteredItems, categoryDefinitions[key], this.billingDepth)]));
        },
        categoryRows() {
            return Object.fromEntries(categoryKeys.map(key => [key, this.categories[key].slice(0, this.limits[key])
                .map(row => (row.personId
                    ? { ...row, image: this.personImageUrl(row.personId, 80) }
                    : row))]));
        },
        // Share-of-total column heading in the ranking tables
        shareLabel() {
            return this.activeFilterCount ? '% of Matches' : '% of Library';
        },
        // Decades oldest to newest, or the years of one decade while drilled in
        decadeRows() {
            const dated = this.filteredItems.filter(item => item.year);
            if (this.decadeDrilldown.active) {
                const prefix = this.decadeDrilldown.prefix;
                const years = [...new Set(dated.map(item => item.year))].filter(year => String(year).startsWith(prefix)).sort((a, b) => a - b);
                return tallyRows(years.map(year => ({ key: year, label: String(year), items: dated.filter(item => item.year === year) })));
            }
            const prefixes = [...new Set(dated.map(item => String(item.year).slice(0, 3)))].sort();
            return tallyRows(prefixes.map(prefix => ({
                key: prefix,
                label: `${prefix}0s`,
                items: dated.filter(item => String(item.year).startsWith(prefix))
            })));
        },
        additions() {
            const added = this.filteredItems.filter(item => item.addedAt).sort((a, b) => a.addedAt - b.addedAt);
            if (added.length === 0) return null;
            const perDay = {};
            added.forEach(item => {
                const day = new Date(item.addedAt * 1000).toISOString().slice(0, 10);
                perDay[day] = (perDay[day] || 0) + 1;
            });
            const dates = [];
            const daily = [];
            const cumulative = [];
            let running = 0;
            for (let day = new Date(added[0].addedAt * 1000); day <= new Date(); day.setUTCDate(day.getUTCDate() + 1)) {
                const key = day.toISOString().slice(0, 10);
                const count = perDay[key] || 0;
                running += count;
                dates.push(key);
                daily.push(count);
                cumulative.push(running);
            }
            const latest = added[added.length - 1];
            return { dates, daily, cumulative, latestTitle: latest.title, latestDate: latest.addedAt };
        },
        yearRatingStats() {
            const { field } = yearRatingSources[this.plottedRatingSource];
            const rated = this.filteredItems.filter(item => item[field] !== null && item.year);
            if (rated.length === 0) return { ratedCount: 0, averageRating: 'N/A', bestYear: 'N/A' };
            const byYear = {};
            rated.forEach(item => {
                byYear[item.year] = byYear[item.year] || { sum: 0, count: 0 };
                byYear[item.year].sum += item[field];
                byYear[item.year].count++;
            });
            let best = null;
            Object.keys(byYear).forEach(year => {
                const { sum, count } = byYear[year];
                if (count < 3) return;
                if (!best || sum / count > best.average) best = { year, average: sum / count, count };
            });
            return {
                ratedCount: rated.length,
                averageRating: (rated.reduce((sum, item) => sum + item[field], 0) / rated.length).toFixed(1),
                bestYear: best ? `${best.year} (${best.average.toFixed(1)} avg, ${best.count} rated)` : 'N/A'
            };
        },
        criticAudienceStats() {
            const rated = this.filteredItems.filter(item => item.criticRating !== null && item.rating !== null);
            if (rated.length === 0) return { count: 0, correlation: 'N/A', averageGap: 'N/A' };
            const n = rated.length;
            const meanCritic = rated.reduce((sum, item) => sum + item.criticRating, 0) / n;
            const meanAudience = rated.reduce((sum, item) => sum + item.rating, 0) / n;
            let covariance = 0, varianceCritic = 0, varianceAudience = 0;
            rated.forEach(item => {
                const dc = item.criticRating - meanCritic;
                const da = item.rating - meanAudience;
                covariance += dc * da;
                varianceCritic += dc * dc;
                varianceAudience += da * da;
            });
            const denominator = Math.sqrt(varianceCritic * varianceAudience);
            const gap = meanAudience - meanCritic;
            return {
                count: n,
                correlation: denominator ? (covariance / denominator).toFixed(2) : 'N/A',
                averageGap: `${gap >= 0 ? '+' : ''}${gap.toFixed(1)} (audience ${gap >= 0 ? 'higher' : 'lower'})`
            };
        },
        yearBounds() {
            const years = this.items.map(item => item.year).filter(Boolean);
            return years.length ? [Math.min(...years), Math.max(...years)] : [1900, new Date().getFullYear()];
        },
        lengthBounds() {
            const lengths = this.items.map(item => item.length).filter(Boolean);
            if (lengths.length === 0) return [0, 240];
            return [
                Math.floor(Math.min(...lengths) / lengthStepMinutes) * lengthStepMinutes,
                Math.ceil(Math.max(...lengths) / lengthStepMinutes) * lengthStepMinutes
            ];
        },
        filterOptions() {
            const items = this.items;
            return {
                actors: countOptions(items, item => item.actors, item => item.actors.slice(0, this.billingDepth)),
                directors: countOptions(items, item => item.directors),
                writers: countOptions(items, item => item.writers),
                genres: countOptions(items, item => item.genres),
                studios: countOptions(items, item => (item.studio ? [item.studio] : []))
            };
        },
        yearFilterActive() {
            const [low, high] = this.filters.yearRange;
            return low > this.yearBounds[0] || high < this.yearBounds[1];
        },
        ratingFilterActive() {
            const [low, high] = this.filters.ratingRange;
            return low > ratingBounds[0] || high < ratingBounds[1];
        },
        // Plex has no critic ratings for TV shows
        hasCriticRatings() {
            return this.isMovieLibrary;
        },
        // The year chart's rating, which is always audience where there are no critic ratings
        plottedRatingSource() {
            return this.hasCriticRatings ? this.yearRatingSource : 'audience';
        },
        criticRatingFilterActive() {
            if (!this.hasCriticRatings) return false;
            const [low, high] = this.filters.criticRatingRange;
            return low > ratingBounds[0] || high < ratingBounds[1];
        },
        lengthFilterActive() {
            if (!this.isMovieLibrary) return false;
            const [low, high] = this.filters.lengthRange;
            return low > this.lengthBounds[0] || high < this.lengthBounds[1];
        },
        // Each selected actor, genre and studio counts on its own, as does each range or choice that is set
        activeFilterCount() {
            const f = this.filters;
            return f.actors.length + f.genres.length + f.studios.length + [
                !!f.director, !!f.writer,
                this.yearFilterActive, this.ratingFilterActive, this.criticRatingFilterActive,
                this.lengthFilterActive, f.watched !== 'all'
            ].filter(Boolean).length;
        },
        // Each filter that is set must match (AND). Actors must all match; genres and studios match any selection.
        filteredItems() {
            const f = this.filters;
            const actorNames = f.actors.map(option => option.name);
            const genreNames = f.genres.map(option => option.name);
            const studioNames = f.studios.map(option => option.name);
            const [yearLow, yearHigh] = f.yearRange;
            const [ratingLow, ratingHigh] = f.ratingRange;
            const [criticLow, criticHigh] = f.criticRatingRange;
            const [lengthLow, lengthHigh] = f.lengthRange;
            const yearActive = this.yearFilterActive;
            const ratingActive = this.ratingFilterActive;
            const criticActive = this.criticRatingFilterActive;
            const lengthActive = this.lengthFilterActive;

            return this.items.filter(item => {
                if (actorNames.length && !actorNames.every(name => item.actors.includes(name))) return false;
                if (f.director && !item.directors.includes(f.director.name)) return false;
                if (f.writer && !item.writers.includes(f.writer.name)) return false;
                if (genreNames.length && !genreNames.some(name => item.genres.includes(name))) return false;
                if (studioNames.length && !studioNames.includes(item.studio)) return false;
                if (yearActive && (item.year === null || item.year < yearLow || item.year > yearHigh)) return false;
                if (ratingActive && (item.rating === null || item.rating < ratingLow || item.rating > ratingHigh)) return false;
                if (criticActive && (item.criticRating === null || item.criticRating < criticLow || item.criticRating > criticHigh)) return false;
                if (lengthActive && (item.length === null || item.length < lengthLow || item.length > lengthHigh)) return false;
                if (f.watched === 'watched' && !item.watched) return false;
                if (f.watched === 'unwatched' && item.watched) return false;
                return true;
            });
        },
        // Summary of the filtered titles shown under the filters
        resultStats() {
            const items = this.filteredItems;
            const average = (field) => {
                const rated = items.filter(item => item[field] !== null);
                return rated.length ? (rated.reduce((sum, item) => sum + item[field], 0) / rated.length).toFixed(1) : '–';
            };
            const watched = items.filter(item => item.watched).length;
            return {
                watched,
                total: items.length,
                watchedPercent: items.length ? Math.round((watched / items.length) * 100) : 0,
                averageCritic: average('criticRating'),
                averageAudience: average('rating'),
                runtime: formatRuntime(items)
            };
        },
        searchedItems() {
            const term = this.tableSearch.trim().toLowerCase();
            if (!term) return this.filteredItems;
            return this.filteredItems.filter(item =>
                item.title.toLowerCase().includes(term) ||
                String(item.year || '').includes(term) ||
                item.studio.toLowerCase().includes(term) ||
                [item.actors, item.directors, item.writers, item.genres].some(names =>
                    names.some(name => name.toLowerCase().includes(term))));
        },
        sortedItems() {
            const field = this.sortField;
            const direction = this.sortDirection === 'asc' ? 1 : -1;
            const sortValue = (item) => {
                switch (field) {
                    case 'title': return item.titleSort;
                    case 'director': return (item.directors[0] || '').toLowerCase();
                    case 'studio': return item.studio.toLowerCase();
                    // Shows sort by the share of episodes watched, then by how many
                    case 'watched': return this.isMovieLibrary ? (item.watched ? 1 : 0) : (item.leafCount ? item.viewedLeafCount / item.leafCount : 0) + item.viewedLeafCount / 1e9;
                    default: return item[field];
                }
            };
            return [...this.searchedItems].sort((a, b) => {
                const aVal = sortValue(a);
                const bVal = sortValue(b);
                // Missing values always sort last
                if (aVal === null && bVal === null) return 0;
                if (aVal === null) return 1;
                if (bVal === null) return -1;
                if (typeof aVal === 'string') return aVal.localeCompare(bVal, undefined, { numeric: true }) * direction;
                return (aVal - bVal) * direction;
            });
        },
        visibleItems() {
            return this.sortedItems.slice(0, this.visibleResultCount);
        },
        selectedActorNames() {
            return this.filters.actors.map(option => option.name);
        },
        selectedDirectorNames() {
            return this.filters.director ? [this.filters.director.name] : [];
        },
        selectedWriterNames() {
            return this.filters.writer ? [this.filters.writer.name] : [];
        }
    },
    watch: {
        detailRoute(route) {
            document.body.classList.toggle('detail-open', !!route);
            if (!route) {
                this.detailTitle = '';
                document.title = 'MediaData';
            }
            this.$nextTick(() => {
                if (this.$refs.detailOverlay) this.$refs.detailOverlay.scrollTop = 0;
            });
        },
        detailTitle(title) {
            if (title) document.title = `${title} · MediaData`;
        },
        // Re-render whichever cards are showing a chart rather than a table
        categoryRows() {
            this.$nextTick(() => this.renderCategoryCharts());
        },
        chartModes: {
            deep: true,
            handler() {
                this.$nextTick(() => {
                    this.renderCategoryCharts();
                    this.renderDecadeChart();
                });
            }
        },
        decadeRows() {
            this.$nextTick(() => this.renderDecadeChart());
        },
        items() {
            this.$nextTick(() => this.renderLibraryCharts());
        },
        // Ranking and decade charts follow their own rows; the scatter and additions charts are redrawn here,
        // after the filters settle, since a dragged slider changes them many times a second
        filteredItems() {
            clearTimeout(this.chartTimer);
            this.chartTimer = setTimeout(() => this.renderFilteredCharts(), 150);
        },
        yearRatingSource() {
            this.renderYearRatingChart();
        },
        // Debounced so typing a multi-digit number re-renders once; Enter or Tab applies immediately via @change
        limitInputs: {
            deep: true,
            handler() {
                clearTimeout(this.limitTimer);
                this.limitTimer = setTimeout(() => categoryKeys.forEach(key => this.applyLimit(key)), 400);
            }
        },
        // A new filter, search or sort starts the results from the top
        sortedItems() {
            this.visibleResultCount = resultsBatchSize;
            closePopup();
            if (this.$refs.resultsScroller) this.$refs.resultsScroller.scrollTop = 0;
        }
    },
    mounted() {
        this.loadLibraries();
        this.pollSync();
        popupActions.details = spec => this.openDetail({ kind: spec.kind, id: spec.id });
        popupActions.filter = spec => this.filterFromPopup(spec.filter);
        popupActions.canFilter = spec => this.canFilterBy(spec.filter);
        window.addEventListener('popstate', () => {
            this.detailRoute = parseDetailRoute(location.hash);
            this.detailDepth = historyDetailDepth();
        });
        window.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.detailRoute) this.closeDetail();
        });
        if (this.detailRoute) document.body.classList.add('detail-open');
    },
    methods: {
        async loadLibraries() {
            try {
                const response = await api.getJson('/api/libraries');
                this.version = response.version;
                this.libraries = response.libraries;
                this.sync = response.sync;
                this.librariesLoaded = true;
                this.error = null;
                if (!this.selectedLibraryId && this.libraries.length) {
                    const remembered = Number(storage.get(selectedLibraryStorageKey));
                    const initial = this.libraries.find(library => library.id === remembered) || this.libraries[0];
                    if (initial) this.selectLibrary(initial.id);
                }
            } catch (error) {
                this.error = `Could not reach the MediaData server: ${error.message}`;
            }
        },
        selectLibrary(libraryId) {
            if (libraryId === this.selectedLibraryId) return;
            this.selectedLibraryId = libraryId;
            storage.set(selectedLibraryStorageKey, libraryId);
            this.items = Object.freeze([]);
            this.people = Object.freeze({});
            this.decadeDrilldown = { active: false, decade: '', prefix: '' };
            this.loadItems({ reset: true });
        },
        // reset: a newly selected library, so filters start fresh; otherwise keep filters across a data refresh
        async loadItems({ reset = false } = {}) {
            const libraryId = this.selectedLibraryId;
            if (!libraryId) return;
            if (reset) this.loadingItems = true;
            try {
                const response = await api.getJson(`/api/libraries/${libraryId}/items`, { revalidate: !reset });
                if (libraryId !== this.selectedLibraryId) return;
                if (response) {
                    const previousYearBounds = this.yearBounds;
                    const previousLengthBounds = this.lengthBounds;
                    this.library = response.library;
                    this.sync = response.sync;
                    this.people = Object.freeze(response.people);
                    this.items = buildItems(response);
                    if (reset) {
                        this.resetFilters();
                    } else {
                        this.widenRangesAtBounds(previousYearBounds, previousLengthBounds);
                    }
                }
                this.error = null;
            } catch (error) {
                this.error = `Could not load the library: ${error.message}`;
            } finally {
                if (libraryId === this.selectedLibraryId) this.loadingItems = false;
            }
        },
        // A range left at the old full extent follows the new extent when data changes
        widenRangesAtBounds(previousYearBounds, previousLengthBounds) {
            const follow = (range, previous, next) => {
                if (range[0] === previous[0] && range[1] === previous[1]) return next.slice();
                return [Math.max(range[0], next[0]), Math.min(range[1], next[1])];
            };
            this.filters.yearRange = follow(this.filters.yearRange, previousYearBounds, this.yearBounds);
            this.filters.lengthRange = follow(this.filters.lengthRange, previousLengthBounds, this.lengthBounds);
        },
        // Polls sync progress: often while a sync runs, occasionally otherwise. Reloads data a sync changed.
        async pollSync() {
            clearTimeout(this.syncTimer);
            try {
                const previous = this.sync;
                const status = await api.getJson('/api/sync/status');
                this.sync = status;
                const finished = !previous || status.lastCompletedAt !== previous.lastCompletedAt;
                const progressed = status.state === 'running' && Date.now() - (this.lastProgressReload || 0) > 10000;
                if (finished || progressed || !this.libraries.length) {
                    this.lastProgressReload = Date.now();
                    await this.loadLibraries();
                    await this.loadItems();
                }
            } catch (error) {
                // The next poll retries; loadLibraries reports a persistent outage
            }
            this.syncTimer = setTimeout(() => this.pollSync(), this.sync && this.sync.state === 'running' ? 2000 : 30000);
        },
        async refreshNow() {
            try {
                this.sync = (await api.post('/api/sync')).status;
            } catch (error) {
                this.error = `Could not start a sync: ${error.message}`;
            }
            this.pollSync();
        },
        applyLimit(key) {
            const limit = parsePositiveInt(this.limitInputs[key]);
            if (limit && limit !== this.limits[key]) this.limits[key] = limit;
        },
        // The depth box is bound to billingDepth itself, so whenever the page re-renders and the box isn't
        // focused it shows the depth actually applied. Typing is debounced; Enter or Tab applies immediately.
        onBillingDepthInput(value, immediate) {
            clearTimeout(this.billingDepthTimer);
            const apply = () => {
                const depth = parsePositiveInt(value);
                if (!depth || depth === this.billingDepth) return;
                this.billingDepth = depth;
                storage.set(billingDepthStorageKey, depth);
            };
            if (immediate) apply();
            else this.billingDepthTimer = setTimeout(apply, 250);
        },
        categoryTitle(key) {
            const definition = categoryDefinitions[key];
            return `${this.itemNoun} per ${definition.label} (Top ${this.limits[key]})`;
        },
        renderCategoryCharts() {
            categoryKeys.forEach(key => {
                const elementId = `items-by-${key}`;
                if (!document.getElementById(elementId)) return;
                const mode = this.chartModes[key];
                if (mode === 'table') return clearChart(elementId);
                const rows = this.categoryRows[key];
                if (mode === 'pie') renderPieChart(elementId, rows);
                else renderStackedBarChart(elementId, rows);
            });
        },
        renderDecadeChart() {
            const elementId = 'items-by-decade';
            const element = document.getElementById(elementId);
            if (!element) return;
            const mode = this.chartModes.decade;
            if (mode === 'table') return clearChart(elementId);
            const rendering = mode === 'pie'
                ? renderPieChart(elementId, this.decadeRows)
                : renderStackedBarChart(elementId, this.decadeRows, { shortLabels: true });
            rendering.then(() => {
                if (element.removeAllListeners) element.removeAllListeners('plotly_click');
                element.on('plotly_click', event => this.onDecadeChartClick(event));
            });
        },
        onDecadeChartClick(event) {
            const point = event && event.points && event.points[0];
            if (!point) return;
            // Bars carry the decade or year as x, pie slices as label
            const row = this.decadeRows.find(candidate => candidate.label === String(point.x ?? point.label));
            if (row) this.showDecadeMenu(row, event.event);
        },
        onDecadeRowClick(row, mouseEvent) {
            this.showDecadeMenu(row, mouseEvent);
        },
        // A decade offers its years or a filter to it; a year offers a filter to it or a return to the decades
        showDecadeMenu(row, mouseEvent) {
            const drilled = this.decadeDrilldown.active;
            const range = drilled ? [Number(row.key), Number(row.key)] : [Number(`${row.key}0`), Number(`${row.key}9`)];
            const filter = { label: 'Filter', run: () => this.filterToYears(range) };
            showActionMenu(mouseEvent, {
                title: row.label,
                actions: drilled
                    ? [filter, { label: 'Back', run: () => this.exitDecadeDrilldown() }]
                    : [{ label: 'By year', run: () => this.enterDecadeDrilldown(row) }, filter]
            });
        },
        // Sets the year filter to [first, last], within the library's years
        filterToYears([first, last]) {
            const [low, high] = this.yearBounds;
            this.filters.yearRange = [Math.max(low, Math.min(first, high)), Math.min(high, Math.max(last, low))];
            this.setFiltersOpen(true);
        },
        enterDecadeDrilldown(row) {
            this.decadeDrilldown = { active: true, decade: row.label, prefix: row.key };
        },
        exitDecadeDrilldown() {
            this.decadeDrilldown = { active: false, decade: '', prefix: '' };
        },
        renderLibraryCharts() {
            this.renderCategoryCharts();
            this.renderDecadeChart();
            this.renderFilteredCharts();
        },
        renderFilteredCharts() {
            this.renderYearRatingChart();
            this.renderCriticAudienceChart();
            if (this.additions && document.getElementById('items-added-over-time')) {
                renderAdditionsChart('items-added-over-time', this.additions);
            }
        },
        yearRatingLabel() {
            return yearRatingSources[this.plottedRatingSource].label;
        },
        renderYearRatingChart() {
            if (!document.getElementById('items-by-year-rating')) return;
            const { field, label } = yearRatingSources[this.plottedRatingSource];
            const points = this.filteredItems.filter(item => item[field] !== null && item.year).map(item => ({
                // Small horizontal jitter keeps titles from the same year from stacking into one column
                x: item.year + (Math.random() - 0.5) * 0.6,
                y: item[field],
                text: `${item.title} (${item.year})<br />${label}: ${item[field].toFixed(1)}`,
                watched: item.watched,
                id: item.id
            }));
            renderWatchedScatter('items-by-year-rating', points, {
                xTitle: 'Release Year', yTitle: label, yRange: [0, 10.5], onPointClick: this.pinChartPoint
            });
        },
        renderCriticAudienceChart() {
            if (!document.getElementById('items-by-critic-audience')) return;
            const points = this.filteredItems.filter(item => item.criticRating !== null && item.rating !== null).map(item => ({
                x: item.criticRating,
                y: item.rating,
                text: `${item.title}${item.year ? ` (${item.year})` : ''}<br />Critic: ${item.criticRating.toFixed(1)}<br />Audience: ${item.rating.toFixed(1)}`,
                watched: item.watched,
                id: item.id
            }));
            // Dotted diagonal: points above it are rated higher by audiences than critics
            const agreementLine = { x: ratingBounds, y: ratingBounds, mode: 'lines', type: 'scatter', hoverinfo: 'skip', line: { color: chartPalette.grid, dash: 'dot', width: 1 } };
            renderWatchedScatter('items-by-critic-audience', points, {
                xTitle: 'Critic Rating', yTitle: 'Audience Rating', xRange: [0, 10.5], yRange: [0, 10.5], extraTraces: [agreementLine],
                onPointClick: this.pinChartPoint
            });
        },
        // A clicked chart point pins its title's popup, with the point's hover text below the title
        pinChartPoint(points, mouseEvent) {
            const item = this.itemsById.get(points[0].id);
            if (!item) return;
            const lines = String(points[0].text || '').split(/<br\s*\/?>/i);
            const spec = { ...this.itemPopup(item), lines };
            pinPopupAt(mouseEvent ? mouseEvent.clientX : window.innerWidth / 2, mouseEvent ? mouseEvent.clientY : window.innerHeight / 2, spec);
        },
        posterUrl(item, width) {
            return item.hasThumb ? posterImageUrl(item.id, item.imageVersion, width) : null;
        },
        personImageUrl(personId, width) {
            const person = this.people[personId];
            return person && person.hasThumb ? personImageUrl(personId, person.imageVersion, width) : null;
        },
        hideBrokenImage,
        imdbUrl(item) {
            return imdbTitleUrl(item.imdbId);
        },
        formatLength,
        formatDate,
        ratingClass,
        formatRating,
        episodesWatchedClass,
        formatEpisodesWatched,
        resetFilters() {
            this.filters = emptyFilters(this.yearBounds, this.lengthBounds);
            this.tableSearch = '';
        },
        optionLabel(option) {
            if (option.total !== undefined && option.total !== option.count) {
                return `${option.name} (${option.count} of ${option.total})`;
            }
            return `${option.name} (${option.count})`;
        },
        // Adds a value to the matching filter, e.g. from clicking a name in a table
        addFilter(field, name) {
            const options = {
                actor: this.filterOptions.actors,
                director: this.filterOptions.directors,
                writer: this.filterOptions.writers,
                genre: this.filterOptions.genres,
                studio: this.filterOptions.studios
            }[field];
            const option = options && options.find(candidate => candidate.name === name);
            if (!option) return;
            const f = this.filters;
            const addTo = (list) => {
                if (!list.some(selected => selected.name === name)) list.push(option);
            };
            if (field === 'actor') addTo(f.actors);
            if (field === 'genre') addTo(f.genres);
            if (field === 'studio') addTo(f.studios);
            if (field === 'director') f.director = option;
            if (field === 'writer') f.writer = option;
        },
        // Category table rows add a filter and show the filters, since every section changes
        filterFromCategoryRow(key, row) {
            const field = categoryDefinitions[key].filter;
            if (!field) return;
            this.addFilter(field, row.label);
            this.setFiltersOpen(true);
        },
        toggleFilters() {
            this.setFiltersOpen(!this.filtersOpen);
        },
        setFiltersOpen(open) {
            if (open === this.filtersOpen) return;
            this.filtersOpen = open;
            storage.set(filtersOpenStorageKey, open);
            // The sections change width with the sidebar; responsive charts redraw on a window resize
            this.$nextTick(() => window.dispatchEvent(new Event('resize')));
        },
        sortTable(field) {
            if (this.sortField === field) {
                this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                this.sortField = field;
                this.sortDirection = ['rating', 'criticRating', 'year', 'length', 'watched'].includes(field) ? 'desc' : 'asc';
            }
        },
        sortClass(field) {
            if (this.sortField !== field) return '';
            return this.sortDirection === 'asc' ? 'sort-asc' : 'sort-desc';
        },
        // Renders another batch of rows once the results table is scrolled near its last rendered row
        onResultsScroll(event) {
            const scroller = event.target;
            if (this.visibleResultCount < this.sortedItems.length &&
                scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 600) {
                this.visibleResultCount += resultsBatchSize;
            }
        },
        showPopup,
        hidePopup,
        pinPopup,
        itemPopup(item) {
            return { kind: 'item', id: item.id, image: this.posterUrl(item, 320), lines: [titleWithYear(item.title, item.year)] };
        },
        // A person named in an item's directors, writers or actors
        personPopup(item, field, name) {
            const personId = this.personIdInItem(item, field, name);
            if (!personId) return null;
            const filterField = { actors: 'actor', directors: 'director', writers: 'writer' }[field];
            return { kind: 'person', id: personId, image: this.personImageUrl(personId, 320), lines: [name], filter: { field: filterField, name } };
        },
        rankingPopupFor(key) {
            return row => this.rankingPopup(key, row);
        },
        // A person's row in the actor, director or writer rankings
        rankingPopup(key, row) {
            const field = categoryDefinitions[key].filter;
            return {
                kind: 'person', id: row.personId, image: this.personImageUrl(row.personId, 320), lines: [row.label],
                filter: field ? { field, name: row.label } : null
            };
        },
        // Whether the current library has the value to filter by; detail pages can show people from other libraries
        canFilterBy(filter) {
            if (!filter) return false;
            const options = { actor: this.filterOptions.actors, director: this.filterOptions.directors, writer: this.filterOptions.writers }[filter.field];
            return !!options && options.some(option => option.name === filter.name);
        },
        // The popup's Filter link: adds the filter, leaves any detail page, and shows the filters
        filterFromPopup(filter) {
            this.addFilter(filter.field, filter.name);
            if (this.detailRoute) this.closeDetail();
            this.setFiltersOpen(true);
        },
        collapseAllSections() {
            sections.collapseAll();
        },
        expandAllSections() {
            sections.expandAll();
        },
        // The id of a person named in an item's directors, writers or actors, by position in that list
        personIdInItem(item, field, name) {
            const ids = { actors: item.actorIds, directors: item.directorIds, writers: item.writerIds }[field];
            return (ids && ids[item[field].indexOf(name)]) || null;
        },
        // Each detail page gets a history entry, so the browser's Back button steps back through them
        openDetail({ kind, id }) {
            closePopup();
            const depth = historyDetailDepth() + 1;
            history.pushState({ detailDepth: depth }, '', detailHref(kind, id));
            this.detailDepth = depth;
            this.detailRoute = { kind, id };
        },
        detailBack() {
            history.back();
        },
        // Returns to the main page, unwinding the detail pages opened from it
        closeDetail() {
            const depth = historyDetailDepth();
            if (depth > 0) {
                history.go(-depth);
            } else {
                history.replaceState(null, '', location.pathname + location.search);
                this.detailRoute = null;
                this.detailDepth = 0;
            }
        },
        // Names a filter selects first, then the rest in credit order, capped for display
        displayNames(names, selectedNames, limit) {
            const selected = names.filter(name => selectedNames.includes(name));
            const others = names.filter(name => !selectedNames.includes(name));
            return selected.concat(others).slice(0, Math.max(limit, selected.length));
        }
    }
});
