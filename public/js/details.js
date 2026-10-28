// Title and person detail pages, shown over the main page. Loaded after components.js.
// Links to other detail pages use #/item/<id> and #/person/<id> hrefs; a plain click emits "navigate"
// so the app can update its history, while middle-click still opens a new tab.

const creditKindLabels = { director: 'Director', writer: 'Writer', actor: 'Actor' };

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

Vue.component('item-detail', {
    mixins: [detailLoader(id => `/api/items/${id}`)],
    props: { id: { type: Number, required: true } },
    computed: {
        // Directors and writers, each shown as a row of photos; groups with nobody credited are left out
        crew: function() {
            const credits = this.detail ? this.detail.credits : [];
            return [
                { kind: 'director', title: 'Directed by' },
                { kind: 'writer', title: 'Written by' }
            ]
                .map(group => ({ ...group, credits: credits.filter(credit => credit.kind === group.kind) }))
                .filter(group => group.credits.length);
        },
        cast: function() {
            return this.detail ? this.detail.credits.filter(credit => credit.kind === 'actor') : [];
        },
        facts: function() {
            const item = this.detail;
            if (!item) return [];
            const facts = [];
            if (item.contentRating) facts.push(item.contentRating);
            if (item.library.type === 'show') {
                if (item.childCount) facts.push(`${item.childCount} season${item.childCount === 1 ? '' : 's'}`);
                if (item.leafCount) facts.push(`${item.leafCount} episode${item.leafCount === 1 ? '' : 's'}`);
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
        }
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
                            <span>Critic <strong :class="ratingClass(detail.criticRating)">{{ formatRating(detail.criticRating) }}</strong></span>
                            <span>Watched <strong :class="detail.watched ? 'rating-high' : 'rating-low'">{{ detail.watched ? 'Yes' : 'No' }}</strong></span>
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
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <h3 class="detail-section-title">Cast <span class="detail-count">({{ cast.length.toLocaleString() }})</span></h3>
                <p v-if="!cast.length" class="note">Plex has no cast for this title.</p>
                <div v-else class="table-container">
                    <table class="comparison-table detail-table">
                        <thead>
                            <tr><th class="numeric">#</th><th>Actor</th><th>Role</th></tr>
                        </thead>
                        <tbody>
                            <tr v-for="(credit, index) in cast" :key="credit.personId">
                                <td class="numeric rank">{{ index + 1 }}</td>
                                <td>
                                    <a class="detail-name-link" :href="href('person', credit.personId)" @click.prevent="open('person', credit.personId)">
                                        <img v-if="credit.hasThumb" class="detail-row-photo" :src="photoUrl(credit, 80)" alt="" loading="lazy" @error="hideBrokenImage">
                                        <span v-else class="detail-row-photo placeholder" aria-hidden="true"></span>
                                        {{ credit.name }}
                                    </a>
                                </td>
                                <td class="detail-role">{{ credit.character || '' }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>
        </div>`
});

// Sortable table of the titles a person is credited on. rows: one per title, with roles: [string]
Vue.component('person-credits-table', {
    props: {
        rows: { type: Array, required: true },
        showLibrary: { type: Boolean, default: false }
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
                    case 'watched': return row.watched ? 1 : 0;
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
        ratingClass
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
                        <th @click="sortBy('criticRating')" class="sortable" :class="sortClass('criticRating')">Critic<span class="sort-arrow"></span></th>
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
                        <td class="detail-role">{{ row.roles.join(', ') }}</td>
                        <td v-if="showLibrary">{{ row.libraryTitle }}</td>
                        <td class="rating-cell" :class="ratingClass(row.rating)">{{ formatRating(row.rating) }}</td>
                        <td class="rating-cell" :class="ratingClass(row.criticRating)">{{ formatRating(row.criticRating) }}</td>
                        <td class="rating-cell" :class="row.watched ? 'rating-high' : 'rating-low'">{{ row.watched ? 'Yes' : 'No' }}</td>
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
        // One row per title, with every way this person is credited on it
        titles: function() {
            if (!this.detail) return [];
            const rows = new Map();
            for (const credit of this.detail.credits) {
                let row = rows.get(credit.itemId);
                if (!row) {
                    row = { ...credit, roles: [] };
                    rows.set(credit.itemId, row);
                }
                row.roles.push(credit.kind === 'actor' && credit.character ? `${creditKindLabels.actor} as ${credit.character}` : (creditKindLabels[credit.kind] || credit.kind));
            }
            return [...rows.values()];
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
                    <person-credits-table :key="detail.id" :rows="section.rows" :show-library="section.showLibrary" @navigate="$emit('navigate', $event)"></person-credits-table>
                </section>
            </template>
        </div>`
});
