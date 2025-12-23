
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
        alert('Configuration saved! (Port change requires restart)');
    } catch (err) {
        alert('Error saving config: ' + (err.responseJSON ? err.responseJSON.error : err.statusText));
    }
}

async function restartServer() {
    if (!confirm('This will stop the Node.js process. You may need to manually start it again if not running with pm2/supervisor. Continue?')) return;

    try {
        await $.post('/api/action/restart');
        alert('Restart command sent.');
    } catch (e) {
        alert('Error sending restart command');
    }
}
