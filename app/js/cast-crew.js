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

// Category cards recounted from full credits: stats key, plural used by scripts.js, Plex field, renderer
const creditCategories = [
    { key: 'actor', plural: 'actors', field: 'Role', render: 'renderActorChart' },
    { key: 'director', plural: 'directors', field: 'Director', render: 'renderDirectorChart' },
    { key: 'writer', plural: 'writers', field: 'Writer', render: 'renderWriterChart' },
    { key: 'genre', plural: 'genres', field: 'Genre', render: 'renderGenreChart' },
    { key: 'country', plural: 'countries', field: 'Country', render: 'renderCountryChart' }
];

const tagNames = (list) => Array.isArray(list) ? [...new Set(list.map(tag => tag.tag).filter(Boolean))] : [];

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const ratingBounds = [0, 10];

const emptyCastFilters = (yearBounds) => ({
    actors: [],     // AND: every selected actor must appear
    director: null,
    writer: null,
    genres: [],     // OR within genres
    studios: [],    // OR within studios
    yearRange: yearBounds.slice(),
    ratingRange: ratingBounds.slice(),
    watched: 'all'
});

// Options for a typeahead: [{ name, count }] sorted by how many items use the value
const countOptions = (items, accessor) => {
    const counts = {};
    items.forEach(item => {
        accessor(item).forEach(name => {
            counts[name] = (counts[name] || 0) + 1;
        });
    });
    return Object.keys(counts)
        .map(name => ({ name: name, count: counts[name] }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
            castItemsPerPage: 25
        };
    },
    computed: {
        // Normalized view of the raw Plex items used by the filters and results table
        castItems: function() {
            return (this.libraryItems || []).map(item => Object.freeze({
                key: item.ratingKey || item.guid || item.title,
                title: item.title || '',
                titleSort: (item.titleSort || item.title || '').toLowerCase(),
                year: parseInt(item.year) || null,
                rating: item.audienceRating !== undefined && item.audienceRating !== null ? Number(item.audienceRating) : null,
                watched: !!item.lastViewedAt,
                studio: item.studio || '',
                actors: tagNames(item.Role),
                directors: tagNames(item.Director),
                writers: tagNames(item.Writer),
                genres: tagNames(item.Genre)
            }));
        },
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
                actors: countOptions(items, item => item.actors),
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
        castActiveFilterCount: function() {
            const f = this.castFilters;
            return [
                f.actors.length > 0, !!f.director, !!f.writer, f.genres.length > 0, f.studios.length > 0,
                this.castYearFilterActive, this.castRatingFilterActive, f.watched !== 'all'
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
            const yearActive = this.castYearFilterActive;
            const ratingActive = this.castRatingFilterActive;

            return this.castItems.filter(item => {
                if (actorNames.length && !actorNames.every(name => item.actors.includes(name))) return false;
                if (f.director && !item.directors.includes(f.director.name)) return false;
                if (f.writer && !item.writers.includes(f.writer.name)) return false;
                if (genreNames.length && !genreNames.some(name => item.genres.includes(name))) return false;
                if (studioNames.length && !studioNames.includes(item.studio)) return false;
                if (yearActive && (item.year === null || item.year < yearLow || item.year > yearHigh)) return false;
                if (ratingActive && (item.rating === null || item.rating < ratingLow || item.rating > ratingHigh)) return false;
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
        selectedLibraryStats: function() {
            this.resetCastFilters();
            this.$nextTick(() => {
                this.renderYearRatingChart();
                this.loadFullCredits();
            });
        },
        castFilteredItems: function() {
            this.castCurrentPage = 1;
        },
        castTableSearch: function() {
            this.castCurrentPage = 1;
        }
    },
    methods: {
        resetCastFilters: function() {
            this.castFilters = emptyCastFilters(this.castYearBounds);
            this.castTableSearch = '';
        },
        optionLabel: function(option) {
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
                this.castSortDirection = ['rating', 'year', 'watched'].includes(field) ? 'desc' : 'asc';
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
            const header = ['Title', 'Year', 'Audience Rating', 'Watched', 'Directors', 'Writers', 'Genres', 'Studio', 'Cast'];
            const rows = this.castSortedItems.map(item => [
                item.title, item.year, item.rating, item.watched ? 'Yes' : 'No',
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
                            creditFields.forEach(field => {
                                if (Array.isArray(full[field]) && full[field].length >= (item[field] || []).length) {
                                    item[field] = full[field];
                                }
                            });
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
            this.recountCreditCategories();
        },
        // Rebuilds the actor/director/writer/genre/country cards from the (now complete) credits
        recountCreditCategories: function() {
            const stats = this.selectedLibraryStats;
            creditCategories.forEach(category => {
                const data = {};
                const watched = {};
                this.libraryItems.forEach(item => {
                    tagNames(item[category.field]).forEach(name => {
                        data[name] = (data[name] || 0) + 1;
                        if (item.lastViewedAt) {
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
            });
        },
        renderYearRatingChart: function() {
            const selector = 'items-by-year-rating';
            if (!document.getElementById(selector)) {
                return;
            }

            const rated = (this.libraryItems || []).filter(item =>
                item.audienceRating !== undefined && item.audienceRating !== null && item.year);
            this.yearRatingStats = this.computeYearRatingStats(rated);

            const buildTrace = (items, name, color) => ({
                // Small horizontal jitter keeps titles from the same year from stacking into one column
                x: items.map(item => item.year + (Math.random() - 0.5) * 0.6),
                y: items.map(item => item.audienceRating),
                text: items.map(item => `${item.title} (${item.year})<br />Audience Rating: ${item.audienceRating}`),
                name: name,
                mode: 'markers',
                type: 'scatter',
                hoverinfo: 'text',
                marker: { size: 6, color: color, opacity: 0.8 }
            });

            const data = [
                buildTrace(rated.filter(item => !item.lastViewedAt), 'Unwatched', castCrewColors.unwatched),
                buildTrace(rated.filter(item => item.lastViewedAt), 'Watched', castCrewColors.watched)
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
            const sum = ratedItems.reduce((total, item) => total + Number(item.audienceRating), 0);

            const byYear = {};
            ratedItems.forEach(item => {
                byYear[item.year] = byYear[item.year] || { sum: 0, count: 0 };
                byYear[item.year].sum += Number(item.audienceRating);
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
