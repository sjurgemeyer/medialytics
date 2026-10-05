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

const castCrewMixin = {
    data: function() {
        return {
            yearRatingStats: emptyYearRatingStats()
        };
    },
    watch: {
        // selectedLibraryStats is replaced once a library has been fully parsed
        selectedLibraryStats: function() {
            this.$nextTick(() => {
                this.renderYearRatingChart();
            });
        }
    },
    methods: {
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
