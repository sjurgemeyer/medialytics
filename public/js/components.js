// Shared Vue components for the MediaData page. Loaded before app.js.

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

// Sortable table view of a category breakdown.
// rows: [{ label, total, watched, unwatched, image? }] in the order the chart displays them; image is a
// headshot URL shown beside the label.
Vue.component('category-table', {
    props: {
        rows: { type: Array, default: () => [] },
        labelHeader: { type: String, default: 'Name' },
        totalItems: { type: Number, default: 0 },
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
        }
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
                        <th v-if="totalItems" @click="sortBy('libraryPercent')" class="sortable numeric" :class="sortClass('libraryPercent')" title="Share of all items in the library">% of Library<span class="sort-arrow"></span></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in sortedRows" :key="row.rank" :class="{ clickable: clickableRows }" @click="onRowClick(row)">
                        <td class="numeric rank">{{ row.rank }}</td>
                        <td class="label-cell">
                            <img v-if="row.image" class="row-image" :src="row.image" alt="" loading="lazy" @error="$event.target.style.visibility = 'hidden'">
                            {{ row.label }}
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
