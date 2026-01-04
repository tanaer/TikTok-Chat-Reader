// proxy_config.js - Simplified proxy management with node groups
// Sing-Box is internally managed, user only inputs nodes and views their status

// ==================== Node Groups ====================

async function loadNodeGroups() {
    try {
        const groups = await $.get('/api/proxy/groups');
        const container = $('#nodeGroupList');
        container.empty();

        if (!groups || groups.length === 0) {
            container.html('<div class="text-center opacity-50 py-4">暂无节点组，请添加</div>');
            $('#nodeGroupSummary').text('共 0 个组');
            return;
        }

        groups.forEach(group => {
            container.append(`
                <div class="flex items-center justify-between p-3 bg-base-200 rounded-lg" data-group-id="${group.id}">
                    <div class="flex-1">
                        <div class="font-bold">${group.name}</div>
                        <div class="text-xs opacity-50">${group.nodeCount || 0} 个节点</div>
                    </div>
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-ghost" onclick="editNodeGroup(${group.id})" title="编辑">✏️</button>
                        <button class="btn btn-xs btn-ghost text-error" onclick="deleteNodeGroup(${group.id})" title="删除">🗑️</button>
                    </div>
                </div>
            `);
        });

        $('#nodeGroupSummary').text(`共 ${groups.length} 个组`);
    } catch (e) {
        console.error('Failed to load node groups:', e);
    }
}

async function saveNodeGroup() {
    const id = $('#editNodeGroupId').val();
    const name = $('#nodeGroupName').val().trim();
    const content = $('#nodeGroupContent').val().trim();

    if (!name) {
        alert('请输入组名称');
        return;
    }
    if (!content) {
        alert('请输入节点配置');
        return;
    }

    try {
        const result = await $.ajax({
            url: id ? `/api/proxy/groups/${id}` : '/api/proxy/groups',
            type: id ? 'PUT' : 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ name, content })
        });

        if (result.success) {
            alert(id ? '节点组已更新' : `成功添加 ${result.nodeCount || 0} 个节点`);
            resetNodeGroupForm();
            loadNodeGroups();
            loadProxyNodes();
            // Auto-regenerate sing-box config
            internalSingboxRefresh();
        } else {
            alert('保存失败: ' + (result.error || '未知错误'));
        }
    } catch (e) {
        alert('保存失败: ' + (e.responseJSON?.error || e.statusText));
    }
}

async function editNodeGroup(id) {
    try {
        const group = await $.get(`/api/proxy/groups/${id}`);
        if (group) {
            $('#editNodeGroupId').val(group.id);
            $('#nodeGroupName').val(group.name);
            $('#nodeGroupContent').val(group.content || '');
            $('#nodeGroupFormTitle').text('编辑节点组');
        }
    } catch (e) {
        alert('加载失败: ' + (e.responseJSON?.error || e.statusText));
    }
}

async function deleteNodeGroup(id) {
    if (!confirm('确定要删除该节点组及其所有节点吗?')) return;

    try {
        await $.ajax({
            url: `/api/proxy/groups/${id}`,
            type: 'DELETE'
        });
        loadNodeGroups();
        loadProxyNodes();
        internalSingboxRefresh();
    } catch (e) {
        alert('删除失败: ' + (e.responseJSON?.error || e.statusText));
    }
}

function resetNodeGroupForm() {
    $('#editNodeGroupId').val('');
    $('#nodeGroupName').val('');
    $('#nodeGroupContent').val('');
    $('#nodeGroupFormTitle').text('添加节点组');
}

// ==================== Nodes ====================

async function loadProxyNodes() {
    try {
        const nodes = await $.get('/api/proxy/nodes');
        const container = $('#proxyNodeList');
        container.empty();

        if (!nodes || nodes.length === 0) {
            container.html('<tr><td colspan="7" class="text-center opacity-50 py-4">暂无节点</td></tr>');
            $('#proxyNodeSummary').text('共 0 个节点');
            return;
        }

        nodes.forEach(node => {
            const eulerBadge = getStatusBadge(node.eulerStatus, node.eulerLatency);
            const tiktokBadge = getStatusBadge(node.tiktokStatus, node.tiktokLatency);

            container.append(`
                <tr class="hover" data-node-id="${node.id}">
                    <td class="text-xs opacity-60">${node.groupName || '-'}</td>
                    <td class="truncate max-w-[100px]" title="${node.name}">${node.name || node.server}</td>
                    <td><span class="badge badge-xs badge-outline">${node.type}</span></td>
                    <td class="text-xs font-mono">${node.server}:${node.port}</td>
                    <td>${eulerBadge}</td>
                    <td>${tiktokBadge}</td>
                    <td class="flex gap-1">
                        <button class="btn btn-xs btn-ghost" onclick="testProxyNode(${node.id})" title="测试节点">🔍</button>
                        <button class="btn btn-xs btn-ghost text-error" onclick="deleteProxyNode(${node.id})" title="删除节点">🗑️</button>
                    </td>
                </tr>
            `);
        });

        const okCount = nodes.filter(n => n.eulerStatus === 'ok' && n.tiktokStatus === 'ok').length;
        $('#proxyNodeSummary').text(`共 ${nodes.length} 个节点，${okCount} 个可用`);
    } catch (e) {
        console.error('Failed to load nodes:', e);
    }
}

function getStatusBadge(status, latency) {
    if (status === 'ok') {
        return `<span class="badge badge-success badge-sm">✓ ${latency}ms</span>`;
    } else if (status === 'blocked') {
        return `<span class="badge badge-error badge-sm">✗ 封禁</span>`;
    } else {
        return `<span class="badge badge-ghost badge-sm">? 未测</span>`;
    }
}

async function testProxyNode(id) {
    try {
        const row = $(`tr[data-node-id="${id}"]`);
        const btn = row.find('button:first'); // Only the first button (test button)
        btn.prop('disabled', true).text('...');

        const result = await $.ajax({
            url: `/api/proxy/nodes/${id}/test`,
            type: 'POST',
            timeout: 60000 // Increased timeout for isolated testing
        });

        // Update row directly without full reload
        if (result.euler) {
            row.find('td:eq(4)').html(getStatusBadge(result.euler.status, result.euler.latency));
        }
        if (result.tiktok) {
            row.find('td:eq(5)').html(getStatusBadge(result.tiktok.status, result.tiktok.latency));
        }
        btn.prop('disabled', false).text('🔍');
    } catch (e) {
        console.error('Test failed:', e);
        const row = $(`tr[data-node-id="${id}"]`);
        row.find('button:first').prop('disabled', false).text('🔍');
    }
}

async function testAllProxyNodes() {
    if (!confirm('将测试所有节点，可能需要较长时间，确定继续?')) return;

    try {
        $('#testAllBtn').prop('disabled', true).text('测试中...');
        await $.ajax({
            url: '/api/proxy/nodes/test-all',
            type: 'POST',
            timeout: 120000
        });
        loadProxyNodes();
    } catch (e) {
        console.error('Batch test failed:', e);
        loadProxyNodes();
    } finally {
        $('#testAllBtn').prop('disabled', false).text('🔍 测试所有节点');
    }
}

async function deleteProxyNode(id) {
    if (!confirm('确定要删除该节点吗?')) return;

    try {
        await $.ajax({
            url: `/api/proxy/nodes/${id}`,
            type: 'DELETE'
        });
        loadProxyNodes();
        loadNodeGroups();
    } catch (e) {
        alert('删除失败: ' + (e.responseJSON?.error || e.statusText));
    }
}

// ==================== Sing-Box (Internal Management) ====================

async function loadSingboxStatus() {
    try {
        const status = await $.get('/api/singbox/status');
        const badge = $('#singboxStatus');

        if (status.isRunning) {
            badge.removeClass('badge-ghost badge-error badge-warning').addClass('badge-success').text('运行中');
            $('#singboxInfo').html(`版本: ${status.version || '未知'} | 代理: <code>socks5://127.0.0.1:${status.port}</code>`);
        } else if (status.binaryInstalled) {
            badge.removeClass('badge-success badge-error badge-warning').addClass('badge-ghost').text('已安装');
            $('#singboxInfo').text(`版本: ${status.version || '未知'} | 待启动`);
        } else {
            badge.removeClass('badge-ghost badge-success').addClass('badge-warning').text('未安装');
            $('#singboxInfo').html('正在自动下载安装中...');
        }
    } catch (e) {
        console.error('Failed to load singbox status:', e);
        $('#singboxStatus').removeClass('badge-success badge-warning').addClass('badge-error').text('错误');
        $('#singboxInfo').text('无法获取状态');
    }
}

async function singboxUpgrade() {
    if (!confirm('将从 GitHub 下载最新版本 sing-box，确定继续?')) return;

    try {
        $('#singboxStatus').text('升级中...');
        const result = await $.post('/api/singbox/upgrade');
        if (result.success) {
            alert(`升级成功! 版本: ${result.version || '最新版'}`);
        } else {
            alert('升级失败: ' + (result.error || '未知错误'));
        }
        loadSingboxStatus();
    } catch (e) {
        alert('升级失败: ' + (e.responseJSON?.error || e.statusText));
        loadSingboxStatus();
    }
}

// Internal function to auto-manage sing-box
async function internalSingboxRefresh() {
    try {
        // Auto-generate config and restart if nodes changed
        await $.post('/api/singbox/refresh');
    } catch (e) {
        console.error('Singbox refresh failed:', e);
    }
}

// ==================== Initialization ====================

function initProxyConfig() {
    loadSingboxStatus();
    loadNodeGroups();
    loadProxyNodes();
}

// Global exports
window.loadNodeGroups = loadNodeGroups;
window.saveNodeGroup = saveNodeGroup;
window.editNodeGroup = editNodeGroup;
window.deleteNodeGroup = deleteNodeGroup;
window.resetNodeGroupForm = resetNodeGroupForm;
window.loadProxyNodes = loadProxyNodes;
window.testProxyNode = testProxyNode;
window.testAllProxyNodes = testAllProxyNodes;
window.deleteProxyNode = deleteProxyNode;
window.loadSingboxStatus = loadSingboxStatus;
window.singboxUpgrade = singboxUpgrade;
window.initProxyConfig = initProxyConfig;
