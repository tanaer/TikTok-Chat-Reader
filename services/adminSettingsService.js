const {
    SCHEME_A_RUNTIME_SETTING_KEYS,
    SCHEME_A_SECRET_SETTING_KEYS,
    getSchemeAConfig,
    getRecordingAccessConfig,
} = require('./featureFlagService');
const {
    DEFAULT_AI_POINT_COSTS,
    AI_POINT_SETTING_KEYS,
    AI_POINT_SCENES,
} = require('./aiPricingService');

const ADMIN_SETTINGS_GROUPS = [
    {
        key: 'basic',
        title: '基础设置',
        description: '站点运行基础参数、默认额度和通用网络配置。',
        fields: [
            { key: 'scan_interval', label: '扫描间隔 (分钟)', type: 'number', hint: '控制自动扫描房间开播状态的频率。', tooltip: '单位为分钟。值越小，发现开播越及时，但会提高轮询频率与代理/上游请求压力；一般建议在 1~5 分钟之间。' },
            { key: 'auto_monitor_enabled', label: '自动监控', type: 'toggle', hint: '决定系统是否自动接管房间监控流程。', tooltip: '开启后系统会按扫描间隔自动检查配置中的房间，并尝试维持监控/采集流程；关闭后只保留手动操作，不再自动补连或自动拉起。' },
            { key: 'proxy_url', label: '代理地址', type: 'text', hint: '全局 HTTP/HTTPS 代理入口。', tooltip: '用于需要走代理的外部请求。留空表示直连；常见格式如 http://127.0.0.1:7890、https://proxy.example.com:443 或 socks5://127.0.0.1:1080。' },
            { key: 'session_id', label: 'TikTok Session ID', type: 'text', secret: true, hint: 'TikTok 登录态 Cookie。', tooltip: '用于需要登录态才能访问的 TikTok 能力。登录态失效、切换账号或风控后需要更新；后台始终不会回显已有值，留空表示保持现有配置。' },
            { key: 'port', label: '服务端口', type: 'number', restartRequired: true, hint: 'Node 服务监听的本地端口。', tooltip: '修改后通常需要重启主服务才能生效。如果前面还有 Nginx、宝塔或其他反向代理，也要同步检查转发端口是否一致。' },
            { key: 'dynamic_tunnel_proxy', label: '动态隧道代理', type: 'text', hint: '动态代理通道或隧道入口。', tooltip: '用于接入按次/按时间轮换出口 IP 的代理服务。通常填写供应商提供的统一入口地址或隧道地址，供监控链路按需复用。' },
            { key: 'proxy_api_url', label: '代理 API 地址', type: 'text', hint: '代理池接口或换 IP 接口地址。', tooltip: '如果你的代理服务通过 HTTP API 下发可用代理，可在这里填写接口地址，供系统按需拉取或刷新代理。留空则不会使用代理 API。' },
            { key: 'default_room_limit', label: '默认房间上限 (未订阅, -1 无限)', type: 'number', hint: '未订阅用户的默认房间额度。', tooltip: '控制普通未订阅用户默认可添加多少个房间。填写 -1 表示不限制；修改后只影响按默认策略判定的用户，不会自动覆盖已单独发放的套餐额度。' },
            { key: 'min_recharge_amount', label: '最低充值金额', type: 'number', hint: '全站充值入口的默认最低金额。', tooltip: '用于限制用户最小充值金额，防止过小金额订单造成支付链路噪音。若具体支付方式另有单独限制，则以更严格的规则为准。' },
            { key: 'site_name', label: '网站名称', type: 'text', hint: '前后台通用的站点名称。', tooltip: '会出现在页面标题、部分邮件文案、用户中心和后台展示中。修改后不会影响业务逻辑，但会直接影响用户可见文案。' },
            { key: 'gift_room_limit', label: '注册赠送房间数', type: 'number', hint: '新用户注册后赠送的房间额度。', tooltip: '控制新用户注册成功后默认获得的房间数量额度。通常与赠送时长一起组成新手体验包。' },
            { key: 'gift_duration_days', label: '注册赠送天数', type: 'number', hint: '注册赠送套餐的有效期。', tooltip: '单位为天。新用户在注册后可在该有效期内使用赠送额度，过期后按正式套餐或默认限制继续判断。' },
        ],
    },
    {
        key: 'auth',
        title: '登录与安全',
        description: '账号会话安全与登录行为控制。',
        fields: [
            { key: 'single_session_login_enabled', label: '单点登录（新登录踢掉旧登录）', type: 'toggle', hint: '限制同一账号只保留一个有效会话。', tooltip: '开启后同一账号仅保留一个有效登录会话，新设备登录会让旧会话失效，适合防共享账号；关闭后允许多端同时在线。' },
        ],
    },
    {
        key: 'aiPricing',
        title: 'AI 定价',
        description: '配置各类 AI 功能的默认扣点。保存后立即作用于新发起任务；已完成历史任务不会回写。',
        fields: [
            {
                key: AI_POINT_SETTING_KEYS[AI_POINT_SCENES.SESSION_RECAP],
                label: 'AI直播复盘扣点',
                type: 'number',
                hint: '单场 AI直播复盘默认消耗点数。',
                tooltip: '用于房间详情中的 AI直播复盘。修改后会影响前台展示、二次确认提示、余额校验和实际扣点；历史任务记录保持原值。',
            },
            {
                key: AI_POINT_SETTING_KEYS[AI_POINT_SCENES.CUSTOMER_ANALYSIS],
                label: 'AI客户分析扣点',
                type: 'number',
                hint: '单次房间客户分析默认消耗点数。',
                tooltip: '用于历史排行榜中的 AI客户分析。修改后会影响前台展示、二次确认提示、余额校验和实际扣点；历史任务记录保持原值。',
            },
            {
                key: AI_POINT_SETTING_KEYS[AI_POINT_SCENES.USER_PERSONALITY],
                label: 'AI性格分析扣点',
                type: 'number',
                hint: '单次用户性格分析默认消耗点数。',
                tooltip: '用于用户详情里的 AI性格分析。修改后会影响前台展示、二次确认提示、余额校验和实际扣点；历史任务记录保持原值。',
            },
        ],
    },
    {
        key: 'schemeAObs',
        title: '运行观测',
        description: '控制缓存、录播、对象存储和后台任务的结构化日志与指标输出。',
        fields: [
            { key: 'ENABLE_SCHEME_A_OBSERVABILITY', label: '启用结构化日志与指标', type: 'toggle', hint: '为缓存、录播、对象存储和 worker 开启统一观测。', tooltip: '开启后会输出关键链路的结构化日志与指标，包括录播任务、对象存储、worker、Redis 等运行状态，方便排查问题；关闭后只保留现有基础日志。' },
        ],
    },
    {
        key: 'schemeARedis',
        title: 'Redis 缓存',
        description: '管理 Redis 连接、共享缓存和跨实例状态能力。',
        fields: [
            { key: 'REDIS_URL', label: 'Redis URL', type: 'text', placeholder: 'redis://127.0.0.1:6379', hint: '默认使用本机 Redis：无账号、无密码、6379 端口。', tooltip: '默认值为本机 Redis：redis://127.0.0.1:6379。若你的 Redis 部署在其他机器、端口或带密码，请在这里改成完整连接串，例如 redis://:password@host:6379。' },
            { key: 'ENABLE_REDIS_ROOM_CACHE', label: '启用房间缓存', type: 'toggle', hint: '把高频只读结果放入 Redis 短缓存。', tooltip: '开启后会把房间列表、场次列表、排行榜、分析统计等高频只读结果放入 Redis 短缓存，降低 PostgreSQL 压力。依赖 Redis 可连接；关闭后这些接口全部实时查库。' },
            { key: 'ENABLE_REDIS_LIVE_STATE', label: '启用直播态缓存', type: 'toggle', hint: '让直播状态支持多进程/多实例共享。', tooltip: '开启后直播态摘要与部分高频实时状态会优先写入 Redis，适合多进程或多实例共享状态；关闭后状态只保存在当前进程内存中，跨实例不共享。' },
        ],
    },
    {
        key: 'schemeARecordingWorker',
        title: '录播上传 Worker',
        description: '控制录播上传、守护进程、清理策略和后台 worker。',
        fields: [
            { key: 'ENABLE_RECORDING_UPLOAD', label: '启用录播上传', type: 'toggle', hint: '允许录播完成后进入上传流程。', tooltip: '开启后录播任务在本地完成后会进入上传队列，准备推送到对象存储；仅打开此项不会自动启动后台守护，还需要对象存储配置可用。' },
            { key: 'ENABLE_RECORDING_UPLOAD_DAEMON', label: '启用录播上传守护', type: 'toggle', hint: '常驻轮询并自动处理待上传任务。', tooltip: '开启后主进程会拉起录播上传守护 worker，持续轮询待上传任务并自动重试；关闭时不会常驻后台自动处理上传。' },
            { key: 'RECORDING_UPLOAD_WORKER_POLL_MS', label: '上传轮询间隔 (ms)', type: 'number', hint: 'worker 每隔多久扫描一次待上传任务。', tooltip: '单位为毫秒。数值越小，上传触发越及时，但空轮询次数也会更多；通常用于平衡上传实时性与后台资源占用。' },
            { key: 'RECORDING_UPLOAD_WORKER_BATCH_SIZE', label: '上传批大小', type: 'number', hint: '单轮最多处理多少个上传任务。', tooltip: '用于限制每次轮询实际拉起的上传任务数，避免同时上传过多大文件挤占带宽或对象存储配额。' },
            { key: 'RECORDING_UPLOAD_DAEMON_RESTART_DELAY_MS', label: '守护重启延迟 (ms)', type: 'number', hint: 'worker 异常退出后等待多久再重启。', tooltip: '守护进程异常退出后不会立刻无限重启，而是等待这个时间再尝试拉起，避免故障期间形成高频抖动。' },
            { key: 'RECORDING_UPLOAD_DAEMON_MAX_RESTARTS', label: '守护最大重启次数 (0=不限)', type: 'number', hint: '限制守护 worker 的累计自动重启次数。', tooltip: '填写 0 表示不设上限。若设置为有限次数，超过阈值后会停止自动重启，适合在排障期防止错误循环。' },
            { key: 'ENABLE_RECORDING_LOCAL_CLEANUP', label: '启用本地临时文件清理', type: 'toggle', hint: '上传成功后按策略删除本地录播文件。', tooltip: '开启后上传成功且超过延迟阈值的本地录播文件会被后台清理，节省磁盘空间；建议先确认对象存储上传稳定后再开启。' },
            { key: 'RECORDING_LOCAL_CLEANUP_DELAY_MS', label: '本地清理延迟 (ms)', type: 'number', hint: '上传完成后等待多久再清理本地文件。', tooltip: '用于给下载、人工抽查或补传留出缓冲时间。数值越大，本地磁盘占用越久，但误删风险越低。' },
            { key: 'RECORDING_LOCAL_CLEANUP_BATCH_SIZE', label: '本地清理批大小', type: 'number', hint: '每轮最多清理多少个本地文件。', tooltip: '防止清理任务一次性删除过多文件导致 IO 抖动。通常与清理延迟、录播产出规模一起调优。' },
            { key: 'ENABLE_WORKER_STATS', label: '启用统计 worker', type: 'toggle', hint: '让统计类后台任务由独立 worker 常驻执行。', tooltip: '开启后会启动统计 worker，处理增量汇总、统计刷新等后台任务；关闭后这些任务不会由独立 worker 常驻执行。' },
            { key: 'ENABLE_WORKER_MAINTENANCE', label: '启用维护 worker', type: 'toggle', hint: '把维护类后台任务交给独立 worker 处理。', tooltip: '开启后会启动维护 worker，负责录播与场次相关的后台维护任务；关闭后仅保留主流程或手动触发的维护逻辑。' },
        ],
    },
    {
        key: 'schemeAObjectStorage',
        title: '云存储',
        description: '对象存储连接、访问方式和签名下载参数。',
        fields: [
            {
                key: 'OBJECT_STORAGE_PROVIDER',
                label: '对象存储协议',
                type: 'select',
                hint: '决定使用哪类对象存储兼容协议。',
                tooltip: '当前主要按 S3 兼容方式接入，也兼容 OSS 风格配置。通常保持默认即可，除非你的服务商要求特定签名/域名格式。',
                options: [
                    { value: 's3', label: 'S3 兼容' },
                    { value: 'oss', label: 'OSS / S3 兼容' },
                ],
            },
            { key: 'OSS_ENDPOINT', label: 'Endpoint', type: 'text', placeholder: 'https://oss-cn-hangzhou.aliyuncs.com', hint: '对象存储服务入口地址。', tooltip: '填写对象存储厂商提供的 API Endpoint。建议带上协议头，例如 https://s3.ap-southeast-1.amazonaws.com 或 https://oss-cn-hangzhou.aliyuncs.com。' },
            { key: 'OSS_REGION', label: 'Region', type: 'text', placeholder: 'cn-hangzhou / auto', hint: '对象存储所在区域或兼容标识。', tooltip: '部分 S3/OSS 服务要求显式 region，用于签名和路由；若服务商支持自动识别，可按兼容要求填写 auto 或官方建议值。' },
            { key: 'OSS_BUCKET', label: 'Bucket', type: 'text', hint: '录播文件最终存放的 Bucket 名称。', tooltip: '上传成功后的录播对象会写入这里。请确保该 Bucket 已创建，并且 Access Key 对其拥有读写权限。' },
            { key: 'OSS_ACCESS_KEY_ID', label: 'Access Key ID', type: 'password', secret: true, hint: '对象存储访问账号 ID。', tooltip: '用于对象存储 API 鉴权。后台不会回显已有值，留空表示继续使用当前保存的 Access Key ID。' },
            { key: 'OSS_ACCESS_KEY_SECRET', label: 'Access Key Secret', type: 'password', secret: true, hint: '对象存储访问密钥。', tooltip: '与 Access Key ID 配套使用的密钥，属于敏感信息。后台不会回显已有值，留空表示保持现值。' },
            { key: 'OSS_PUBLIC_BASE_URL', label: '公开访问基地址', type: 'text', placeholder: '留空则使用 endpoint + bucket', hint: '外部访问录播时优先拼接的公开地址前缀。', tooltip: '如果你的 Bucket 绑定了 CDN、自定义域名或专用下载域名，可在这里填写公共访问基地址。留空时系统会根据 endpoint 和 bucket 兜底拼接。' },
            { key: 'OSS_SIGNED_URL_TTL_SECS', label: '签名 URL TTL (秒)', type: 'number', hint: '下载签名链接的有效期。', tooltip: '单位为秒。用于限制录播签名下载地址能被使用多久；数值越大分享越方便，但泄漏后可利用窗口也越长。' },
        ],
    },
    {
        key: 'schemeARecordingAccess',
        title: '录播访问',
        description: '录播访问 token 的签名密钥与有效期。',
        fields: [
            { key: 'RECORDING_ACCESS_TOKEN_SECRET', label: '录播访问 Token Secret', type: 'password', secret: true, hint: '录播下载 accessToken 的签名密钥。', tooltip: '用于签发录播访问 token。建议使用高强度随机字符串；后台不会回显现有值，留空表示保持当前密钥。修改后旧 token 将逐步失效。' },
            { key: 'RECORDING_ACCESS_TOKEN_TTL_SECS', label: '录播访问 Token TTL (秒)', type: 'number', hint: '录播访问 token 的有效期。', tooltip: '单位为秒。控制录播下载链接中 accessToken 的有效时间，通常不宜过长，以减少链接外泄后的可利用时间。' },
        ],
    },
    {
        key: 'schemeAFuture',
        title: '统计加速',
        description: '用更快的统计结果替代部分慢查询，减少页面等待。',
        fields: [
            { key: 'ENABLE_INCREMENTAL_STATS', label: '启用统计加速', type: 'toggle', hint: '让系统优先使用已整理好的统计结果。', tooltip: '开启后，部分统计页面会优先读取后台提前整理好的结果，页面会更快、数据库压力也更小；关闭后则继续每次都从原始明细里实时计算。' },
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
        [AI_POINT_SETTING_KEYS[AI_POINT_SCENES.SESSION_RECAP]]: DEFAULT_AI_POINT_COSTS[AI_POINT_SCENES.SESSION_RECAP],
        [AI_POINT_SETTING_KEYS[AI_POINT_SCENES.CUSTOMER_ANALYSIS]]: DEFAULT_AI_POINT_COSTS[AI_POINT_SCENES.CUSTOMER_ANALYSIS],
        [AI_POINT_SETTING_KEYS[AI_POINT_SCENES.USER_PERSONALITY]]: DEFAULT_AI_POINT_COSTS[AI_POINT_SCENES.USER_PERSONALITY],
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
