// gift_config.js - Gift Configuration Management

// Tab switching for config section
function switchConfigTab(tab) {
    // Toggle tab buttons
    $('#section-systemConfig .sub-nav-btn').removeClass('active btn-active');
    $(`#section-systemConfig .sub-nav-btn[onclick="switchConfigTab('${tab}')"]`).addClass('active btn-active');

    // Toggle tab content
    $('.config-tab-content').addClass('hidden');
    $(`#configTab-${tab}`).removeClass('hidden');

    // Load gift config when switching to gifts tab
    if (tab === 'gifts') {
        loadGiftConfig();
    }
}

// Load and render gift configuration
async function loadGiftConfig() {
    try {
        const gifts = await $.get('/api/gifts');
        const tbody = $('#giftConfigTable tbody');
        tbody.empty();

        $('#giftCount').text(gifts.length);

        if (gifts.length === 0) {
            tbody.append('<tr><td colspan="4" class="text-center opacity-50">暂无礼物数据，开启直播监控后会自动采集</td></tr>');
            return;
        }

        gifts.forEach(g => {
            const icon = g.iconUrl
                ? `<img src="${g.iconUrl}" class="w-8 h-8 rounded" alt="${g.nameEn}" onerror="this.src=''">`
                : '🎁';

            tbody.append(`
                <tr>
                    <td class="text-center">${icon}</td>
                    <td class="font-mono text-sm">${g.nameEn || '-'}</td>
                    <td>
                        <input type="text" 
                            class="input input-bordered input-sm w-full max-w-xs gift-name-input" 
                            data-gift-id="${g.giftId}"
                            value="${g.nameCn || ''}" 
                            placeholder="输入中文名..."
                        >
                    </td>
                    <td class="text-right font-mono text-warning">💎 ${(g.diamondCount || 0).toLocaleString()}</td>
                </tr>
            `);
        });

        // Bind save events
        $('.gift-name-input').off('blur keydown').on('blur', saveGiftName).on('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveGiftName.call(this);
            }
        });

    } catch (err) {
        console.error('Failed to load gift config:', err);
        $('#giftConfigTable tbody').html('<tr><td colspan="4" class="text-center text-error">加载失败</td></tr>');
    }
}

// Save gift Chinese name
async function saveGiftName() {
    const input = $(this);
    const giftId = input.data('gift-id');
    const nameCn = input.val().trim();

    try {
        await $.ajax({
            url: `/api/gifts/${encodeURIComponent(giftId)}`,
            method: 'PUT',
            contentType: 'application/json',
            data: JSON.stringify({ nameCn })
        });

        // Visual feedback
        input.addClass('input-success');
        setTimeout(() => input.removeClass('input-success'), 1000);
    } catch (err) {
        console.error('Failed to save gift name:', err);
        input.addClass('input-error');
        setTimeout(() => input.removeClass('input-error'), 2000);
    }
}

// Global exports
window.switchConfigTab = switchConfigTab;
window.loadGiftConfig = loadGiftConfig;
