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
if (process.env.EULER_API_KEY && SignConfig) {
    SignConfig.apiKey = process.env.EULER_API_KEY;
    console.log('[Sign] EulerStream API Key configured');
}

let globalConnectionCount = 0;



class TikTokConnectionWrapper extends EventEmitter {
    constructor(uniqueId, options, enableLog) {
        super();

        this.uniqueId = uniqueId;
        this.enableLog = enableLog;

        // Connection State
        this.clientDisconnected = false;
        this.reconnectEnabled = true;
        this.reconnectCount = 0;
        this.reconnectWaitMs = 1000;
        this.didEmitDisconnected = false; // Prevent duplicate disconnected events
        this.maxReconnectAttempts = 5;

        // Setup proxy agent - try proxyManager first, then options, then env
        // Important: ignore empty strings from database settings
        let proxyUrl = null;
        let proxyNodeId = null;

        // Check if proxy was passed from auto_recorder (from proxyManager)
        if (options.dynamicProxyUrl) {
            proxyUrl = options.dynamicProxyUrl;
            proxyNodeId = options.dynamicProxyNodeId || null;
            console.log(`[Proxy] Using dynamic proxy: ${proxyUrl.slice(0, 30)}... (nodeId: ${proxyNodeId})`);
        }

        // Fallback to options or env
        if (!proxyUrl) {
            proxyUrl = (options.proxyUrl && options.proxyUrl.trim())
                ? options.proxyUrl
                : (process.env.PROXY_URL || null);
            if (proxyUrl) console.log(`[Proxy] Using config proxy: ${proxyUrl}`);
        }

        // Create agent based on proxy URL type
        let agent = null;
        if (proxyUrl) {
            if (proxyUrl.startsWith('socks')) {
                agent = new SocksProxyAgent(proxyUrl);
            } else if (proxyUrl.startsWith('http')) {
                const { HttpsProxyAgent } = require('https-proxy-agent');
                agent = new HttpsProxyAgent(proxyUrl);
            }
        }

        // Store proxyNodeId for marking success/failure later
        this.proxyNodeId = proxyNodeId;

        // Set API Key using KeyManager for rotation
        const apiKey = keyManager.getActiveKey();
        if (apiKey) {
            if (SignConfig) {
                SignConfig.apiKey = apiKey;
                console.log(`[Wrapper] Using Euler Key: ${apiKey.slice(0, 10)}...`);
            } else {
                console.warn(`[Wrapper] SignConfig not available, passing key via options`);
            }
        } else if (options.eulerApiKey) {
            if (SignConfig) SignConfig.apiKey = options.eulerApiKey;
        } else if (process.env.EULER_API_KEY) {
            if (SignConfig) SignConfig.apiKey = process.env.EULER_API_KEY;
        }

        // Merge options with proxy settings
        const connectionOptions = {
            ...options,
            signApiKey: apiKey, // Pass to connection too
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

            if (errorName === 'FetchIsLiveError' || msg?.includes?.('Failed to retrieve Room ID')) {
                // Parse the nested errors array
                const errors = err?.errors || [];
                const errorReasons = [];

                // Also check main error info and exception
                const mainInfo = err?.info || '';
                const exceptionMsg = err?.exception?.message || '';

                // Check main error info for common patterns first
                if (mainInfo?.includes?.('lack of permission') || exceptionMsg?.includes?.('lack of permission')) {
                    errorReasons.push('🔑 Euler API Key 权限不足（需要付费版或更高权限）');
                }
                if (mainInfo?.includes?.('SIGI_STATE') || mainInfo?.includes?.('blocked by TikTok')) {
                    errorReasons.push('🔒 服务器 IP 被 TikTok 封禁');
                }

                // Log full error details for debugging when errors array is empty
                if (errors.length === 0 && errorReasons.length === 0) {
                    console.error(`[Wrapper] @${this.uniqueId} FetchIsLiveError with no nested errors. Full error:`, err);
                }

                for (const e of errors) {
                    const eMsg = e?.message || String(e);
                    const eCode = e?.code || e?.statusCode || '';

                    // Check for rate limiting indicators
                    if (eCode === 429 || eMsg?.includes?.('rate limit') || eMsg?.includes?.('Too Many Requests')) {
                        errorReasons.push('🚫 API 请求频率过高，已被限流');
                    } else if (eMsg?.includes?.('SIGI_STATE') || eMsg?.includes?.('blocked by TikTok')) {
                        errorReasons.push('🔒 服务器 IP 被 TikTok 封禁（无法解析页面）');
                    } else if (eMsg?.includes?.('InvalidResponseError') || e?.name === 'InvalidResponseError') {
                        errorReasons.push('❌ API 返回无效响应');
                    } else if (eMsg?.includes?.('lack of permission') || eMsg?.includes?.('Euler Stream')) {
                        errorReasons.push('🔑 Euler API Key 权限不足');
                    } else if (eMsg?.includes?.('timeout') || eMsg?.includes?.('Timeout')) {
                        errorReasons.push('⏱️ 连接超时');
                    } else if (eMsg?.includes?.('403') || eMsg?.includes?.('Forbidden')) {
                        errorReasons.push('🚫 访问被拒绝 (403)');
                    } else if (eMsg?.includes?.('ECONNRESET') || eMsg?.includes?.('ECONNREFUSED')) {
                        errorReasons.push('🔌 网络连接被重置');
                    } else if (eMsg && !errorReasons.some(r => r.includes(eMsg.slice(0, 30)))) {
                        // Only add if not already covered by another reason
                        errorReasons.push(`⚠️ ${eMsg.slice(0, 100)}`);
                    }
                }

                // Deduplicate error reasons
                const uniqueReasons = [...new Set(errorReasons)];

                if (uniqueReasons.length > 0) {
                    humanMessage = `无法获取房间信息:\n  ${uniqueReasons.join('\n  ')}`;
                } else {
                    humanMessage = `无法获取房间信息（未知原因）`;
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
            } else if (msg?.includes?.('falling back to API')) {
                humanMessage = '🔄 正在尝试备用连接方式...';
            } else if (msg?.includes?.('Error while connecting')) {
                humanMessage = '⚠️ 连接建立失败';
            } else {
                // Unknown error - show full message and stack
                humanMessage = msg;
                shouldShowStack = true;
            }

            this.log(`[ERROR] ${humanMessage}`);
            if (shouldShowStack && err?.stack) {
                console.error(err);
            }
        });
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