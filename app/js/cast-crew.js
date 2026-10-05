// Cast & Crew page: sections layered onto the shared Medialytics app (js/scripts.js) as a Vue mixin.
// Loaded before scripts.js; the page passes castCrewMixin through window.medialyticsPageConfig.

const castCrewColors = {
    watched: '#D62828',
    unwatched: '#FC9803'
};

const emptyYearRatingStats = () => ({
    ratedCount: 0,
    averageRating: 'N/A',
    bestYear: 'N/A'
});

// Third-party components from the CDN scripts in index.html
if (window.VueMultiselect) {
    Vue.component('multiselect', window.VueMultiselect.default || window.VueMultiselect.Multiselect);
}
if (window['vue-slider-component']) {
    Vue.component('vue-slider', window['vue-slider-component']);
}

// Plex's library listing truncates tag lists (3 actors, 2 directors/genres...), so full credits are
// fetched per item from /library/metadata, which accepts a comma-separated list of ratingKeys.
const creditsBatchSize = 50;
const creditsConcurrency = 3;
const creditFields = ['Role', 'Director', 'Writer', 'Genre', 'Country'];

// Full credits by ratingKey: { Role: [names], Director: [names], ... }. Kept outside Vue's reactivity:
// a library's full cast lists run to hundreds of thousands of entries, and tracking each one as a
// dependency makes every re-render crawl.
let castCreditStore = new Map();

// Category cards recounted from full credits: stats key, plural used by scripts.js, castItems field, renderer.
// billed: only the first castBillingDepth entries (Plex lists cast in billing order) count toward rankings.
const creditCategories = [
    { key: 'actor', plural: 'actors', field: 'actors', render: 'renderActorChart', billed: true },
    { key: 'director', plural: 'directors', field: 'directors', render: 'renderDirectorChart' },
    { key: 'writer', plural: 'writers', field: 'writers', render: 'renderWriterChart' },
    { key: 'genre', plural: 'genres', field: 'genres', render: 'renderGenreChart' },
    { key: 'country', plural: 'countries', field: 'countries', render: 'renderCountryChart' }
];

const tagNames = (list) => Array.isArray(list) ? [...new Set(list.map(tag => tag.tag).filter(Boolean))] : [];

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// How many top-billed actors per title count toward actor rankings; remembered per browser
const billingDepthStorageKey = 'medialytics.castBillingDepth';
const defaultBillingDepth = 10;
const parseBillingDepth = (value) => {
    const depth = parseInt(value);
    return depth >= 1 ? depth : null;
};
const loadBillingDepth = () => {
    try {
        return parseBillingDepth(localStorage.getItem(billingDepthStorageKey)) || defaultBillingDepth;
    } catch (error) {
        return defaultBillingDepth;
    }
};
const saveBillingDepth = (depth) => {
    try {
        localStorage.setItem(billingDepthStorageKey, String(depth));
    } catch (error) {
        // Storage can be unavailable (e.g. private browsing); the setting just won't persist
    }
};

const ratingBounds = [0, 10];

// Cards on this page whose "Top N" limit box applies as you type
const castLimitCategories = ['actor', 'director', 'writer', 'genre', 'country'];

const emptyCastFilters = (yearBounds) => ({
    actors: [],     // AND: every selected actor must appear
    director: null,
    writer: null,
    genres: [],     // OR within genres
    studios: [],    // OR within studios
    yearRange: yearBounds.slice(),
    ratingRange: ratingBounds.slice(),
    criticRatingRange: ratingBounds.slice(),
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
        .map(name => Object.freeze({ name: name, count: counts[name] || 0, total: totals[name] }))
        .sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name)));
};

const castCrewMixin = {
    data: function() {
        return {
            yearRatingStats: emptyYearRatingStats(),
            creditsStatus: { state: 'idle', loaded: 0, total: 0 },
            creditsLoadToken: 0,
            castFilters: emptyCastFilters([1900, new Date().getFullYear()]),
            castTableSearch: '',
            castSortField: 'title',
            castSortDirection: 'asc',
            castCurrentPage: 1,
            castItemsPerPage: 25,
            // Normalized, frozen view of the library used by the filters, results and recounts;
            // rebuilt by rebuildCastItems when the library or its credits change
            castItems: Object.freeze([]),
            castLimitInputs: Object.fromEntries(castLimitCategories.map(category => [category, configuredLimit(category)])),
            castBillingDepth: loadBillingDepth(),
            castBillingDepthInput: loadBillingDepth()
        };
    },
    computed: {
        castYearBounds: function() {
            const years = this.castItems.map(item => item.year).filter(Boolean);
            if (years.length === 0) {
                return [1900, new Date().getFullYear()];
            }
            return [Math.min(...years), Math.max(...years)];
        },
        castFilterOptions: function() {
            const items = this.castItems;
            return {
                actors: countOptions(items, item => item.actors, item => item.actors.slice(0, this.castBillingDepth)),
                directors: countOptions(items, item => item.directors),
                writers: countOptions(items, item => item.writers),
                genres: countOptions(items, item => item.genres),
                studios: countOptions(items, item => item.studio ? [item.studio] : [])
            };
        },
        castYearFilterActive: function() {
            const [low, high] = this.castFilters.yearRange;
            return low > this.castYearBounds[0] || high < this.castYearBounds[1];
        },
        castRatingFilterActive: function() {
            const [low, high] = this.castFilters.ratingRange;
            return low > ratingBounds[0] || high < ratingBounds[1];
        },
        castCriticRatingFilterActive: function() {
            const [low, high] = this.castFilters.criticRatingRange;
            return low > ratingBounds[0] || high < ratingBounds[1];
        },
        castActiveFilterCount: function() {
            const f = this.castFilters;
            return [
                f.actors.length > 0, !!f.director, !!f.writer, f.genres.length > 0, f.studios.length > 0,
                this.castYearFilterActive, this.castRatingFilterActive, this.castCriticRatingFilterActive,
                f.watched !== 'all'
            ].filter(Boolean).length;
        },
        // Each filter that is set must match (AND). Actors must all match; genres and studios match any selection.
        castFilteredItems: function() {
            const f = this.castFilters;
            const actorNames = f.actors.map(option => option.name);
            const genreNames = f.genres.map(option => option.name);
            const studioNames = f.studios.map(option => option.name);
            const [yearLow, yearHigh] = f.yearRange;
            const [ratingLow, ratingHigh] = f.ratingRange;
            const [criticLow, criticHigh] = f.criticRatingRange;
            const yearActive = this.castYearFilterActive;
            const ratingActive = this.castRatingFilterActive;
            const criticActive = this.castCriticRatingFilterActive;

            return this.castItems.filter(item => {
                if (actorNames.length && !actorNames.every(name => item.actors.includes(name))) return false;
                if (f.director && !item.directors.includes(f.director.name)) return false;
                if (f.writer && !item.writers.includes(f.writer.name)) return false;
                if (genreNames.length && !genreNames.some(name => item.genres.includes(name))) return false;
                if (studioNames.length && !studioNames.includes(item.studio)) return false;
                if (yearActive && (item.year === null || item.year < yearLow || item.year > yearHigh)) return false;
                if (ratingActive && (item.rating === null || item.rating < ratingLow || item.rating > ratingHigh)) return false;
                if (criticActive && (item.criticRating === null || item.criticRating < criticLow || item.criticRating > criticHigh)) return false;
                if (f.watched === 'watched' && !item.watched) return false;
                if (f.watched === 'unwatched' && item.watched) return false;
                return true;
            });
        },
        castSearchedItems: function() {
            const term = this.castTableSearch.trim().toLowerCase();
            if (!term) {
                return this.castFilteredItems;
            }
            return this.castFilteredItems.filter(item =>
                item.title.toLowerCase().includes(term) ||
                String(item.year || '').includes(term) ||
                item.studio.toLowerCase().includes(term) ||
                [item.actors, item.directors, item.writers, item.genres].some(names =>
                    names.some(name => name.toLowerCase().includes(term))));
        },
        castSortedItems: function() {
            const field = this.castSortField;
            const direction = this.castSortDirection === 'asc' ? 1 : -1;
            const sortValue = (item) => {
                switch (field) {
                    case 'title': return item.titleSort;
                    case 'director': return (item.directors[0] || '').toLowerCase();
                    case 'studio': return item.studio.toLowerCase();
                    case 'watched': return item.watched ? 1 : 0;
                    default: return item[field];
                }
            };
            return [...this.castSearchedItems].sort((a, b) => {
                const aVal = sortValue(a);
                const bVal = sortValue(b);
                // Missing values always sort last
                if (aVal === null && bVal === null) return 0;
                if (aVal === null) return 1;
                if (bVal === null) return -1;
                if (typeof aVal === 'string') {
                    return aVal.localeCompare(bVal, undefined, { numeric: true }) * direction;
                }
                return (aVal - bVal) * direction;
            });
        },
        castTotalPages: function() {
            return Math.max(1, Math.ceil(this.castSortedItems.length / this.castItemsPerPage));
        },
        castPaginatedItems: function() {
            const start = (this.castCurrentPage - 1) * this.castItemsPerPage;
            return this.castSortedItems.slice(start, start + this.castItemsPerPage);
        },
        castSelectedActorNames: function() {
            return this.castFilters.actors.map(option => option.name);
        }
    },
    watch: {
        // selectedLibraryStats is replaced once a library has been fully parsed
        selectedLibraryStats: function(stats) {
            // Carry the limits typed on this page over to the newly loaded library
            castLimitCategories.forEach(category => {
                const limit = parseInt(this.castLimitInputs[category]);
                if (limit >= 1 && stats) stats[`${category}Limit`] = limit;
            });
            castCreditStore = new Map();
            this.rebuildCastItems();
            this.resetCastFilters();
            this.$nextTick(() => {
                this.renderYearRatingChart();
                // The listing's actors are already in billing order, so apply the depth before full credits arrive
                this.recountCreditCategory(creditCategories[0]);
                this.loadFullCredits();
            });
        },
        // Debounced so typing a multi-digit number re-renders once; Enter or Tab applies immediately via @change
        castLimitInputs: {
            deep: true,
            handler: function() {
                clearTimeout(this.castLimitTimer);
                this.castLimitTimer = setTimeout(() => {
                    castLimitCategories.forEach(category => this.applyCastLimit(category));
                }, 400);
            }
        },
        // Debounced so typing a multi-digit number recounts once
        castBillingDepthInput: function(value) {
            clearTimeout(this.billingDepthTimer);
            this.billingDepthTimer = setTimeout(() => {
                const depth = parseBillingDepth(value);
                if (!depth || depth === this.castBillingDepth) return;
                this.castBillingDepth = depth;
                saveBillingDepth(depth);
                this.recountCreditCategory(creditCategories[0]);
            }, 250);
        },
        castFilteredItems: function() {
            this.castCurrentPage = 1;
        },
        castTableSearch: function() {
            this.castCurrentPage = 1;
        }
    },
    methods: {
        rebuildCastItems: function() {
            const names = (item, field) => castCreditStore.has(item.ratingKey)
                ? castCreditStore.get(item.ratingKey)[field]
                : tagNames(item[field]);
            this.castItems = Object.freeze((this.libraryItems || []).map(item => Object.freeze({
                key: item.ratingKey || item.guid || item.title,
                title: item.title || '',
                titleSort: (item.titleSort || item.title || '').toLowerCase(),
                year: parseInt(item.year) || null,
                rating: item.audienceRating !== undefined && item.audienceRating !== null ? Number(item.audienceRating) : null,
                // Plex's "rating" is the critic score (e.g. Rotten Tomatoes), on the same 0-10 scale
                criticRating: item.rating !== undefined && item.rating !== null ? Number(item.rating) : null,
                watched: !!item.lastViewedAt,
                studio: item.studio || '',
                actors: names(item, 'Role'),
                directors: names(item, 'Director'),
                writers: names(item, 'Writer'),
                genres: names(item, 'Genre'),
                countries: names(item, 'Country')
            })));
        },
        applyCastLimit: function(category) {
            const limit = parseInt(this.castLimitInputs[category]);
            if (!(limit >= 1) || !this.selectedLibraryStats || this.selectedLibraryStats[`${category}Limit`] === limit) return;
            this.updateLimit(category, limit);
        },
        ratingClass: function(rating) {
            if (rating === null || rating === undefined) return '';
            if (rating >= 8) return 'rating-high';
            if (rating >= 6) return 'rating-mid';
            return 'rating-low';
        },
        formatRating: function(rating) {
            return rating === null || rating === undefined ? '–' : rating.toFixed(1);
        },
        resetCastFilters: function() {
            this.castFilters = emptyCastFilters(this.castYearBounds);
            this.castTableSearch = '';
        },
        optionLabel: function(option) {
            if (option.total !== undefined && option.total !== option.count) {
                return `${option.name} (${option.count} of ${option.total})`;
            }
            return `${option.name} (${option.count})`;
        },
        // Adds a value to the matching filter, e.g. from clicking a name in a table
        addCastFilter: function(field, name) {
            const options = {
                actor: this.castFilterOptions.actors,
                director: this.castFilterOptions.directors,
                writer: this.castFilterOptions.writers,
                genre: this.castFilterOptions.genres,
                studio: this.castFilterOptions.studios
            }[field];
            const option = options && options.find(candidate => candidate.name === name);
            if (!option) return;

            const f = this.castFilters;
            const addTo = (list) => {
                if (!list.some(selected => selected.name === name)) list.push(option);
            };
            if (field === 'actor') addTo(f.actors);
            if (field === 'genre') addTo(f.genres);
            if (field === 'studio') addTo(f.studios);
            if (field === 'director') f.director = option;
            if (field === 'writer') f.writer = option;
        },
        // Category table rows on this page filter the analysis section and scroll to it
        filterFromCategoryRow: function(field, row) {
            this.addCastFilter(field, row.label);
            this.$nextTick(() => {
                const card = document.getElementById('cast-crew-analysis');
                if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        },
        sortCastTable: function(field) {
            if (this.castSortField === field) {
                this.castSortDirection = this.castSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                this.castSortField = field;
                this.castSortDirection = ['rating', 'criticRating', 'year', 'watched'].includes(field) ? 'desc' : 'asc';
            }
        },
        castSortClass: function(field) {
            if (this.castSortField !== field) return '';
            return this.castSortDirection === 'asc' ? 'sort-asc' : 'sort-desc';
        },
        goToCastPage: function(page) {
            this.castCurrentPage = Math.min(Math.max(1, page), this.castTotalPages);
        },
        // Selected actors first, then the rest of the billing order, capped for display
        castDisplayActors: function(item, limit) {
            const selected = item.actors.filter(name => this.castSelectedActorNames.includes(name));
            const others = item.actors.filter(name => !this.castSelectedActorNames.includes(name));
            return selected.concat(others).slice(0, Math.max(limit, selected.length));
        },
        exportCastResultsCSV: function() {
            const escapeCSV = (value) => {
                const str = String(value === null || value === undefined ? '' : value);
                return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
            };
            const header = ['Title', 'Year', 'Audience Rating', 'Critic Rating', 'Watched', 'Directors', 'Writers', 'Genres', 'Studio', 'Cast'];
            const rows = this.castSortedItems.map(item => [
                item.title, item.year, item.rating, item.criticRating, item.watched ? 'Yes' : 'No',
                item.directors.join('; '), item.writers.join('; '), item.genres.join('; '),
                item.studio, item.actors.join('; ')
            ]);
            const csv = [header].concat(rows).map(row => row.map(escapeCSV).join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `${this.selectedLibrary.replace(/[^a-z0-9]+/gi, '_')}_cast_crew_results.csv`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        },
        loadFullCredits: async function() {
            const token = ++this.creditsLoadToken;
            const items = (this.libraryItems || []).filter(item => item.ratingKey);
            if (items.length === 0) {
                this.creditsStatus = { state: 'idle', loaded: 0, total: 0 };
                return;
            }
            this.creditsStatus = { state: 'loading', loaded: 0, total: items.length };

            const batches = [];
            for (let i = 0; i < items.length; i += creditsBatchSize) {
                batches.push(items.slice(i, i + creditsBatchSize));
            }

            let nextBatch = 0;
            let failed = false;
            const worker = async () => {
                while (nextBatch < batches.length && !failed) {
                    const batch = batches[nextBatch++];
                    const keys = batch.map(item => item.ratingKey).join(',');
                    try {
                        const response = await axios.get(serverIp + '/library/metadata/' + keys + '?X-Plex-Token=' + serverToken);
                        if (token !== this.creditsLoadToken) return;
                        const fullItems = {};
                        ((response.data.MediaContainer && response.data.MediaContainer.Metadata) || []).forEach(full => {
                            fullItems[full.ratingKey] = full;
                        });
                        batch.forEach(item => {
                            const full = fullItems[item.ratingKey];
                            if (!full) return;
                            // Only names are kept; full credits also carry photos, ids and character names
                            const credits = {};
                            creditFields.forEach(field => {
                                const listed = tagNames(item[field]);
                                const complete = tagNames(full[field]);
                                credits[field] = complete.length >= listed.length ? complete : listed;
                            });
                            castCreditStore.set(item.ratingKey, credits);
                        });
                        this.creditsStatus.loaded += batch.length;
                    } catch (error) {
                        console.error('Failed to load full credits batch:', error);
                        failed = true;
                    }
                }
            };
            await Promise.all(Array.from({ length: creditsConcurrency }, worker));
            if (token !== this.creditsLoadToken) return;

            this.creditsStatus.state = failed ? 'partial' : 'done';
            this.rebuildCastItems();
            this.recountCreditCategories();
        },
        // Rebuilds the actor/director/writer/genre/country cards from the (now complete) credits
        recountCreditCategories: function() {
            creditCategories.forEach(category => this.recountCreditCategory(category));
        },
        recountCreditCategory: function(category) {
            const stats = this.selectedLibraryStats;
            if (!stats) return;
            const data = {};
            const watched = {};
            this.castItems.forEach(item => {
                let names = item[category.field];
                if (category.billed) {
                    names = names.slice(0, this.castBillingDepth);
                }
                names.forEach(name => {
                    data[name] = (data[name] || 0) + 1;
                    if (item.watched) {
                        watched[name] = (watched[name] || 0) + 1;
                    }
                });
            });
            const prepared = prepareCategoryChartData({ data: data, watched: watched });
            const label = capitalize(category.key);
            stats[`${category.key}List`] = prepared.list;
            stats[`${category.key}Counts`] = prepared.counts;
            stats[`${category.plural}WatchedCounts`] = prepared.watched;
            stats[`${category.plural}UnwatchedCounts`] = prepared.unwatched;
            stats[`top${label}`] = prepared.list.length > 0 ? prepared.list[0] : '';
            stats[`top${label}Count`] = prepared.counts.length > 0 ? prepared.counts[0].toLocaleString('en-us') : '';
            stats[`total${label}Count`] = prepared.list.length.toLocaleString('en-us');
            if (document.getElementById(`items-by-${category.key}`)) {
                this[category.render]();
            }
        },
        renderYearRatingChart: function() {
            const selector = 'items-by-year-rating';
            if (!document.getElementById(selector)) {
                return;
            }

            const rated = this.castItems.filter(item => item.rating !== null && item.year);
            this.yearRatingStats = this.computeYearRatingStats(rated);

            const buildTrace = (items, name, color) => ({
                // Small horizontal jitter keeps titles from the same year from stacking into one column
                x: items.map(item => item.year + (Math.random() - 0.5) * 0.6),
                y: items.map(item => item.rating),
                text: items.map(item => `${item.title} (${item.year})<br />Audience Rating: ${item.rating}`),
                name: name,
                mode: 'markers',
                type: 'scatter',
                hoverinfo: 'text',
                marker: { size: 6, color: color, opacity: 0.8 }
            });

            const data = [
                buildTrace(rated.filter(item => !item.watched), 'Unwatched', castCrewColors.unwatched),
                buildTrace(rated.filter(item => item.watched), 'Watched', castCrewColors.watched)
            ];

            const layout = {
                showlegend: false,
                margin: { pad: 10 },
                xaxis: {
                    title: 'Release Year',
                    gridcolor: '#888',
                    showgrid: true,
                    zeroline: false
                },
                yaxis: {
                    title: 'Audience Rating',
                    range: [0, 10.5],
                    gridcolor: '#888',
                    showgrid: true,
                    zeroline: false
                },
                font: { color: '#fff' },
                plot_bgcolor: 'transparent',
                paper_bgcolor: 'transparent',
                hovermode: 'closest',
                modebar: {
                    color: '#f2f2f2',
                    activecolor: castCrewColors.unwatched
                }
            };

            const config = {
                displaylogo: false,
                displayModeBar: true,
                modeBarButtonsToRemove: ['lasso2d', 'toImage'],
                responsive: true
            };

            Plotly.newPlot(selector, data, layout, config);
        },
        computeYearRatingStats: function(ratedItems) {
            if (ratedItems.length === 0) {
                return emptyYearRatingStats();
            }
            const sum = ratedItems.reduce((total, item) => total + item.rating, 0);

            const byYear = {};
            ratedItems.forEach(item => {
                byYear[item.year] = byYear[item.year] || { sum: 0, count: 0 };
                byYear[item.year].sum += item.rating;
                byYear[item.year].count++;
            });
            let bestYear = null;
            Object.keys(byYear).forEach(year => {
                const entry = byYear[year];
                if (entry.count < 3) return;
                const average = entry.sum / entry.count;
                if (!bestYear || average > bestYear.average) {
                    bestYear = { year: year, average: average, count: entry.count };
                }
            });

            return {
                ratedCount: ratedItems.length,
                averageRating: (sum / ratedItems.length).toFixed(1),
                bestYear: bestYear ? `${bestYear.year} (${bestYear.average.toFixed(1)} avg, ${bestYear.count} rated)` : 'N/A'
            };
        }
    }
};
