
let roomAnalysisChart = null;

function initRoomAnalysis() {
    // Set default dates: Last 7 days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    document.getElementById('ra_endDate').valueAsDate = endDate;
    document.getElementById('ra_startDate').valueAsDate = startDate;

    // Initial load
    fetchAndRenderRoomStats();
}

async function fetchAndRenderRoomStats() {
    const start = document.getElementById('ra_startDate').value;
    const end = document.getElementById('ra_endDate').value;
    const limit = document.getElementById('ra_limit').value || 100;

    if (!start || !end) {
        alert('Please select both start and end dates');
        return;
    }

    try {
        const response = await fetch(`/api/analysis/rooms/entry?startDate=${start}&endDate=${end}&limit=${limit}`);
        const data = await response.json();

        if (data.error) {
            alert('Error fetching data: ' + data.error);
            return;
        }

        renderRoomAnalysisChart(data);
    } catch (e) {
        console.error('Fetch error:', e);
        alert('Failed to fetch data');
    }
}

function renderRoomAnalysisChart(data) {
    const ctx = document.getElementById('roomAnalysisChart');
    if (!ctx) return;

    // Destroy existing chart if any
    if (roomAnalysisChart) {
        roomAnalysisChart.destroy();
    }

    // Adjust container height based on data length
    const newHeight = Math.max(600, data.length * 30 + 100);
    ctx.parentElement.style.height = `${newHeight}px`;

    // Prepare data
    const labels = data.map(item => `${item.roomName} (${item.roomId})`);
    const counts = data.map(item => item.count);
    const dailyRevenues = data.map(item => item.dailyAvg);

    roomAnalysisChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Total Entries (Members)',
                    data: counts,
                    backgroundColor: 'rgba(54, 162, 235, 0.7)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1,
                    xAxisID: 'x',
                    order: 2
                },
                {
                    label: 'Daily Avg Revenue (Diamonds)',
                    data: dailyRevenues,
                    backgroundColor: 'rgba(255, 99, 132, 0.7)',
                    borderColor: 'rgba(255, 99, 132, 1)',
                    borderWidth: 1,
                    xAxisID: 'x1',
                    order: 1
                }
            ]
        },
        options: {
            indexAxis: 'y', // Horizontal bar chart
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: { position: 'top' },
                title: {
                    display: true,
                    text: `Room Entry Analysis & Revenue (Top ${data.length})`
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.x !== null) {
                                label += context.parsed.x.toLocaleString();
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    display: true,
                    position: 'bottom',
                    title: { display: true, text: 'Entries' },
                    grid: { drawOnChartArea: true }
                },
                x1: {
                    type: 'linear',
                    display: true,
                    position: 'top',
                    title: { display: true, text: 'Revenue (Diamonds)' },
                    grid: { drawOnChartArea: false }, // Avoid grid clutter
                    ticks: { color: 'rgba(255, 99, 132, 1)' }
                },
                y: {
                    ticks: { autoSkip: false }
                }
            }
        }
    });
}

// Hook into app initialization if needed, or call initRoomAnalysis when section is shown
// For now, we can expose it globally
window.initRoomAnalysis = initRoomAnalysis;
window.fetchAndRenderRoomStats = fetchAndRenderRoomStats;
