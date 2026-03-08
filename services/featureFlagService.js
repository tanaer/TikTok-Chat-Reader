const SCHEME_A_RUNTIME_SETTING_KEYS = [
    'ENABLE_SCHEME_A_OBSERVABILITY',
    'REDIS_URL',
    'ENABLE_REDIS_ROOM_CACHE',
    'ENABLE_REDIS_LIVE_STATE',
    'ENABLE_WORKER_STATS',
    'ENABLE_WORKER_MAINTENANCE',
    'ENABLE_RECORDING_UPLOAD',
    'ENABLE_RECORDING_UPLOAD_DAEMON',
    'ENABLE_RECORDING_LOCAL_CLEANUP',
    'RECORDING_UPLOAD_WORKER_POLL_MS',
    'RECORDING_UPLOAD_WORKER_BATCH_SIZE',
    'RECORDING_UPLOAD_DAEMON_RESTART_DELAY_MS',
    'RECORDING_UPLOAD_DAEMON_MAX_RESTARTS',
    'RECORDING_LOCAL_CLEANUP_DELAY_MS',
    'RECORDING_LOCAL_CLEANUP_BATCH_SIZE',
    'OBJECT_STORAGE_PROVIDER',
    'OSS_ENDPOINT',
    'OSS_REGION',
    'OSS_BUCKET',
    'OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_SECRET',
    'OSS_PUBLIC_BASE_URL',
    'OSS_SIGNED_URL_TTL_SECS',
    'EVENT_PARTITION_WRITE_MODE',
    'ENABLE_INCREMENTAL_STATS',
    'RECORDING_ACCESS_TOKEN_SECRET',
    'RECORDING_ACCESS_TOKEN_TTL_SECS',
];

const SCHEME_A_SECRET_SETTING_KEYS = [
    'REDIS_URL',
    'OSS_ACCESS_KEY_ID',
    'OSS_ACCESS_KEY_SECRET',
    'RECORDING_ACCESS_TOKEN_SECRET',
];

let runtimeSettingOverrides = {};

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseBooleanEnv(value, defaultValue = false) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return defaultValue;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return defaultValue;
}

function parseIntegerValue(value, defaultValue, options = {}) {
    const { min = null, max = null } = options;
    const parsed = parseInt(value === undefined || value === null || String(value).trim() === '' ? `${defaultValue}` : `${value}`, 10);

    let result = Number.isFinite(parsed) ? parsed : defaultValue;
    if (min !== null && result < min) result = min;
    if (max !== null && result > max) result = max;
    return result;
}

function parseIntegerEnv(name, defaultValue, options = {}) {
    return parseIntegerValue(process.env[name], defaultValue, options);
}

function getRawRuntimeSetting(key, fallback = '') {
    if (hasOwn(runtimeSettingOverrides, key)) {
        return runtimeSettingOverrides[key];
    }
    const envValue = process.env[key];
    return envValue === undefined ? fallback : envValue;
}

function setRuntimeSettingOverrides(nextSettings = {}) {
    const normalized = {};
    for (const key of SCHEME_A_RUNTIME_SETTING_KEYS) {
        if (hasOwn(nextSettings, key)) {
            normalized[key] = nextSettings[key];
        }
    }
    runtimeSettingOverrides = normalized;
    return runtimeSettingOverrides;
}

async function refreshRuntimeSettingsFromDb(dbModule) {
    if (!dbModule || typeof dbModule.getSystemSettings !== 'function') {
        throw new Error('dbModule.getSystemSettings is required');
    }
    const settings = await dbModule.getSystemSettings();
    setRuntimeSettingOverrides(settings || {});
    return getSchemeAConfig();
}

function getSchemeAConfig() {
    const objectStorageProvider = String(getRawRuntimeSetting('OBJECT_STORAGE_PROVIDER', 's3') || 's3').trim().toLowerCase();

    return {
        observability: {
            enabled: parseBooleanEnv(getRawRuntimeSetting('ENABLE_SCHEME_A_OBSERVABILITY'), false),
        },
        redis: {
            url: String(getRawRuntimeSetting('REDIS_URL', '') || ''),
            enableRoomCache: parseBooleanEnv(getRawRuntimeSetting('ENABLE_REDIS_ROOM_CACHE'), false),
            enableLiveState: parseBooleanEnv(getRawRuntimeSetting('ENABLE_REDIS_LIVE_STATE'), false),
        },
        worker: {
            enableStats: parseBooleanEnv(getRawRuntimeSetting('ENABLE_WORKER_STATS'), false),
            enableMaintenance: parseBooleanEnv(getRawRuntimeSetting('ENABLE_WORKER_MAINTENANCE'), false),
            enableRecordingUpload: parseBooleanEnv(getRawRuntimeSetting('ENABLE_RECORDING_UPLOAD'), false),
            enableRecordingUploadDaemon: parseBooleanEnv(getRawRuntimeSetting('ENABLE_RECORDING_UPLOAD_DAEMON'), false),
            enableRecordingLocalCleanup: parseBooleanEnv(getRawRuntimeSetting('ENABLE_RECORDING_LOCAL_CLEANUP'), false),
            recordingUploadPollMs: parseIntegerValue(getRawRuntimeSetting('RECORDING_UPLOAD_WORKER_POLL_MS'), 10000, { min: 1000 }),
            recordingUploadBatchSize: parseIntegerValue(getRawRuntimeSetting('RECORDING_UPLOAD_WORKER_BATCH_SIZE'), 5, { min: 1, max: 100 }),
            recordingUploadDaemonRestartDelayMs: parseIntegerValue(getRawRuntimeSetting('RECORDING_UPLOAD_DAEMON_RESTART_DELAY_MS'), 5000, { min: 1000 }),
            recordingUploadDaemonMaxRestarts: parseIntegerValue(getRawRuntimeSetting('RECORDING_UPLOAD_DAEMON_MAX_RESTARTS'), 0, { min: 0 }),
            recordingLocalCleanupDelayMs: parseIntegerValue(getRawRuntimeSetting('RECORDING_LOCAL_CLEANUP_DELAY_MS'), 3600000, { min: 0 }),
            recordingLocalCleanupBatchSize: parseIntegerValue(getRawRuntimeSetting('RECORDING_LOCAL_CLEANUP_BATCH_SIZE'), 10, { min: 1, max: 100 }),
        },
        objectStorage: {
            provider: objectStorageProvider,
            endpoint: String(getRawRuntimeSetting('OSS_ENDPOINT', '') || ''),
            region: String(getRawRuntimeSetting('OSS_REGION', '') || ''),
            bucket: String(getRawRuntimeSetting('OSS_BUCKET', '') || ''),
            accessKeyId: String(getRawRuntimeSetting('OSS_ACCESS_KEY_ID', '') || ''),
            accessKeySecret: String(getRawRuntimeSetting('OSS_ACCESS_KEY_SECRET', '') || ''),
            publicBaseUrl: String(getRawRuntimeSetting('OSS_PUBLIC_BASE_URL', '') || ''),
            signedUrlTtlSecs: parseIntegerValue(getRawRuntimeSetting('OSS_SIGNED_URL_TTL_SECS'), 900, { min: 60 }),
        },
        event: {
            partitionWriteMode: String(getRawRuntimeSetting('EVENT_PARTITION_WRITE_MODE', 'disabled') || 'disabled').trim().toLowerCase(),
            enableIncrementalStats: parseBooleanEnv(getRawRuntimeSetting('ENABLE_INCREMENTAL_STATS'), false),
        },
    };
}

function getRecordingAccessConfig() {
    const schemeAConfig = getSchemeAConfig();
    const defaultTtl = Math.min(schemeAConfig.objectStorage.signedUrlTtlSecs || 900, 900);
    const tokenSecret = String(getRawRuntimeSetting('RECORDING_ACCESS_TOKEN_SECRET', '') || getRawRuntimeSetting('JWT_SECRET', '') || '').trim();
    const ttlSecs = parseIntegerValue(getRawRuntimeSetting('RECORDING_ACCESS_TOKEN_TTL_SECS'), defaultTtl, { min: 60 });

    return {
        tokenSecret,
        ttlSecs,
    };
}

function getSchemeAFeatureFlags() {
    const config = getSchemeAConfig();

    return {
        enableSchemeAObservability: config.observability.enabled,
        enableRedisRoomCache: config.redis.enableRoomCache,
        enableRedisLiveState: config.redis.enableLiveState,
        enableWorkerStats: config.worker.enableStats,
        enableWorkerMaintenance: config.worker.enableMaintenance,
        enableRecordingUpload: config.worker.enableRecordingUpload,
        enableRecordingUploadDaemon: config.worker.enableRecordingUploadDaemon,
        enableRecordingLocalCleanup: config.worker.enableRecordingLocalCleanup,
        eventPartitionWriteMode: config.event.partitionWriteMode,
        enableIncrementalStats: config.event.enableIncrementalStats,
    };
}

function isSensitiveRuntimeSettingKey(key) {
    return SCHEME_A_RUNTIME_SETTING_KEYS.includes(String(key || ''));
}

module.exports = {
    SCHEME_A_RUNTIME_SETTING_KEYS,
    SCHEME_A_SECRET_SETTING_KEYS,
    parseBooleanEnv,
    parseIntegerEnv,
    parseIntegerValue,
    setRuntimeSettingOverrides,
    refreshRuntimeSettingsFromDb,
    getSchemeAConfig,
    getRecordingAccessConfig,
    getSchemeAFeatureFlags,
    isSensitiveRuntimeSettingKey,
};
