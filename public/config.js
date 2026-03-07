
// config.js

async function loadConfig() {
    try {
        const cfg = await $.get('/api/config');
        $('#cfg_interval').val(cfg.scan_interval || cfg.interval || 5);
        $('#cfg_autoMonitor').prop('checked', cfg.auto_monitor_enabled === 'true' || cfg.auto_monitor_enabled === true);
        $('#cfg_proxy').val(cfg.proxy_url || cfg.proxy || '');
        $('#cfg_eulerKeys').val(cfg.euler_keys || '');
        $('#cfg_sessionId').val(cfg.session_id || '');
        $('#cfg_port').val(cfg.port || '8081');
        $('#cfg_aiKey').val(cfg.ai_api_key || '');
        $('#cfg_aiUrl').val(cfg.ai_api_url || '');
        $('#cfg_aiModel').val(cfg.ai_model_name || '');
        $('#cfg_tunnelProxy').val(cfg.dynamic_tunnel_proxy || '');
        $('#cfg_proxyApiUrl').val(cfg.proxy_api_url || '');
    } catch (err) {
        console.error('Config load error', err);
        if (err.status === 401 || err.status === 403) {
            alert('您没有权限访问系统配置');
            if (typeof switchSection === 'function') {
                switchSection('roomList');
            }
        }
    }
}

async function saveConfig() {
    const data = {
        scan_interval: $('#cfg_interval').val(),
        auto_monitor_enabled: $('#cfg_autoMonitor').is(':checked'),
        proxy_url: $('#cfg_proxy').val(),
        euler_keys: $('#cfg_eulerKeys').val(),
        session_id: $('#cfg_sessionId').val(),
        port: $('#cfg_port').val(),
        ai_api_key: $('#cfg_aiKey').val(),
        ai_api_url: $('#cfg_aiUrl').val(),
        ai_model_name: $('#cfg_aiModel').val(),
        dynamic_tunnel_proxy: $('#cfg_tunnelProxy').val(),
        proxy_api_url: $('#cfg_proxyApiUrl').val()
    };

    try {
        await $.ajax({
            url: '/api/settings',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(data)
        });
        alert('配置已保存！(端口更改需要重启服务)');
    } catch (err) {
        let errorMsg = '保存配置失败';
        if (err.status === 401) {
            errorMsg = '您需要登录后才能保存配置';
        } else if (err.status === 403) {
            errorMsg = '您没有管理员权限，无法保存配置';
        } else if (err.responseJSON && err.responseJSON.error) {
            errorMsg = err.responseJSON.error;
        }
        alert(errorMsg);
    }
}

async function restartServer() {
    if (!confirm('这将停止 Node.js 进程。如果没有使用 pm2/supervisor 等进程管理器，您需要手动重新启动服务。确定继续吗？')) return;

    try {
        await $.post('/api/action/restart');
        alert('重启命令已发送。');
    } catch (e) {
        let errorMsg = '发送重启命令失败';
        if (e.status === 401) {
            errorMsg = '您需要登录后才能重启服务';
        } else if (e.status === 403) {
            errorMsg = '您没有管理员权限，无法重启服务';
        }
        alert(errorMsg);
    }
}

window.loadConfig = loadConfig;
window.saveConfig = saveConfig;
window.restartServer = restartServer;
