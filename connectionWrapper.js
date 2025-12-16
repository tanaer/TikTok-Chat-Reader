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
if (process.env.EULER_API_KEY) {
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

        // Setup proxy agent - use options if valid, otherwise fallback to env
        // Important: ignore empty strings from database settings
        const proxyUrl = (options.proxyUrl && options.proxyUrl.trim())
            ? options.proxyUrl
            : (process.env.PROXY_URL || null);
        const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : null;
        if (proxyUrl) console.log(`[Proxy] Using proxy: ${proxyUrl}`);

        // Set API Key using KeyManager for rotation
        const apiKey = keyManager.getActiveKey();
        if (apiKey) {
            SignConfig.apiKey = apiKey;
            console.log(`[Wrapper] Using Euler Key: ${apiKey.slice(0, 10)}...`);
        } else if (options.eulerApiKey) {
            SignConfig.apiKey = options.eulerApiKey;
        } else if (process.env.EULER_API_KEY) {
            SignConfig.apiKey = process.env.EULER_API_KEY;
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
            // Suppress verbose stack trace for expected/handled errors
            const isExpectedError = msg?.includes?.('falling back to API') ||
                msg?.includes?.('Failed to extract') ||
                msg?.includes?.('SIGI_STATE') ||
                msg?.includes?.("isn't online") ||
                msg?.includes?.('UserOfflineError') ||
                msg?.includes?.('Error while connecting') ||
                msg?.includes?.('SignAPIError') ||
                msg?.includes?.('Sign Error') ||
                msg?.includes?.('sign server') ||
                msg?.includes?.('504') ||
                msg?.includes?.('500');
            if (isExpectedError) {
                // Brief message only - extract key info
                let briefMsg = 'Connection issue';
                if (msg?.includes?.('504') || msg?.includes?.('500') || msg?.includes?.('sign server')) {
                    briefMsg = 'Sign server temporarily unavailable';
                } else if (msg?.includes?.("isn't online")) {
                    briefMsg = 'User offline';
                } else if (msg?.includes?.('Failed to extract') || msg?.includes?.('SIGI_STATE')) {
                    briefMsg = 'Failed to parse room info';
                }
                this.log(`[WARN] ${briefMsg}`);
            } else {
                this.log(`Error: ${msg}`);
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