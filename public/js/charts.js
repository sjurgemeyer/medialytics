// Plotly chart rendering for the MediaData page. Each function draws into the element with the given id.

const chartPalette = {
    watched: '#D62828',
    unwatched: '#FC9803',
    accent: '#F77F00',
    line: '#FCBF49',
    grid: '#888',
    text: '#fff',
    // Repeating palette for pie slices
    slices: ['#D62828', '#FC9803', '#F77F00', '#FCBF49', '#EAE2B7']
};

const baseLayout = () => ({
    margin: { pad: 10 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: chartPalette.text },
    modebar: { color: '#f2f2f2', activecolor: chartPalette.accent }
});

const baseConfig = {
    responsive: true,
    displaylogo: false,
    displayModeBar: true,
    modeBarButtonsToRemove: ['lasso2d', 'toImage']
};

// Stacked watched / unwatched bars, one per category
const renderStackedBarChart = (elementId, rows, { shortLabels = false, showLegend = false } = {}) => {
    const labels = rows.map(row => row.label);
    const hover = (count, kind) => rows.map((row, index) => `${labels[index]}<br />${count[index]} / ${row.total} ${kind}`);
    const watched = rows.map(row => row.watched);
    const unwatched = rows.map(row => row.unwatched);
    const data = [
        { x: labels, y: watched, name: 'Watched', type: 'bar', marker: { color: chartPalette.watched }, hoverinfo: 'text', textposition: 'none', text: hover(watched, 'Watched') },
        { x: labels, y: unwatched, name: 'Unwatched', type: 'bar', marker: { color: chartPalette.unwatched }, hoverinfo: 'text', textposition: 'none', text: hover(unwatched, 'Unwatched') }
    ];
    const layout = {
        ...baseLayout(),
        barmode: 'stack',
        showlegend: showLegend,
        xaxis: { type: 'category', tickangle: shortLabels ? 0 : 30, automargin: true }
    };
    return Plotly.newPlot(elementId, data, layout, baseConfig);
};

const renderPieChart = (elementId, rows) => {
    const data = [{
        values: rows.map(row => row.total),
        labels: rows.map(row => row.label),
        type: 'pie',
        hoverinfo: 'label+value+percent',
        textinfo: 'none',
        marker: { colors: chartPalette.slices }
    }];
    return Plotly.newPlot(elementId, data, baseLayout(), { ...baseConfig, displayModeBar: false });
};

// Scatter of watched / unwatched points; points: [{ x, y, text, watched }]
const renderWatchedScatter = (elementId, points, { xTitle, yTitle, xRange, yRange, extraTraces = [] }) => {
    const trace = (subset, name, color) => ({
        x: subset.map(point => point.x),
        y: subset.map(point => point.y),
        text: subset.map(point => point.text),
        name,
        mode: 'markers',
        type: 'scatter',
        hoverinfo: 'text',
        marker: { size: 6, color, opacity: 0.8 }
    });
    const axis = (title, range) => ({ title, range, gridcolor: chartPalette.grid, showgrid: true, zeroline: false });
    const data = extraTraces.concat([
        trace(points.filter(point => !point.watched), 'Unwatched', chartPalette.unwatched),
        trace(points.filter(point => point.watched), 'Watched', chartPalette.watched)
    ]);
    const layout = { ...baseLayout(), showlegend: false, hovermode: 'closest', xaxis: axis(xTitle, xRange), yaxis: axis(yTitle, yRange) };
    return Plotly.newPlot(elementId, data, layout, baseConfig);
};

// Cumulative total (left axis) and daily additions (right axis) over time
const renderAdditionsChart = (elementId, { dates, daily, cumulative }) => {
    const data = [
        { x: dates, y: cumulative, type: 'scatter', mode: 'lines', name: 'Cumulative Total', line: { color: chartPalette.watched, width: 2 }, hovertemplate: '%{x}<br>Total: %{y}<extra></extra>', yaxis: 'y' },
        { x: dates, y: daily, type: 'scatter', mode: 'lines', name: 'Daily Additions', line: { color: chartPalette.line, width: 2 }, hovertemplate: '%{x}<br>Added: %{y}<extra></extra>', yaxis: 'y2' }
    ];
    const layout = {
        ...baseLayout(),
        showlegend: true,
        legend: { x: 0, y: 1.2, bgcolor: 'transparent', bordercolor: chartPalette.grid, borderwidth: 1 },
        margin: { pad: 10, r: 80 },
        xaxis: { title: 'Date', gridcolor: chartPalette.grid, showgrid: false, type: 'date' },
        yaxis: { title: 'Cumulative Total', gridcolor: chartPalette.grid, showgrid: true, zeroline: true, side: 'left' },
        yaxis2: { title: 'Daily Additions', gridcolor: chartPalette.grid, showgrid: false, zeroline: true, overlaying: 'y', side: 'right' }
    };
    return Plotly.newPlot(elementId, data, layout, baseConfig);
};

const clearChart = (elementId) => {
    const element = document.getElementById(elementId);
    if (element) Plotly.purge(element);
};
