/**
 * TikTok LIVE connection wrapper with reconnect, error handling, and proxy support
 * Updated for TikTok-Live-Connector 2.x API
 */
require('dotenv').config();
const { TikTokLiveConnection, SignConfig } = require('tiktok-live-connector');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { EventEmitter } = require('events');

// KeyManager for API key rotation
const keyManager = require('./utils/keyManager');
const { supportsPremiumRoomLookup } = require('./utils/eulerKeyCapability');

let globalConnectionCount = 0;



class TikTokConnectionWrapper extends EventEmitter {
    constructor(uniqueId, options, enableLog) {
        super();

        options = options || {};

        this.uniqueId = uniqueId;
        this.enableLog = enableLog;

        // Connection State
        this.clientDisconnected = false;
        this.reconnectEnabled = true;
        this.reconnectCount = 0;
        this.reconnectWaitMs = 1000;
        this.didEmitDisconnected = false; // Prevent duplicate disconnected events
        this.maxReconnectAttempts = 5;
        this.currentEulerKey = null;
        this.currentEulerKeyRateLimited = false;
        this.eulerRateLimitCooldownMs = Math.max(60 * 1000, Number(options.eulerRateLimitCooldownMs || process.env.EULER_RATE_LIMIT_COOLDOWN_MS || 10 * 60 * 1000) || 10 * 60 * 1000);

        // Setup proxy agent - use options if valid, otherwise fallback to env
        // Important: ignore empty strings from database settings
        const proxyUrl = (options.proxyUrl && options.proxyUrl.trim())
            ? options.proxyUrl
            : (process.env.PROXY_URL || null);
        const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : null;
        if (proxyUrl) console.log(`[Proxy] Using proxy: ${proxyUrl}`);

        const hasPoolKeys = keyManager.getKeyCount() > 0;
        const premiumLookupDisabled = String(process.env.EULER_DISABLE_PREMIUM_ROOM_LOOKUP || '').trim().toLowerCase() === 'true';
        const pooledEntry = keyManager.getActiveKeyEntry();
        let resolvedEulerApiKey = null;
        let keySource = 'none';
        let activeKeyEntry = null;

        if (pooledEntry) {
            activeKeyEntry = pooledEntry;
            resolvedEulerApiKey = pooledEntry.key;
            keySource = 'key_pool';
        } else if (hasPoolKeys) {
            keySource = 'pool_exhausted';
        } else if (options.eulerApiKey) {
            resolvedEulerApiKey = options.eulerApiKey;
            keySource = 'legacy_single';
        } else if (process.env.EULER_API_KEY) {
            resolvedEulerApiKey = process.env.EULER_API_KEY;
            keySource = 'env_single';
        }

        if (SignConfig) {
            SignConfig.apiKey = resolvedEulerApiKey || undefined;
        }
        if (resolvedEulerApiKey && keySource === 'key_pool') {
            console.log(`[Wrapper] Using Euler Key: ${resolvedEulerApiKey.slice(0, 10)}...`);
        }

        this.currentEulerKey = keySource === 'key_pool' ? resolvedEulerApiKey : null;
        this.currentEulerKeySource = keySource;
        this.currentEulerKeyEntry = activeKeyEntry;
        this.lastConnectPath = 'unknown';

        const legacyPremiumEnabled = keySource !== 'key_pool' && String(process.env.EULER_ENABLE_ROOM_LOOKUP_PREMIUM || '').trim().toLowerCase() === 'true';
        const selectedKeySupportsPremium = Boolean(activeKeyEntry && supportsPremiumRoomLookup(activeKeyEntry));
        const premiumRoomLookupEnabled = !premiumLookupDisabled && Boolean(resolvedEulerApiKey) && (
            selectedKeySupportsPremium
            || options.enableEulerRoomLookupPremium === true
            || legacyPremiumEnabled
        );
        const preferEulerRoomLookup = premiumRoomLookupEnabled && (
            options.preferEulerRoomLookup === true
            || (keySource !== 'key_pool' && legacyPremiumEnabled && options.preferEulerRoomLookup !== false)
        );
        const canUseEulerFallbacks = premiumRoomLookupEnabled && options.disableEulerFallbacks !== true;
        this.premiumRoomLookupEnabled = premiumRoomLookupEnabled;
        this.preferEulerRoomLookup = preferEulerRoomLookup;
        this.canUseEulerFallbacks = canUseEulerFallbacks;

        // Merge options with proxy settings
        const connectionOptions = {
            ...options,
            signApiKey: resolvedEulerApiKey || null,
            disableEulerFallbacks: !canUseEulerFallbacks,
            fetchRoomInfoOnConnect: preferEulerRoomLookup ? false : options.fetchRoomInfoOnConnect,
            webClientOptions: {
                ...(options?.webClientOptions || {}),
                ...(agent ? { httpsAgent: agent, timeout: 30000 } : { timeout: 30000 })
            },
            wsClientOptions: {
                ...(options?.wsClientOptions || {}),
                ...(agent ? { agent: agent, timeout: 30000 } : { timeout: 30000 })
            }
        };

        this.connection = new TikTokLiveConnection(uniqueId, connectionOptions);

        if (preferEulerRoomLookup) {
            this.installEulerRoomResolvers();
            this.lastConnectPath = 'euler_room_lookup';
            this.log('Euler direct room resolution explicitly enabled for current key');
        } else {
            this.installFallbackRoomResolvers();
            this.lastConnectPath = 'tiktok_fallback';
            if (premiumLookupDisabled) {
                this.log('Euler premium room lookup disabled by env; using TikTok HTML/API only');
            } else if (premiumRoomLookupEnabled) {
                this.log('Selected Euler key supports Premium room lookup; keeping TikTok HTML/API as default and enabling Euler fallback when needed');
            } else if (activeKeyEntry && !supportsPremiumRoomLookup(activeKeyEntry)) {
                this.log('Current selected Euler key has no confirmed Premium room lookup capability; using TikTok HTML/API only');
            } else {
                this.log('Euler premium room lookup not yet confirmed; using TikTok HTML/API only');
            }
        }


        this.connection.on('streamEnd', () => {
            this.log(`streamEnd event received, giving up connection`);
            this.reconnectEnabled = false;
            // Emit disconnected so AutoRecorder can clean up and save session
            if (!this.didEmitDisconnected) {
                this.didEmitDisconnected = true;
                this.emit('disconnected', 'LIVE has ended');
            }
        });

        this.connection.on('disconnected', () => {
            globalConnectionCount -= 1;
            this.log(`TikTok connection disconnected`);
            this.scheduleReconnect();
        });

        this.connection.on('error', (err) => {
            const msg = err?.info || err?.message || String(err);
            const errorName = err?.constructor?.name || err?.name || '';

            // Parse nested errors for FetchIsLiveError
            let humanMessage = '';
            let shouldShowStack = false;
            let shouldDisableEulerKeyForRateLimit = false;

            if (errorName === 'FetchIsLiveError' || msg?.includes?.('Failed to retrieve Room ID')) {
                // Parse the nested errors array
                const errors = err?.errors || [];
                const errorReasons = [];

                // Log full error details for debugging
                if (errors.length === 0) {
                    console.error(`[Wrapper] @${this.uniqueId} FetchIsLiveError with no nested errors. Full error:`, err);
                }

                for (const e of errors) {
                    const eMsg = e?.message || String(e);
                    const eCode = e?.code || e?.statusCode || '';

                    // Check for rate limiting indicators
                    if (eCode === 429 || eMsg?.includes?.('rate limit') || eMsg?.includes?.('Too Many Requests')) {
                        shouldDisableEulerKeyForRateLimit = true;
                        errorReasons.push('🚫 API 请求频率过高，已被限流');
                    } else if (eMsg?.includes?.('SIGI_STATE')) {
                        errorReasons.push('🔒 TikTok 页面解析失败（可能被封锁或页面结构变化）');
                    } else if (eMsg?.includes?.('InvalidResponseError') || e?.name === 'InvalidResponseError') {
                        errorReasons.push('❌ API 返回无效响应');
                    } else if (eMsg?.includes?.('lack of permission') || eMsg?.includes?.('Euler Stream')) {
                        errorReasons.push('🔑 Euler API Key 权限不足，无法使用备用方法');
                    } else if (eMsg?.includes?.('timeout') || eMsg?.includes?.('Timeout')) {
                        errorReasons.push('⏱️ 连接超时');
                    } else if (eMsg?.includes?.('403') || eMsg?.includes?.('Forbidden')) {
                        errorReasons.push('🚫 访问被拒绝 (403)');
                    } else if (eMsg?.includes?.('ECONNRESET') || eMsg?.includes?.('ECONNREFUSED')) {
                        errorReasons.push('🔌 网络连接被重置');
                    } else if (eMsg) {
                        errorReasons.push(`⚠️ ${eMsg.slice(0, 100)}`);
                    }
                }

                if (errorReasons.length > 0) {
                    humanMessage = `无法获取房间信息:\n  ${errorReasons.join('\n  ')}`;
                } else {
                    // When no specific reason found, log more details
                    humanMessage = `无法获取房间信息（未知原因）- errors数组长度: ${errors.length}`;
                    console.error(`[Wrapper] @${this.uniqueId} Unknown fetch error. Info:`, err?.info, 'Message:', msg);
                }

            } else if (msg?.includes?.('504') || msg?.includes?.('500') || msg?.includes?.('sign server')) {
                humanMessage = '🔄 签名服务器暂时不可用，稍后自动重试';
            } else if (msg?.includes?.("isn't online") || msg?.includes?.('UserOfflineError')) {
                humanMessage = '📴 主播当前不在直播';
            } else if (msg?.includes?.('Failed to extract') || msg?.includes?.('SIGI_STATE')) {
                humanMessage = '🔒 无法解析 TikTok 页面（可能被封锁）';
            } else if (msg?.includes?.('SignAPIError') || msg?.includes?.('Sign Error')) {
                humanMessage = '🔑 签名服务错误，请检查 API Key';
            } else if (msg?.includes?.('Euler room lookup permission denied') || msg?.includes?.('Euler live status lookup permission denied')) {
                humanMessage = '🔑 Euler Key 无权访问房间解析接口';
            } else if (msg?.includes?.('Euler room lookup rate limited') || msg?.includes?.('Euler live status lookup rate limited')) {
                shouldDisableEulerKeyForRateLimit = true;
                humanMessage = '🚫 Euler 房间解析接口被限流';
            } else if (msg?.includes?.('Euler room lookup failed') || msg?.includes?.('Euler live status lookup failed')) {
                humanMessage = '⚠️ Euler 房间解析失败';
            } else if (msg?.includes?.('falling back to API')) {
                humanMessage = '🔄 正在尝试备用连接方式...';
            } else if (msg?.includes?.('Error while connecting')) {
                humanMessage = '⚠️ 连接建立失败';
            } else {
                // Unknown error - show full message and stack
                humanMessage = msg;
                shouldShowStack = true;
            }

            if (shouldDisableEulerKeyForRateLimit) {
                this.handleEulerRateLimit(humanMessage || msg, {
                    errorName,
                    source: 'connection-error',
                });
            }
            this.log(`[ERROR] ${humanMessage}`);
            if (shouldShowStack && err?.stack) {
                console.error(err);
            }
        });
    }


    createCompositeFetchError(message, errors = []) {
        const error = new Error(message);
        error.name = 'FetchIsLiveError';
        error.errors = errors;
        return error;
    }

    async performEulerRoomLookup({ uniqueId, requestType = 'room_lookup', path = 'euler_room_lookup', source = 'fetchRoomId' } = {}) {
        const webClient = this.connection?.webClient;
        if (!webClient?.fetchRoomIdFromEuler) {
            throw new Error('Euler room lookup helper unavailable');
        }

        const lookupLabel = requestType === 'live_check' ? 'Euler live status lookup' : 'Euler room lookup';
        keyManager.recordEulerRequest(this.currentEulerKey, requestType);
        const response = await webClient.fetchRoomIdFromEuler({ uniqueId });

        if ([401, 402, 403].includes(response?.code)) {
            const message = `${lookupLabel} permission denied (${response.code})`;
            keyManager.recordConnectionOutcome({
                key: this.currentEulerKey,
                success: false,
                path,
                permissionDenied: true,
                keySource: this.currentEulerKeySource,
            });
            this.markEulerKeyFailure(message);
            throw new Error(message);
        }

        if (response?.code === 429) {
            const message = `${lookupLabel} rate limited (429)`;
            this.handleEulerRateLimit(message, {
                source,
                responseCode: response.code,
            });
            throw new Error(message);
        }

        if (requestType === 'live_check') {
            if (typeof response?.is_live !== 'boolean') {
                const message = `${lookupLabel} failed: ${response?.message || 'missing is_live'}`;
                this.markEulerKeyFailure(message);
                throw new Error(message);
            }
            this.lastConnectPath = path;
            return response.is_live;
        }

        if (!response?.ok || !response?.room_id) {
            const message = `${lookupLabel} failed: ${response?.message || 'missing room_id'}`;
            this.markEulerKeyFailure(message);
            throw new Error(message);
        }

        this.lastConnectPath = path;
        return String(response.room_id);
    }

    installEulerRoomResolvers() {
        const webClient = this.connection?.webClient;
        if (!webClient?.fetchRoomIdFromEuler) {
            return;
        }

        this.connection.fetchRoomId = async (uniqueIdOverride) => {
            const resolvedUniqueId = uniqueIdOverride || this.uniqueId;
            return this.performEulerRoomLookup({
                uniqueId: resolvedUniqueId,
                requestType: 'room_lookup',
                path: 'euler_room_lookup',
                source: 'fetchRoomId',
            });
        };

        this.connection.fetchIsLive = async () => {
            return this.performEulerRoomLookup({
                uniqueId: this.uniqueId,
                requestType: 'live_check',
                path: 'euler_room_lookup',
                source: 'fetchIsLive',
            });
        };
    }

    installFallbackRoomResolvers() {
        const webClient = this.connection?.webClient;
        if (!webClient?.fetchRoomInfoFromHtml || !webClient?.fetchRoomInfoFromApiLive) {
            return;
        }

        const extractHtmlLiveStatus = (roomInfo) => {
            return roomInfo?.liveRoomUserInfo?.liveRoom?.status ?? roomInfo?.liveRoom?.status;
        };
        const isOnline = (status) => status !== 4;

        this.connection.fetchRoomId = async (uniqueIdOverride) => {
            const resolvedUniqueId = uniqueIdOverride || this.uniqueId;
            const errors = [];

            try {
                const roomInfo = await webClient.fetchRoomInfoFromHtml({ uniqueId: resolvedUniqueId });
                const roomId = roomInfo?.user?.roomId;
                if (!roomId) throw new Error('Failed to extract Room ID from HTML.');
                this.lastConnectPath = 'tiktok_html';
                return String(roomId);
            } catch (error) {
                errors.push(error);
            }

            try {
                const roomData = await webClient.fetchRoomInfoFromApiLive({ uniqueId: resolvedUniqueId });
                const roomId = roomData?.data?.user?.roomId;
                if (!roomId) throw new Error('Failed to extract Room ID from API.');
                this.lastConnectPath = 'tiktok_api';
                return String(roomId);
            } catch (error) {
                errors.push(error);
            }

            if (this.canUseEulerFallbacks) {
                try {
                    return await this.performEulerRoomLookup({
                        uniqueId: resolvedUniqueId,
                        requestType: 'room_lookup',
                        path: 'euler_room_lookup_fallback',
                        source: 'fetchRoomIdFallback',
                    });
                } catch (error) {
                    errors.push(error);
                }
            }

            throw this.createCompositeFetchError('Failed to retrieve Room ID from all sources.', errors);
        };

        this.connection.fetchIsLive = async () => {
            const errors = [];

            try {
                const roomInfo = await webClient.fetchRoomInfoFromHtml({ uniqueId: this.uniqueId });
                const status = extractHtmlLiveStatus(roomInfo);
                if (status === undefined) throw new Error('Failed to extract status from HTML.');
                this.lastConnectPath = 'tiktok_html';
                return isOnline(status);
            } catch (error) {
                errors.push(error);
            }

            try {
                const roomData = await webClient.fetchRoomInfoFromApiLive({ uniqueId: this.uniqueId });
                const status = roomData?.data?.liveRoom?.status;
                if (status === undefined) throw new Error('Failed to extract status from API.');
                this.lastConnectPath = 'tiktok_api';
                return isOnline(status);
            } catch (error) {
                errors.push(error);
            }

            if (this.canUseEulerFallbacks) {
                try {
                    return await this.performEulerRoomLookup({
                        uniqueId: this.uniqueId,
                        requestType: 'live_check',
                        path: 'euler_room_lookup_fallback',
                        source: 'fetchIsLiveFallback',
                    });
                } catch (error) {
                    errors.push(error);
                }
            }

            throw this.createCompositeFetchError('Failed to retrieve live status from all sources.', errors);
        };
    }


    markEulerKeySuccess() {
        const resolvedPath = this.lastConnectPath || 'unknown';
        const usedEulerKey = ['euler_room_lookup', 'euler_room_lookup_fallback'].includes(resolvedPath);
        const trackedKey = usedEulerKey ? this.currentEulerKey : null;

        keyManager.recordConnectionOutcome({
            key: trackedKey,
            success: true,
            path: resolvedPath,
            fallbackUsed: resolvedPath !== 'euler_room_lookup',
            keySource: this.currentEulerKeySource,
        });
        if (!trackedKey) return;
        this.currentEulerKeyRateLimited = false;
        keyManager.recordResult(trackedKey, true).catch(() => {});
    }

    markEulerKeyFailure(errorMessage) {
        if (!this.currentEulerKey) return;
        keyManager.recordResult(this.currentEulerKey, false, errorMessage).catch(() => {});
    }

    handleEulerRateLimit(errorMessage, meta = {}) {
        if (!this.currentEulerKey || this.currentEulerKeyRateLimited) {
            return;
        }
        this.currentEulerKeyRateLimited = true;
        this.markEulerKeyFailure(errorMessage);
        keyManager.disableKey(this.currentEulerKey, this.eulerRateLimitCooldownMs, 'rate_limit', {
            uniqueId: this.uniqueId,
            ...meta,
            error: errorMessage,
        });
        this.log(`[EULER] Key ${this.currentEulerKey.slice(0, 10)}... hit rate limit; cooldown ${Math.round(this.eulerRateLimitCooldownMs / 60000)}m`);
    }

    connect(isReconnect, cachedRoomId = null) {
        // Pass cached room ID to skip fetching from TikTok page
        return this.connection.connect(cachedRoomId || undefined).then((state) => {
            this.log(`${isReconnect ? 'Reconnected' : 'Connected'} to roomId ${state.roomId}`);

            // Check if Room is actually Live (status 2 = LIVE, 4 = FINISH)
            // If status is undefined (e.g. from generic API fallback), assume LIVE to prevent false positive disconnects.
            if (state.roomInfo && state.roomInfo.status !== undefined && state.roomInfo.status !== 2) {
                this.log(`Room Status is ${state.roomInfo.status} (Not LIVE). Disconnecting...`);
                this.connection.disconnect();
                throw new Error(`Room is offline (Status: ${state.roomInfo.status})`);
            }

            globalConnectionCount += 1;
            this.markEulerKeySuccess();

            // Reset reconnect vars
            this.reconnectCount = 0;
            this.reconnectWaitMs = 1000;

            // Client disconnected while establishing connection => drop connection
            if (this.clientDisconnected) {
                this.connection.disconnect();
                return;
            }

            // Notify client - emit connected on BOTH initial connect AND reconnect
            // This ensures setupLogging is called after reconnect to register event handlers
            this.emit('connected', state);

            return state; // Return state for await callers

        }).catch((err) => {
            this.log(`${isReconnect ? 'Reconnect' : 'Connection'} failed, ${err}`);
            if (this.currentEulerKey && !this.currentEulerKeyRateLimited && ['euler_room_lookup', 'euler_room_lookup_fallback'].includes(this.lastConnectPath)) {
                this.markEulerKeyFailure(err?.message || String(err));
            }

            if (isReconnect) {
                // Schedule the next reconnect attempt
                this.scheduleReconnect(err);
            } else {
                // Notify client
                this.emit('disconnected', err.toString());
            }
            throw err; // Re-throw for await callers
        });
    }

    scheduleReconnect(reason) {
        if (!this.reconnectEnabled) {
            // Reconnect disabled (e.g., after streamEnd) - notify listeners we're done
            if (!this.didEmitDisconnected) {
                this.didEmitDisconnected = true;
                this.log(`Reconnect disabled, emitting final disconnected event`);
                this.emit('disconnected', reason || 'Reconnect disabled');
            }
            return;
        }

        if (this.reconnectCount >= this.maxReconnectAttempts) {
            this.log(`Give up connection, max reconnect attempts exceeded`);
            this.emit('disconnected', `Connection lost. ${reason}`);
            return;
        }

        this.log(`Try reconnect in ${this.reconnectWaitMs}ms`);

        setTimeout(() => {
            if (!this.reconnectEnabled || this.reconnectCount >= this.maxReconnectAttempts) {
                return;
            }

            this.reconnectCount += 1;
            this.reconnectWaitMs *= 2;

            // CRITICAL: Must catch reconnect errors to prevent UnhandledPromiseRejection crash
            this.connect(true).catch(err => {
                this.log(`Reconnect failed, ${err?.message || err}`);
                // Schedule another reconnect attempt if we haven't exceeded max
                this.scheduleReconnect(err?.message || 'Reconnect failed');
            });

        }, this.reconnectWaitMs);
    }

    disconnect() {
        this.log(`Client connection disconnected`);

        this.clientDisconnected = true;
        this.reconnectEnabled = false;

        if (this.connection.isConnected) {
            this.connection.disconnect();
        }
    }

    log(logString) {
        if (this.enableLog) {
            console.log(`WRAPPER @${this.uniqueId}: ${logString}`);
        }
    }
}

module.exports = {
    TikTokConnectionWrapper,
    getGlobalConnectionCount: () => {
        return globalConnectionCount;
    },
    getKeyCount: () => keyManager.getKeyCount()
};
