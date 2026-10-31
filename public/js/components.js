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

// "Heat (1995)", or just the title when the year is unknown
const titleWithYear = (title, year) => (year ? `${title} (${year})` : title);

// Popup card for a title or person: its picture, a few lines of text, and links to its page and, for people in
// the current library, to filter by them. Hovering a name or picture shows it; clicking pins it until a click
// elsewhere, Esc or a scroll. One <info-popup> in index.html renders it, and the app fills in popupActions.
//
// spec: { kind: 'item' | 'person', id, image, lines: [name, ...details], filter?: { field, name } }
const popup = Vue.observable({ current: null });
const popupActions = {
    details: () => {},
    filter: () => {},
    canFilter: () => false
};
// A 200x300 picture, padding, a few lines of text and the links
const popupSize = { width: 218, height: 430 };
const popupGap = 12;

// Beside an element, flipped to its left near the window's right edge
const popupBeside = (element) => {
    const rect = element.getBoundingClientRect();
    const { width, height } = popupSize;
    const left = rect.right + popupGap + width <= window.innerWidth ? rect.right + popupGap : rect.left - popupGap - width;
    const top = rect.top + rect.height / 2 - height / 2;
    return popupClamped(left, top);
};

const popupClamped = (left, top) => ({
    left: Math.max(popupGap, Math.min(left, window.innerWidth - popupSize.width - popupGap)),
    top: Math.max(popupGap, Math.min(top, window.innerHeight - popupSize.height - popupGap))
});

const showPopup = (event, spec) => {
    if (!spec || (popup.current && popup.current.pinned)) return;
    popup.current = { ...spec, pinned: false, ...popupBeside(event.currentTarget || event.target) };
};

const hidePopup = () => {
    if (popup.current && !popup.current.pinned) popup.current = null;
};

// Pins the popup; when it is already showing for the same title or person it stays where it is
const pinPopup = (event, spec) => {
    if (!spec) return;
    const showing = popup.current && popup.current.kind === spec.kind && popup.current.id === spec.id;
    const place = showing ? { left: popup.current.left, top: popup.current.top } : popupBeside(event.currentTarget || event.target);
    popup.current = { ...spec, pinned: true, ...place };
};

// Pins the popup at a point on the screen, e.g. a clicked chart point
const pinPopupAt = (x, y, spec) => {
    if (!spec) return;
    popup.current = { ...spec, pinned: true, ...popupClamped(x + popupGap, y + popupGap) };
};

const closePopup = () => {
    popup.current = null;
};

// The popup is fixed to the window, so any scroll (of the page or a table) would leave it behind
window.addEventListener('scroll', closePopup, { capture: true, passive: true });
window.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePopup();
});

Vue.component('info-popup', {
    computed: {
        current: function() {
            return popup.current;
        },
        pinned: function() {
            return !!this.current && this.current.pinned;
        },
        canFilter: function() {
            return !!this.current && !!this.current.filter && popupActions.canFilter(this.current);
        }
    },
    watch: {
        // While pinned, a press anywhere outside the popup closes it
        pinned: function(pinned) {
            if (pinned) document.addEventListener('mousedown', this.onOutsidePress, true);
            else document.removeEventListener('mousedown', this.onOutsidePress, true);
        }
    },
    beforeDestroy: function() {
        document.removeEventListener('mousedown', this.onOutsidePress, true);
    },
    methods: {
        onOutsidePress: function(event) {
            if (!this.$el.contains || !this.$el.contains(event.target)) closePopup();
        },
        details: function() {
            const spec = this.current;
            closePopup();
            popupActions.details(spec);
        },
        filter: function() {
            const spec = this.current;
            closePopup();
            popupActions.filter(spec);
        }
    },
    template: `
        <div v-if="current" class="info-popup" :class="{ pinned: pinned }" :style="{ left: current.left + 'px', top: current.top + 'px' }">
            <img v-if="current.image" class="info-popup-image" :src="current.image" :alt="current.lines[0]" @error="$event.target.style.visibility = 'hidden'">
            <p v-for="(line, index) in current.lines" :key="index" :class="index === 0 ? 'info-popup-title' : 'info-popup-line'">{{ line }}</p>
            <div class="info-popup-actions">
                <a :href="'#/' + current.kind + '/' + current.id" @click.prevent="details">Details &rarr;</a>
                <a v-if="canFilter" href="javascript:void(0);" @click.prevent="filter">Filter</a>
            </div>
        </div>`
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
// rows: [{ label, total, watched, unwatched, personId?, image? }] in the order the chart displays them; image is
// a headshot URL shown beside the label. Clicking a row emits row-click. popupFor(row) gives the popup spec for a
// row's name, for rows of people; totalLabel heads the share-of-total column, e.g. "% of Library".
Vue.component('category-table', {
    props: {
        rows: { type: Array, default: () => [] },
        labelHeader: { type: String, default: 'Name' },
        totalItems: { type: Number, default: 0 },
        totalLabel: { type: String, default: '% of Library' },
        clickableRows: { type: Boolean, default: false },
        popupFor: { type: Function, default: null }
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
        rowPopup: function(row) {
            return this.popupFor && row.personId ? this.popupFor(row) : null;
        },
        // A person's name pins their popup instead of clicking the row
        onLabelClick: function(event, row) {
            const spec = this.rowPopup(row);
            if (!spec) return;
            event.stopPropagation();
            pinPopup(event, spec);
        },
        showPopup,
        hidePopup,
        pinPopup
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
                    <tr v-for="row in sortedRows" :key="row.rank" :class="{ clickable: clickableRows }" @click="onRowClick(row)">
                        <td class="numeric rank">{{ row.rank }}</td>
                        <td class="label-cell">
                            <span class="label-hover" :class="{ 'popup-trigger': rowPopup(row) }"
                                @mouseenter="showPopup($event, rowPopup(row))" @mouseleave="hidePopup"
                                @click="onLabelClick($event, row)">
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
