const {
    SCHEME_A_RUNTIME_SETTING_KEYS,
    SCHEME_A_SECRET_SETTING_KEYS,
    getSchemeAConfig,
    getRecordingAccessConfig,
} = require('./featureFlagService');

const ADMIN_SETTINGS_GROUPS = [
    {
        key: 'basic',
        title: '基础设置',
        fields: [
            { key: 'scan_interval', label: '扫描间隔 (分钟)', type: 'number' },
            { key: 'auto_monitor_enabled', label: '自动监控', type: 'toggle' },
            { key: 'proxy_url', label: '代理地址', type: 'text' },
            { key: 'session_id', label: 'TikTok Session ID', type: 'text', secret: true },
            { key: 'port', label: '服务端口', type: 'number', restartRequired: true },
            { key: 'dynamic_tunnel_proxy', label: '动态隧道代理', type: 'text' },
            { key: 'proxy_api_url', label: '代理 API 地址', type: 'text' },
            { key: 'default_room_limit', label: '默认房间上限 (未订阅, -1 无限)', type: 'number' },
            { key: 'min_recharge_amount', label: '最低充值金额', type: 'number' },
            { key: 'site_name', label: '网站名称', type: 'text' },
            { key: 'gift_room_limit', label: '注册赠送房间数', type: 'number' },
            { key: 'gift_open_room_limit', label: '赠送可打开房间数', type: 'number' },
            { key: 'gift_duration_days', label: '注册赠送天数', type: 'number' },
        ],
    },
    {
        key: 'auth',
        title: '登录与安全',
        description: '登录相关配置会立即刷新当前 Web 进程。',
        fields: [
            { key: 'single_session_login_enabled', label: '单点登录（新登录踢掉旧登录）', type: 'toggle' },
        ],
    },
    {
        key: 'schemeAObs',
        title: '方案A / 观测',
        description: '控制结构化日志与关键指标输出。',
        fields: [
            { key: 'ENABLE_SCHEME_A_OBSERVABILITY', label: '启用方案A结构化日志与指标', type: 'toggle' },
        ],
    },
    {
        key: 'schemeARedis',
        title: '方案A / Redis 预留',
        description: '本轮只做配置管理，不额外推进 Redis 业务链路。',
        fields: [
            { key: 'REDIS_URL', label: 'Redis URL', type: 'password', secret: true },
            { key: 'ENABLE_REDIS_ROOM_CACHE', label: '启用房间缓存', type: 'toggle' },
            { key: 'ENABLE_REDIS_LIVE_STATE', label: '启用直播态缓存', type: 'toggle' },
        ],
    },
    {
        key: 'schemeARecordingWorker',
        title: '方案A / 录播上传 Worker',
        description: '保存后会刷新当前进程；若启用了守护，会按新配置重拉子 worker。',
        fields: [
            { key: 'ENABLE_RECORDING_UPLOAD', label: '启用录播上传', type: 'toggle' },
            { key: 'ENABLE_RECORDING_UPLOAD_DAEMON', label: '启用录播上传守护', type: 'toggle' },
            { key: 'RECORDING_UPLOAD_WORKER_POLL_MS', label: '上传轮询间隔 (ms)', type: 'number' },
            { key: 'RECORDING_UPLOAD_WORKER_BATCH_SIZE', label: '上传批大小', type: 'number' },
            { key: 'RECORDING_UPLOAD_DAEMON_RESTART_DELAY_MS', label: '守护重启延迟 (ms)', type: 'number' },
            { key: 'RECORDING_UPLOAD_DAEMON_MAX_RESTARTS', label: '守护最大重启次数 (0=不限)', type: 'number' },
            { key: 'ENABLE_RECORDING_LOCAL_CLEANUP', label: '启用本地临时文件清理', type: 'toggle' },
            { key: 'RECORDING_LOCAL_CLEANUP_DELAY_MS', label: '本地清理延迟 (ms)', type: 'number' },
            { key: 'RECORDING_LOCAL_CLEANUP_BATCH_SIZE', label: '本地清理批大小', type: 'number' },
            { key: 'ENABLE_WORKER_STATS', label: '启用统计 worker 预留开关', type: 'toggle' },
            { key: 'ENABLE_WORKER_MAINTENANCE', label: '启用维护 worker 预留开关', type: 'toggle' },
        ],
    },
    {
        key: 'schemeAObjectStorage',
        title: '方案A / 云存储',
        description: '对象存储改动会影响录播上传与下载地址；Access Key 留空表示保持现有值。',
        fields: [
            {
                key: 'OBJECT_STORAGE_PROVIDER',
                label: '对象存储协议',
                type: 'select',
                options: [
                    { value: 's3', label: 'S3 兼容' },
                    { value: 'oss', label: 'OSS / S3 兼容' },
                ],
            },
            { key: 'OSS_ENDPOINT', label: 'Endpoint', type: 'text', placeholder: 'https://oss-cn-hangzhou.aliyuncs.com' },
            { key: 'OSS_REGION', label: 'Region', type: 'text', placeholder: 'cn-hangzhou / auto' },
            { key: 'OSS_BUCKET', label: 'Bucket', type: 'text' },
            { key: 'OSS_ACCESS_KEY_ID', label: 'Access Key ID', type: 'password', secret: true },
            { key: 'OSS_ACCESS_KEY_SECRET', label: 'Access Key Secret', type: 'password', secret: true },
            { key: 'OSS_PUBLIC_BASE_URL', label: '公开访问基地址', type: 'text', placeholder: '留空则使用 endpoint + bucket' },
            { key: 'OSS_SIGNED_URL_TTL_SECS', label: '签名 URL TTL (秒)', type: 'number' },
        ],
    },
    {
        key: 'schemeARecordingAccess',
        title: '方案A / 录播访问',
        description: '录播下载 accessToken 配置；密钥留空表示保持现有值。',
        fields: [
            { key: 'RECORDING_ACCESS_TOKEN_SECRET', label: '录播访问 Token Secret', type: 'password', secret: true },
            { key: 'RECORDING_ACCESS_TOKEN_TTL_SECS', label: '录播访问 Token TTL (秒)', type: 'number' },
        ],
    },
    {
        key: 'schemeAFuture',
        title: '方案A / 后续预留',
        description: '仅配置面板接入，不代表本轮同步推进相应业务改造。',
        fields: [
            { key: 'EVENT_PARTITION_WRITE_MODE', label: '事件分区写入模式', type: 'text', placeholder: 'disabled' },
            { key: 'ENABLE_INCREMENTAL_STATS', label: '启用增量汇总预留开关', type: 'toggle' },
        ],
    },
];

const ADMIN_SETTINGS_FIELD_DEFS = ADMIN_SETTINGS_GROUPS.flatMap(group => group.fields);
const ADMIN_SETTINGS_FIELD_MAP = new Map(ADMIN_SETTINGS_FIELD_DEFS.map(field => [field.key, field]));
const ADMIN_EDITABLE_SETTING_KEYS = new Set(ADMIN_SETTINGS_FIELD_DEFS.map(field => field.key));
const ADMIN_SECRET_SETTING_KEYS = new Set(ADMIN_SETTINGS_FIELD_DEFS.filter(field => field.secret).map(field => field.key));

function getEffectiveRuntimeDefaults() {
    const schemeAConfig = getSchemeAConfig();
    const recordingAccess = getRecordingAccessConfig();

    return {
        ENABLE_SCHEME_A_OBSERVABILITY: schemeAConfig.observability.enabled,
        REDIS_URL: schemeAConfig.redis.url,
        ENABLE_REDIS_ROOM_CACHE: schemeAConfig.redis.enableRoomCache,
        ENABLE_REDIS_LIVE_STATE: schemeAConfig.redis.enableLiveState,
        ENABLE_WORKER_STATS: schemeAConfig.worker.enableStats,
        ENABLE_WORKER_MAINTENANCE: schemeAConfig.worker.enableMaintenance,
        ENABLE_RECORDING_UPLOAD: schemeAConfig.worker.enableRecordingUpload,
        ENABLE_RECORDING_UPLOAD_DAEMON: schemeAConfig.worker.enableRecordingUploadDaemon,
        ENABLE_RECORDING_LOCAL_CLEANUP: schemeAConfig.worker.enableRecordingLocalCleanup,
        RECORDING_UPLOAD_WORKER_POLL_MS: schemeAConfig.worker.recordingUploadPollMs,
        RECORDING_UPLOAD_WORKER_BATCH_SIZE: schemeAConfig.worker.recordingUploadBatchSize,
        RECORDING_UPLOAD_DAEMON_RESTART_DELAY_MS: schemeAConfig.worker.recordingUploadDaemonRestartDelayMs,
        RECORDING_UPLOAD_DAEMON_MAX_RESTARTS: schemeAConfig.worker.recordingUploadDaemonMaxRestarts,
        RECORDING_LOCAL_CLEANUP_DELAY_MS: schemeAConfig.worker.recordingLocalCleanupDelayMs,
        RECORDING_LOCAL_CLEANUP_BATCH_SIZE: schemeAConfig.worker.recordingLocalCleanupBatchSize,
        OBJECT_STORAGE_PROVIDER: schemeAConfig.objectStorage.provider,
        OSS_ENDPOINT: schemeAConfig.objectStorage.endpoint,
        OSS_REGION: schemeAConfig.objectStorage.region,
        OSS_BUCKET: schemeAConfig.objectStorage.bucket,
        OSS_ACCESS_KEY_ID: schemeAConfig.objectStorage.accessKeyId,
        OSS_ACCESS_KEY_SECRET: schemeAConfig.objectStorage.accessKeySecret,
        OSS_PUBLIC_BASE_URL: schemeAConfig.objectStorage.publicBaseUrl,
        OSS_SIGNED_URL_TTL_SECS: schemeAConfig.objectStorage.signedUrlTtlSecs,
        EVENT_PARTITION_WRITE_MODE: schemeAConfig.event.partitionWriteMode,
        ENABLE_INCREMENTAL_STATS: schemeAConfig.event.enableIncrementalStats,
        RECORDING_ACCESS_TOKEN_SECRET: recordingAccess.tokenSecret,
        RECORDING_ACCESS_TOKEN_TTL_SECS: recordingAccess.ttlSecs,
    };
}

function buildAdminSettingsResponse(allSettings = {}) {
    const effectiveDefaults = getEffectiveRuntimeDefaults();
    const settings = {};
    const secretConfigured = {};

    for (const field of ADMIN_SETTINGS_FIELD_DEFS) {
        const hasStoredValue = Object.prototype.hasOwnProperty.call(allSettings, field.key);
        const storedValue = hasStoredValue ? allSettings[field.key] : effectiveDefaults[field.key];

        if (field.secret) {
            secretConfigured[field.key] = Boolean(storedValue);
            settings[field.key] = '';
            continue;
        }

        settings[field.key] = storedValue !== undefined ? storedValue : '';
    }

    return {
        groups: ADMIN_SETTINGS_GROUPS,
        settings,
        secretConfigured,
    };
}

function normalizeAdminSettingValue(field, rawValue) {
    if (!field) return undefined;
    if (field.type === 'toggle') return rawValue === true || rawValue === 'true' || rawValue === 1 || rawValue === '1';
    if (rawValue === undefined || rawValue === null) return '';
    return String(rawValue);
}

function sanitizeAdminSettingsPayload(payload = {}) {
    const normalized = {};

    for (const [key, rawValue] of Object.entries(payload)) {
        if (!ADMIN_EDITABLE_SETTING_KEYS.has(key)) continue;
        const field = ADMIN_SETTINGS_FIELD_MAP.get(key);
        if (!field) continue;
        normalized[key] = normalizeAdminSettingValue(field, rawValue);
    }

    return normalized;
}

function shouldPreserveSecretSetting(key, value) {
    return ADMIN_SECRET_SETTING_KEYS.has(key) && (value === '' || value === null || value === undefined);
}

module.exports = {
    ADMIN_SETTINGS_GROUPS,
    ADMIN_SETTINGS_FIELD_DEFS,
    ADMIN_EDITABLE_SETTING_KEYS,
    ADMIN_SECRET_SETTING_KEYS,
    SCHEME_A_RUNTIME_SETTING_KEYS,
    SCHEME_A_SECRET_SETTING_KEYS,
    buildAdminSettingsResponse,
    sanitizeAdminSettingsPayload,
    shouldPreserveSecretSetting,
};
