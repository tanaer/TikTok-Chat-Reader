
let roomAnalysisChart = null;

function initRoomAnalysis() {
    // 默认日期：最近7天
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    document.getElementById('ra_endDate').valueAsDate = endDate;
    document.getElementById('ra_startDate').valueAsDate = startDate;

    // 初始加载
    fetchAndRenderRoomStats();
}

async function fetchAndRenderRoomStats() {
    const start = document.getElementById('ra_startDate').value;
    const end = document.getElementById('ra_endDate').value;
    const limit = document.getElementById('ra_limit').value || 100;

    if (!start || !end) {
        alert('请选择开始和结束日期');
        return;
    }

    try {
        const response = await fetch(`/api/analysis/rooms/entry?startDate=${start}&endDate=${end}&limit=${limit}`, {
            headers: { 'Authorization': 'Bearer ' + (Auth.getAccessToken() || '') }
        });
        const data = await response.json();

        if (data.error) {
            alert('获取数据失败: ' + data.error);
            return;
        }

        renderRoomAnalysisChart(data);
    } catch (e) {
        console.error('请求失败:', e);
        alert('获取数据失败');
    }
}

function renderRoomAnalysisChart(data) {
    const ctx = document.getElementById('roomAnalysisChart');
    if (!ctx) return;

    if (roomAnalysisChart) {
        roomAnalysisChart.destroy();
    }

    const newHeight = Math.max(600, data.length * 30 + 100);
    ctx.parentElement.style.height = `${newHeight}px`;

    const labels = data.map(item => `${item.roomName} (${item.roomId})`);
    const counts = data.map(item => item.count);
    const dailyRevenues = data.map(item => item.dailyAvg);

    roomAnalysisChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: '总进场人次',
                    data: counts,
                    backgroundColor: 'rgba(54, 162, 235, 0.7)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1,
                    xAxisID: 'x',
                    order: 2
                },
                {
                    label: '日均礼物收入(钻石)',
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
            indexAxis: 'y',
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
                    text: `房间进场分析与收入对比 (Top ${data.length})`
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
                    title: { display: true, text: '进场人次' },
                    grid: { drawOnChartArea: true }
                },
                x1: {
                    type: 'linear',
                    display: true,
                    position: 'top',
                    title: { display: true, text: '日均收入(钻石)' },
                    grid: { drawOnChartArea: false },
                    ticks: { color: 'rgba(255, 99, 132, 1)' }
                },
                y: {
                    ticks: { autoSkip: false }
                }
            }
        }
    });
}

window.initRoomAnalysis = initRoomAnalysis;
window.fetchAndRenderRoomStats = fetchAndRenderRoomStats;
