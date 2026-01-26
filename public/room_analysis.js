
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

    if (!start || !end) {
        alert('Please select both start and end dates');
        return;
    }

    try {
        const response = await fetch(`/api/analysis/rooms/entry?startDate=${start}&endDate=${end}`);
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

    // Prepare data
    // data is array of { roomId, roomName, count }
    // Sort by count desc (should already be sorted by API, but double check)
    // For horizontal bar chart, we usually want top items at top, so index 0 = top.

    const labels = data.map(item => item.roomName || item.roomId);
    const counts = data.map(item => item.count);

    roomAnalysisChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Total Entries (Members)',
                data: counts,
                backgroundColor: 'rgba(54, 162, 235, 0.7)',
                borderColor: 'rgba(54, 162, 235, 1)',
                borderWidth: 1
            }]
        },
        options: {
            indexAxis: 'y', // Horizontal bar chart
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                },
                title: {
                    display: true,
                    text: 'Room Entry Analysis'
                }
            },
            scales: {
                x: {
                    beginAtZero: true
                }
            }
        }
    });
}

// Hook into app initialization if needed, or call initRoomAnalysis when section is shown
// For now, we can expose it globally
window.initRoomAnalysis = initRoomAnalysis;
window.fetchAndRenderRoomStats = fetchAndRenderRoomStats;
