// Title and person detail pages, shown over the main page. Loaded after components.js.
// Links to other detail pages use #/item/<id> and #/person/<id> hrefs; a plain click emits "navigate"
// so the app can update its history, while middle-click still opens a new tab.

const creditKindLabels = { director: 'Director', writer: 'Writer', actor: 'Actor' };
// Order of a person's roles on one title
const creditKindOrder = ['director', 'writer', 'actor'];

const detailHref = (kind, id) => `#/${kind}/${id}`;

// Loads a detail resource whenever the id changes, ignoring responses for an id that is no longer shown
const detailLoader = (urlFor) => ({
    data: function() {
        return { detail: null, loading: true, error: null };
    },
    watch: {
        id: { immediate: true, handler: 'load' }
    },
    methods: {
        load: async function() {
            const id = this.id;
            this.loading = true;
            this.error = null;
            try {
                const response = await fetch(urlFor(id));
                if (!response.ok) throw new Error(response.status === 404 ? 'Not found; it may have been removed from Plex' : `The server returned ${response.status}`);
                const detail = await response.json();
                if (id !== this.id) return;
                this.detail = Object.freeze(detail);
            } catch (error) {
                if (id === this.id) this.error = error.message;
            } finally {
                if (id === this.id) this.loading = false;
            }
        },
        open: function(kind, id) {
            this.$emit('navigate', { kind, id });
        },
        href: detailHref,
        hideBrokenImage,
        formatRating,
        ratingClass
    }
});

const pluralize = (count, noun) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

// "2015-03-09" -> the viewer's local date format, without shifting the day across time zones
const formatAirDate = (date) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString() : '–';
};

const episodeCode = (episode) =>
    episode.season === null ? `E${episode.episode ?? '?'}` : `S${String(episode.season).padStart(2, '0')}E${String(episode.episode ?? 0).padStart(2, '0')}`;

// Actors of a title in order, with photos and characters; showEpisodes adds how many episodes each appears in
Vue.component('cast-table', {
    props: {
        credits: { type: Array, required: true },
        showEpisodes: { type: Boolean, default: false }
    },
    methods: {
        photoUrl: function(credit) {
            return credit.hasThumb ? personImageUrl(credit.personId, credit.imageVersion, 80) : null;
        },
        href: detailHref,
        hideBrokenImage
    },
    template: `
        <table class="comparison-table detail-table">
            <thead>
                <tr><th class="numeric">#</th><th>Actor</th><th>Role</th><th v-if="showEpisodes" class="numeric">Episodes</th></tr>
            </thead>
            <tbody>
                <tr v-for="(credit, index) in credits" :key="credit.personId">
                    <td class="numeric rank">{{ index + 1 }}</td>
                    <td>
                        <a class="detail-name-link" :href="href('person', credit.personId)" @click.prevent="$emit('navigate', { kind: 'person', id: credit.personId })">
                            <img v-if="credit.hasThumb" class="detail-row-photo" :src="photoUrl(credit)" alt="" loading="lazy" @error="hideBrokenImage">
                            <span v-else class="detail-row-photo placeholder" aria-hidden="true"></span>
                            {{ credit.name }}
                        </a>
                    </td>
                    <td class="detail-role">{{ credit.character || '' }}</td>
                    <td v-if="showEpisodes" class="numeric">{{ credit.episodeCount ? credit.episodeCount.toLocaleString() : '–' }}</td>
                </tr>
            </tbody>
        </table>`
});

Vue.component('item-detail', {
    mixins: [detailLoader(id => `/api/items/${id}`)],
    props: { id: { type: Number, required: true } },
    computed: {
        isShow: function() {
            return !!this.detail && this.detail.library.type === 'show';
        },
        // Directors and writers, each shown as a row of photos; groups with nobody credited are left out.
        // For shows these come from the episodes, most episodes first.
        crew: function() {
            const credits = this.detail ? this.detail.credits : [];
            return [
                { kind: 'director', title: 'Directed by' },
                { kind: 'writer', title: 'Written by' }
            ]
                .map(group => ({ ...group, credits: credits.filter(credit => credit.kind === group.kind) }))
                .filter(group => group.credits.length);
        },
        // Series regulars for shows (credited on the show itself); everyone for movies
        cast: function() {
            return this.detail ? this.detail.credits.filter(credit => credit.kind === 'actor' && credit.showCredit) : [];
        },
        // Actors credited only on some episodes of a show
        guestCast: function() {
            return this.detail ? this.detail.credits.filter(credit => credit.kind === 'actor' && !credit.showCredit) : [];
        },
        // Plex lists the actors of each episode for some shows but not others
        castEpisodeCounts: function() {
            return this.cast.some(credit => credit.episodeCount);
        },
        facts: function() {
            const item = this.detail;
            if (!item) return [];
            const facts = [];
            if (item.contentRating) facts.push(item.contentRating);
            if (this.isShow) {
                if (item.childCount) facts.push(pluralize(item.childCount, 'season'));
                if (item.leafCount) facts.push(pluralize(item.leafCount, 'episode'));
            } else if (item.durationMs) {
                facts.push(formatLength(Math.round(item.durationMs / 60000)));
            }
            if (item.studio) facts.push(item.studio);
            if (item.genres.length) facts.push(item.genres.join(', '));
            return facts;
        },
        posterUrl: function() {
            return this.detail && this.detail.hasThumb ? posterImageUrl(this.detail.id, this.detail.imageVersion, 320) : null;
        },
        imdbUrl: function() {
            return this.detail && this.detail.imdbId ? imdbTitleUrl(this.detail.imdbId) : null;
        }
    },
    watch: {
        detail: function(item) {
            if (item) this.$emit('title', item.title);
        }
    },
    methods: {
        photoUrl: function(credit, width) {
            return credit.hasThumb ? personImageUrl(credit.personId, credit.imageVersion, width) : null;
        },
        pluralize,
        formatAirDate,
        episodeCode,
        formatLength,
        episodesWatchedClass,
        formatEpisodesWatched
    },
    template: `
        <div class="detail-body">
            <p v-if="loading && !detail" class="note">Loading&hellip;</p>
            <p v-else-if="error" class="detail-error">{{ error }}</p>
            <template v-if="detail">
                <div class="detail-hero">
                    <img v-if="posterUrl" class="detail-poster" :src="posterUrl" :alt="detail.title + ' poster'" @error="hideBrokenImage">
                    <div class="detail-heading">
                        <h2>{{ detail.title }} <span v-if="detail.year" class="detail-year">({{ detail.year }})</span></h2>
                        <p v-if="facts.length" class="detail-facts">{{ facts.join(' · ') }}</p>
                        <p class="detail-ratings">
                            <span>Audience <strong :class="ratingClass(detail.rating)">{{ formatRating(detail.rating) }}</strong></span>
                            <span v-if="!isShow">Critic <strong :class="ratingClass(detail.criticRating)">{{ formatRating(detail.criticRating) }}</strong></span>
                            <span v-if="isShow">Watched <strong :class="episodesWatchedClass(detail.viewedLeafCount, detail.leafCount)">{{ formatEpisodesWatched(detail.viewedLeafCount, detail.leafCount) }}</strong> episodes</span>
                            <span v-else>Watched <strong :class="detail.watched ? 'rating-high' : 'rating-low'">{{ detail.watched ? 'Yes' : 'No' }}</strong></span>
                            <a v-if="imdbUrl" :href="imdbUrl" target="mediadata-imdb" referrerpolicy="no-referrer" class="detail-external">IMDb &#8599;</a>
                        </p>
                        <p v-if="detail.summary" class="detail-summary">{{ detail.summary }}</p>
                        <div v-if="crew.length" class="detail-crew">
                            <div v-for="group in crew" :key="group.kind" class="detail-people">
                                <h3>{{ group.title }}</h3>
                                <div class="detail-people-list">
                                    <a v-for="credit in group.credits" :key="credit.personId" class="detail-person" :href="href('person', credit.personId)" @click.prevent="open('person', credit.personId)">
                                        <img v-if="credit.hasThumb" class="detail-person-photo" :src="photoUrl(credit, 160)" alt="" @error="hideBrokenImage">
                                        <span v-else class="detail-person-photo placeholder" aria-hidden="true"></span>
                                        <span class="detail-person-name">{{ credit.name }}</span>
                                        <span v-if="credit.episodeCount" class="detail-person-episodes">{{ pluralize(credit.episodeCount, 'episode') }}</span>
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <h3 class="detail-section-title">Cast <span class="detail-count">({{ cast.length.toLocaleString() }})</span></h3>
                <p v-if="!cast.length" class="note">Plex has no cast for this title.</p>
                <div v-else class="table-container">
                    <cast-table :credits="cast" :show-episodes="castEpisodeCounts" @navigate="$emit('navigate', $event)"></cast-table>
                </div>
                <template v-if="guestCast.length">
                    <h3 class="detail-section-title detail-section-gap">Guest Stars <span class="detail-count">({{ guestCast.length.toLocaleString() }})</span></h3>
                    <div class="table-container detail-scroll">
                        <cast-table :credits="guestCast" show-episodes @navigate="$emit('navigate', $event)"></cast-table>
                    </div>
                </template>
                <template v-if="detail.episodes">
                    <h3 class="detail-section-title detail-section-gap">Episodes <span class="detail-count">({{ detail.episodes.length.toLocaleString() }})</span></h3>
                    <p v-if="!detail.episodes.length" class="note">No episodes synced yet; they arrive with the next sync.</p>
                    <div v-else class="table-container detail-scroll">
                        <table class="comparison-table detail-table">
                            <thead>
                                <tr><th>Episode</th><th>Title</th><th>Air Date</th><th class="numeric">Length</th><th>Watched</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="episode in detail.episodes" :key="episode.id">
                                    <td class="episode-code">{{ episodeCode(episode) }}</td>
                                    <td>{{ episode.title || '' }}</td>
                                    <td class="episode-date">{{ formatAirDate(episode.airDate) }}</td>
                                    <td class="numeric">{{ episode.durationMs ? formatLength(Math.round(episode.durationMs / 60000)) : '–' }}</td>
                                    <td class="rating-cell" :class="episode.watched ? 'rating-high' : 'rating-low'">{{ episode.watched ? 'Yes' : 'No' }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </template>
            </template>
        </div>`
});

// Sortable table of the titles a person is credited on. rows: one per title, with roles: [string], one per line.
// For shows there are no critic ratings, and watched counts episodes.
Vue.component('person-credits-table', {
    props: {
        rows: { type: Array, required: true },
        showLibrary: { type: Boolean, default: false },
        shows: { type: Boolean, default: false }
    },
    data: function() {
        return { sortField: 'year', sortDirection: 'desc' };
    },
    computed: {
        sortedRows: function() {
            const field = this.sortField;
            const direction = this.sortDirection === 'asc' ? 1 : -1;
            const value = (row) => {
                switch (field) {
                    case 'title': return row.titleSort;
                    case 'role': return row.roles.join(', ');
                    case 'library': return row.libraryTitle;
                    // Shows sort by the share of episodes watched, then by how many
                    case 'watched': return this.shows ? (row.leafCount ? (row.viewedLeafCount || 0) / row.leafCount : 0) + (row.viewedLeafCount || 0) / 1e9 : (row.watched ? 1 : 0);
                    default: return row[field];
                }
            };
            return [...this.rows].sort((a, b) => {
                const aVal = value(a);
                const bVal = value(b);
                // Missing values always sort last; ties fall back to title
                if (aVal === null && bVal === null) return a.titleSort.localeCompare(b.titleSort);
                if (aVal === null) return 1;
                if (bVal === null) return -1;
                const order = typeof aVal === 'string'
                    ? aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' })
                    : aVal - bVal;
                return order * direction || a.titleSort.localeCompare(b.titleSort);
            });
        }
    },
    methods: {
        sortBy: function(field) {
            if (this.sortField === field) {
                this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                this.sortField = field;
                // Text reads naturally A-Z; years, ratings and watched are most useful highest-first
                this.sortDirection = ['title', 'role', 'library'].includes(field) ? 'asc' : 'desc';
            }
        },
        sortClass: function(field) {
            if (this.sortField !== field) return '';
            return this.sortDirection === 'asc' ? 'sort-asc' : 'sort-desc';
        },
        posterUrl: function(row) {
            return row.hasThumb ? posterImageUrl(row.itemId, row.imageVersion, 80) : null;
        },
        href: detailHref,
        hideBrokenImage,
        formatRating,
        ratingClass,
        episodesWatchedClass,
        formatEpisodesWatched
    },
    template: `
        <div class="table-container">
            <table class="comparison-table detail-table">
                <thead>
                    <tr>
                        <th @click="sortBy('year')" class="sortable" :class="sortClass('year')">Year<span class="sort-arrow"></span></th>
                        <th @click="sortBy('title')" class="sortable" :class="sortClass('title')">Title<span class="sort-arrow"></span></th>
                        <th @click="sortBy('role')" class="sortable" :class="sortClass('role')">Role<span class="sort-arrow"></span></th>
                        <th v-if="showLibrary" @click="sortBy('library')" class="sortable" :class="sortClass('library')">Library<span class="sort-arrow"></span></th>
                        <th @click="sortBy('rating')" class="sortable" :class="sortClass('rating')">Audience<span class="sort-arrow"></span></th>
                        <th v-if="!shows" @click="sortBy('criticRating')" class="sortable" :class="sortClass('criticRating')">Critic<span class="sort-arrow"></span></th>
                        <th @click="sortBy('watched')" class="sortable" :class="sortClass('watched')">Watched<span class="sort-arrow"></span></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in sortedRows" :key="row.itemId">
                        <td>{{ row.year || '–' }}</td>
                        <td>
                            <a class="detail-name-link" :href="href('item', row.itemId)" @click.prevent="$emit('navigate', { kind: 'item', id: row.itemId })">
                                <img v-if="row.hasThumb" class="detail-row-poster" :src="posterUrl(row)" alt="" loading="lazy" @error="hideBrokenImage">
                                <span v-else class="detail-row-poster placeholder" aria-hidden="true"></span>
                                {{ row.title }}
                            </a>
                        </td>
                        <td class="detail-role"><span v-for="role in row.roles" :key="role" class="detail-role-line">{{ role }}</span></td>
                        <td v-if="showLibrary">{{ row.libraryTitle }}</td>
                        <td class="rating-cell" :class="ratingClass(row.rating)">{{ formatRating(row.rating) }}</td>
                        <td v-if="!shows" class="rating-cell" :class="ratingClass(row.criticRating)">{{ formatRating(row.criticRating) }}</td>
                        <td v-if="shows" class="rating-cell" :class="episodesWatchedClass(row.viewedLeafCount, row.leafCount)" title="Episodes watched">{{ formatEpisodesWatched(row.viewedLeafCount, row.leafCount) }}</td>
                        <td v-else class="rating-cell" :class="row.watched ? 'rating-high' : 'rating-low'">{{ row.watched ? 'Yes' : 'No' }}</td>
                    </tr>
                </tbody>
            </table>
        </div>`
});

// Credit sections on a person page, by library type
const personCreditSections = [
    { type: 'movie', title: 'Movies' },
    { type: 'show', title: 'TV Shows' }
];

Vue.component('person-detail', {
    mixins: [detailLoader(id => `/api/people/${id}`)],
    props: { id: { type: Number, required: true } },
    computed: {
        // One row per title, with every way this person is credited on it: director, then writer, then actor
        titles: function() {
            if (!this.detail) return [];
            const rows = new Map();
            for (const credit of this.detail.credits) {
                let row = rows.get(credit.itemId);
                if (!row) {
                    row = { ...credit, credits: [] };
                    rows.set(credit.itemId, row);
                }
                row.credits.push(credit);
            }
            const rank = (kind) => (creditKindOrder.includes(kind) ? creditKindOrder.indexOf(kind) : creditKindOrder.length);
            return [...rows.values()].map(({ credits, ...row }) => ({
                ...row,
                roles: credits
                    .sort((a, b) => rank(a.kind) - rank(b.kind))
                    .map(credit => {
                        const label = creditKindLabels[credit.kind] || credit.kind;
                        const role = credit.kind === 'actor' && credit.character ? `${label} (${credit.character})` : label;
                        return credit.episodeCount ? `${role} · ${pluralize(credit.episodeCount, 'episode')}` : role;
                    })
            }));
        },
        // Sections with at least one title; any library type without its own section is listed last
        sections: function() {
            const known = personCreditSections.map(section => section.type);
            return personCreditSections
                .map(section => ({ ...section, rows: this.titles.filter(row => row.libraryType === section.type) }))
                .concat([{ type: 'other', title: 'Other', rows: this.titles.filter(row => !known.includes(row.libraryType)) }])
                .filter(section => section.rows.length)
                .map(section => ({ ...section, showLibrary: new Set(section.rows.map(row => row.libraryId)).size > 1 }));
        },
        summary: function() {
            const counts = {};
            for (const credit of this.detail ? this.detail.credits : []) counts[credit.kind] = (counts[credit.kind] || 0) + 1;
            const parts = ['actor', 'director', 'writer'].filter(kind => counts[kind])
                .map(kind => `${counts[kind]} as ${creditKindLabels[kind].toLowerCase()}`);
            const watched = this.titles.filter(row => row.watched).length;
            return `${this.titles.length.toLocaleString()} title${this.titles.length === 1 ? '' : 's'} (${parts.join(', ')}) · ${watched.toLocaleString()} watched`;
        },
        photoUrl: function() {
            return this.detail && this.detail.hasThumb ? personImageUrl(this.detail.id, this.detail.imageVersion, 320) : null;
        }
    },
    watch: {
        detail: function(person) {
            if (person) this.$emit('title', person.name);
        }
    },
    template: `
        <div class="detail-body">
            <p v-if="loading && !detail" class="note">Loading&hellip;</p>
            <p v-else-if="error" class="detail-error">{{ error }}</p>
            <template v-if="detail">
                <div class="detail-hero">
                    <img v-if="photoUrl" class="detail-poster person" :src="photoUrl" :alt="detail.name" @error="hideBrokenImage">
                    <div class="detail-heading">
                        <h2>{{ detail.name }}</h2>
                        <p class="detail-facts">{{ summary }}</p>
                    </div>
                </div>
                <section v-for="section in sections" :key="section.type" class="detail-section">
                    <h3 class="detail-section-title">{{ section.title }} <span class="detail-count">({{ section.rows.length.toLocaleString() }})</span></h3>
                    <person-credits-table :key="detail.id" :rows="section.rows" :show-library="section.showLibrary" :shows="section.type === 'show'" @navigate="$emit('navigate', $event)"></person-credits-table>
                </section>
            </template>
        </div>`
});
