const { SocksClient } = require('socks');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

/**
 * ProxyChainAgent (SOCKS5 Chain Version)
 * 
 * Implements a double-hop proxy agent:
 * Local SOCKS5 Proxy -> Dynamic SOCKS5 Proxy -> Target
 * 
 * Uses SocksClient.createConnectionChain for nested tunnels.
 */
class ProxyChainAgent extends https.Agent {
    constructor(options) {
        super(options);
        // localProxy: "socks5://127.0.0.1:7891"
        // dynamicProxy: { hostname, port, username, password }
        this.localProxy = options.localProxy;
        this.dynamicProxy = options.dynamicProxy;
    }

    createConnection(options, callback) {
        const localUrl = new URL(this.localProxy.replace('socks5h://', 'socks5://'));

        // Define the proxy chain: [Local, Dynamic]
        const proxies = [
            {
                host: localUrl.hostname,
                port: parseInt(localUrl.port),
                type: 5
            },
            {
                host: this.dynamicProxy.hostname,
                port: parseInt(this.dynamicProxy.port),
                type: 5,
                userId: this.dynamicProxy.username || undefined,
                password: this.dynamicProxy.password || undefined
            }
        ];

        // Destination for the final hop
        const destination = {
            host: options.host,
            port: options.port
        };

        // Create the chained connection
        SocksClient.createConnectionChain({
            proxies: proxies,
            destination: destination,
            command: 'connect',
            timeout: 30000
        })
            .then(info => {
                const socket = info.socket;

                // Upgrade to TLS for HTTPS target (port 443)
                if (options.port === 443) {
                    const secureSocket = tls.connect({
                        socket: socket,
                        servername: options.host,
                        rejectUnauthorized: false
                    }, () => {
                        callback(null, secureSocket);
                    });

                    secureSocket.on('error', (e) => callback(e));
                } else {
                    // Plain TCP for non-HTTPS
                    callback(null, socket);
                }
            })
            .catch(err => {
                callback(err);
            });
    }
}

module.exports = ProxyChainAgent;
