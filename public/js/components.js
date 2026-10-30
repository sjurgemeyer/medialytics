// Shared Vue components for the MediaData page. Loaded before app.js.

// localStorage wrapper shared by app.js and these components
const storage = {
    get(key) {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            return null;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch (error) {
            // Storage can be unavailable (e.g. private browsing); the setting just won't persist
        }
    }
};

// Cached artwork URLs; the version changes with the artwork, so the browser can keep them indefinitely
const posterImageUrl = (itemId, version, width) => `/api/images/poster/${itemId}?w=${width}&v=${version}`;
const personImageUrl = (personId, version, width) => `/api/images/person/${personId}?w=${width}&v=${version}`;

const hideBrokenImage = (event) => {
    event.target.style.visibility = 'hidden';
};

const imdbTitleUrl = (imdbId) => `https://www.imdb.com/title/${imdbId}/`;

// 142 -> "2h 22m"
const formatMinutes = (minutes) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hours ? `${hours}h ${String(mins).padStart(2, '0')}m` : `${mins}m`;
};

const formatLength = (minutes) => (minutes ? formatMinutes(minutes) : '–');

// Ratings are 0-10
const ratingClass = (rating) => {
    if (rating === null || rating === undefined) return '';
    if (rating >= 8) return 'rating-high';
    if (rating >= 6) return 'rating-mid';
    return 'rating-low';
};

const formatRating = (rating) => (rating === null || rating === undefined ? '–' : rating.toFixed(1));

// Watched episodes of a show: green when all are watched, red below 10%, yellow in between
const episodesWatchedClass = (watched, total) => {
    if (!total) return '';
    if (watched >= total) return 'rating-high';
    return watched / total < 0.1 ? 'rating-low' : 'rating-mid';
};

const formatEpisodesWatched = (watched, total) => `${(watched || 0).toLocaleString()}/${(total || 0).toLocaleString()}`;

// Enlarged poster or photo shown beside a hovered thumbnail, anywhere on the page, framed with a caption.
// One <image-preview> in index.html renders whatever showImagePreview last set.
const imagePreview = Vue.observable({ current: null });
// The framed card: a 200x300 image, padding, and room for a two-line caption
const imagePreviewSize = { width: 218, height: 360 };

// "Heat (1995)", or just the title when the year is unknown
const titleWithYear = (title, year) => (year ? `${title} (${year})` : title);

// Places the preview beside the thumbnail, flipped to its left near the window's right edge
const showImagePreview = (event, url, caption) => {
    if (!url) return;
    const thumb = event.target.getBoundingClientRect();
    const { width, height } = imagePreviewSize;
    const gap = 12;
    const left = thumb.right + gap + width <= window.innerWidth ? thumb.right + gap : thumb.left - gap - width;
    const top = Math.min(Math.max(gap, thumb.top + thumb.height / 2 - height / 2), window.innerHeight - height - gap);
    imagePreview.current = { url, caption: caption || '', left, top };
};

const hideImagePreview = () => {
    imagePreview.current = null;
};

// The preview is fixed to the window, so any scroll (of the page or a table) would leave it behind
window.addEventListener('scroll', hideImagePreview, { capture: true, passive: true });

Vue.component('image-preview', {
    computed: {
        current: function() {
            return imagePreview.current;
        }
    },
    template: `
        <figure v-if="current" class="image-preview" :style="{ left: current.left + 'px', top: current.top + 'px' }">
            <img :src="current.url" :alt="current.caption">
            <figcaption v-if="current.caption">{{ current.caption }}</figcaption>
        </figure>`
});

// Third-party components from the CDN scripts in index.html
if (window.VueMultiselect) {
    Vue.component('multiselect', window.VueMultiselect.default || window.VueMultiselect.Multiselect);
}
if (window['vue-slider-component']) {
    Vue.component('vue-slider', window['vue-slider-component']);
}

// Chart view modes
const chartModeLabels = { bar: 'bar chart', pie: 'pie chart', table: 'table' };

// Button that cycles a chart card through its view modes (bar -> pie -> table by default).
// The icon shows the mode a click will switch to.
Vue.component('chart-mode-toggle', {
    props: {
        value: { type: String, required: true },
        modes: { type: Array, default: () => ['bar', 'pie', 'table'] }
    },
    computed: {
        nextMode: function() {
            const index = this.modes.indexOf(this.value);
            return this.modes[(index + 1) % this.modes.length];
        }
    },
    methods: {
        cycle: function() {
            this.$emit('input', this.nextMode);
            this.$emit('change', this.nextMode);
        }
    },
    template: `
        <div class="chart-toggle">
            <button type="button"
                :class="['chart-toggle-button', 'next-' + nextMode]"
                :title="'Switch to ' + chartModeLabels[nextMode] + ' view'"
                :aria-label="'Switch to ' + chartModeLabels[nextMode] + ' view'"
                @click="cycle"></button>
        </div>`,
    data: function() {
        return { chartModeLabels: chartModeLabels };
    }
});

const collapsedSectionsStorageKey = 'mediadata.collapsedSections';

const loadCollapsedSections = () => {
    try {
        const saved = JSON.parse(storage.get(collapsedSectionsStorageKey));
        return Array.isArray(saved) ? saved : [];
    } catch (error) {
        return [];
    }
};

// Which sections are collapsed, shared by every card and remembered across visits. `shown` holds the
// section ids on the page right now, so collapsing or expanding all leaves other libraries' sections alone.
const sections = {
    state: Vue.observable({ collapsed: loadCollapsedSections() }),
    shown: new Set(),
    isCollapsed(id) {
        return sections.state.collapsed.includes(id);
    },
    save(collapsed) {
        sections.state.collapsed = collapsed;
        storage.set(collapsedSectionsStorageKey, JSON.stringify(collapsed));
    },
    setCollapsed(id, collapsed) {
        const others = sections.state.collapsed.filter(other => other !== id);
        sections.save(collapsed ? others.concat(id) : others);
    },
    collapseAll() {
        sections.save([...new Set([...sections.state.collapsed, ...sections.shown])]);
    },
    expandAll() {
        sections.save(sections.state.collapsed.filter(id => !sections.shown.has(id)));
    }
};

// Card whose header collapses and expands its content; half cards sit two per row. The header text goes in
// the "title" slot.
Vue.component('collapsible-card', {
    props: {
        sectionId: { type: String, required: true },
        half: { type: Boolean, default: false }
    },
    computed: {
        collapsed: function() {
            return sections.isCollapsed(this.sectionId);
        }
    },
    watch: {
        collapsed: function(collapsed) {
            if (collapsed) return;
            // Plotly sizes a chart from its container, which has no size while hidden
            this.$nextTick(() => {
                this.$el.querySelectorAll('.js-plotly-plot').forEach(plot => Plotly.Plots.resize(plot));
            });
        },
        sectionId: {
            immediate: true,
            handler: function(id, previous) {
                if (previous) sections.shown.delete(previous);
                sections.shown.add(id);
            }
        }
    },
    beforeDestroy: function() {
        sections.shown.delete(this.sectionId);
    },
    methods: {
        toggle: function() {
            sections.setCollapsed(this.sectionId, !this.collapsed);
        },
        expand: function() {
            sections.setCollapsed(this.sectionId, false);
        }
    },
    template: `
        <div class="card collapsible-card" :class="[half ? 'half' : 'full', { collapsed: collapsed }]">
            <div class="header" role="button" tabindex="0"
                :aria-expanded="String(!collapsed)"
                :title="collapsed ? 'Expand' : 'Collapse'"
                @click="toggle"
                @keydown.enter.prevent="toggle"
                @keydown.space.prevent="toggle">
                <span class="collapse-chevron" aria-hidden="true"></span>
                <slot name="title"></slot>
            </div>
            <div class="content" v-show="!collapsed">
                <slot></slot>
            </div>
        </div>`
});

// Sortable table view of a category breakdown.
// rows: [{ label, total, watched, unwatched, personId?, image?, largeImage? }] in the order the chart displays
// them; image is a headshot URL shown beside the label and largeImage its hover preview. Clicking a row emits
// row-click; right-clicking a person's row emits person-click with the person id.
// totalLabel heads the share-of-total column, e.g. "% of Library".
Vue.component('category-table', {
    props: {
        rows: { type: Array, default: () => [] },
        labelHeader: { type: String, default: 'Name' },
        totalItems: { type: Number, default: 0 },
        totalLabel: { type: String, default: '% of Library' },
        clickableRows: { type: Boolean, default: false }
    },
    data: function() {
        return { sortField: 'rank', sortDirection: 'asc' };
    },
    computed: {
        decoratedRows: function() {
            return this.rows.map((row, index) => ({
                rank: index + 1,
                label: row.label,
                personId: row.personId || null,
                image: row.image || null,
                largeImage: row.largeImage || null,
                total: row.total,
                watched: row.watched,
                unwatched: row.unwatched,
                watchedPercent: row.total ? (row.watched / row.total) * 100 : 0,
                libraryPercent: this.totalItems ? (row.total / this.totalItems) * 100 : 0
            }));
        },
        sortedRows: function() {
            const field = this.sortField;
            const direction = this.sortDirection === 'asc' ? 1 : -1;
            return [...this.decoratedRows].sort((a, b) => {
                let aVal = a[field];
                let bVal = b[field];
                if (field === 'label') {
                    return String(aVal).localeCompare(String(bVal), undefined, { numeric: true, sensitivity: 'base' }) * direction;
                }
                return (aVal - bVal) * direction;
            });
        },
        totals: function() {
            return this.rows.reduce((acc, row) => {
                acc.total += row.total;
                acc.watched += row.watched;
                acc.unwatched += row.unwatched;
                return acc;
            }, { total: 0, watched: 0, unwatched: 0 });
        }
    },
    methods: {
        sortBy: function(field) {
            if (this.sortField === field) {
                this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                this.sortField = field;
                // Text and rank read naturally ascending; counts are most useful largest-first
                this.sortDirection = (field === 'label' || field === 'rank') ? 'asc' : 'desc';
            }
        },
        sortClass: function(field) {
            if (this.sortField !== field) return '';
            return this.sortDirection === 'asc' ? 'sort-asc' : 'sort-desc';
        },
        formatNumber: function(value) {
            return Number(value).toLocaleString('en-us');
        },
        formatPercent: function(value) {
            return value.toFixed(1) + '%';
        },
        onRowClick: function(row) {
            if (this.clickableRows) {
                this.$emit('row-click', row);
            }
        },
        onRowContextMenu: function(event, row) {
            if (!row.personId) return;
            event.preventDefault();
            this.$emit('person-click', row.personId);
        },
        showImagePreview,
        hideImagePreview
    },
    template: `
        <div class="category-table-container">
            <p v-if="rows.length === 0" class="note">No data available</p>
            <table v-else class="comparison-table category-table">
                <thead>
                    <tr>
                        <th @click="sortBy('rank')" class="sortable numeric" :class="sortClass('rank')">#<span class="sort-arrow"></span></th>
                        <th @click="sortBy('label')" class="sortable" :class="sortClass('label')">{{ labelHeader }}<span class="sort-arrow"></span></th>
                        <th @click="sortBy('total')" class="sortable numeric" :class="sortClass('total')">Total<span class="sort-arrow"></span></th>
                        <th @click="sortBy('watched')" class="sortable numeric" :class="sortClass('watched')">Watched<span class="sort-arrow"></span></th>
                        <th @click="sortBy('unwatched')" class="sortable numeric" :class="sortClass('unwatched')">Unwatched<span class="sort-arrow"></span></th>
                        <th @click="sortBy('watchedPercent')" class="sortable numeric" :class="sortClass('watchedPercent')">% Watched<span class="sort-arrow"></span></th>
                        <th v-if="totalItems" @click="sortBy('libraryPercent')" class="sortable numeric" :class="sortClass('libraryPercent')" title="Share of the titles counted">{{ totalLabel }}<span class="sort-arrow"></span></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in sortedRows" :key="row.rank" :class="{ clickable: clickableRows }"
                        @click="onRowClick(row)" @contextmenu="onRowContextMenu($event, row)">
                        <td class="numeric rank">{{ row.rank }}</td>
                        <td class="label-cell">
                            <span class="label-hover" @mouseenter="showImagePreview($event, row.largeImage, row.label)" @mouseleave="hideImagePreview">
                                <img v-if="row.image" class="row-image" :src="row.image" alt="" loading="lazy" @error="$event.target.style.visibility = 'hidden'">
                                {{ row.label }}
                            </span>
                        </td>
                        <td class="numeric">{{ formatNumber(row.total) }}</td>
                        <td class="numeric">{{ formatNumber(row.watched) }}</td>
                        <td class="numeric">{{ formatNumber(row.unwatched) }}</td>
                        <td class="numeric">
                            <div class="watched-bar" :title="formatPercent(row.watchedPercent) + ' watched'">
                                <span :style="{ width: row.watchedPercent + '%' }"></span>
                            </div>
                            {{ formatPercent(row.watchedPercent) }}
                        </td>
                        <td v-if="totalItems" class="numeric">{{ formatPercent(row.libraryPercent) }}</td>
                    </tr>
                </tbody>
                <tfoot v-if="rows.length > 1">
                    <tr>
                        <td></td>
                        <td>Shown ({{ rows.length }})</td>
                        <td class="numeric">{{ formatNumber(totals.total) }}</td>
                        <td class="numeric">{{ formatNumber(totals.watched) }}</td>
                        <td class="numeric">{{ formatNumber(totals.unwatched) }}</td>
                        <td class="numeric">{{ formatPercent(totals.total ? (totals.watched / totals.total) * 100 : 0) }}</td>
                        <td v-if="totalItems"></td>
                    </tr>
                </tfoot>
            </table>
        </div>`
});
