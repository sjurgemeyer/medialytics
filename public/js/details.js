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
        directors: function() {
            return this.detail ? this.detail.credits.filter(credit => credit.kind === 'director') : [];
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
                        <div v-if="directors.length" class="detail-people">
                            <h3>Directed by</h3>
                            <div class="detail-people-list">
                                <a v-for="credit in directors" :key="credit.personId" class="detail-person" :href="href('person', credit.personId)" @click.prevent="open('person', credit.personId)">
                                    <img v-if="credit.hasThumb" class="detail-person-photo" :src="photoUrl(credit, 160)" alt="" @error="hideBrokenImage">
                                    <span v-else class="detail-person-photo placeholder" aria-hidden="true"></span>
                                    <span class="detail-person-name">{{ credit.name }}</span>
                                </a>
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
        summary: function() {
            const counts = {};
            for (const credit of this.detail ? this.detail.credits : []) counts[credit.kind] = (counts[credit.kind] || 0) + 1;
            const parts = ['actor', 'director', 'writer'].filter(kind => counts[kind])
                .map(kind => `${counts[kind]} as ${creditKindLabels[kind].toLowerCase()}`);
            const watched = this.titles.filter(row => row.watched).length;
            return `${this.titles.length.toLocaleString()} title${this.titles.length === 1 ? '' : 's'} (${parts.join(', ')}) · ${watched.toLocaleString()} watched`;
        },
        multipleLibraries: function() {
            return new Set(this.titles.map(row => row.libraryId)).size > 1;
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
    methods: {
        posterUrl: function(row) {
            return row.hasThumb ? posterImageUrl(row.itemId, row.imageVersion, 80) : null;
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
                <h3 class="detail-section-title">Credits</h3>
                <div class="table-container">
                    <table class="comparison-table detail-table">
                        <thead>
                            <tr>
                                <th>Year</th>
                                <th>Title</th>
                                <th>Role</th>
                                <th v-if="multipleLibraries">Library</th>
                                <th>Audience</th>
                                <th>Critic</th>
                                <th>Watched</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in titles" :key="row.itemId">
                                <td>{{ row.year || '–' }}</td>
                                <td>
                                    <a class="detail-name-link" :href="href('item', row.itemId)" @click.prevent="open('item', row.itemId)">
                                        <img v-if="row.hasThumb" class="detail-row-poster" :src="posterUrl(row)" alt="" loading="lazy" @error="hideBrokenImage">
                                        <span v-else class="detail-row-poster placeholder" aria-hidden="true"></span>
                                        {{ row.title }}
                                    </a>
                                </td>
                                <td class="detail-role">{{ row.roles.join(', ') }}</td>
                                <td v-if="multipleLibraries">{{ row.libraryTitle }}</td>
                                <td class="rating-cell" :class="ratingClass(row.rating)">{{ formatRating(row.rating) }}</td>
                                <td class="rating-cell" :class="ratingClass(row.criticRating)">{{ formatRating(row.criticRating) }}</td>
                                <td class="rating-cell" :class="row.watched ? 'rating-high' : 'rating-low'">{{ row.watched ? 'Yes' : 'No' }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>
        </div>`
});
