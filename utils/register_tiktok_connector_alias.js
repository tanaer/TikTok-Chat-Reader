const fs = require('fs');
const path = require('path');
const Module = require('module');

function resolveConnectorDist() {
    try {
        const pkgJsonPath = require.resolve('tiktok-live-connector/package.json');
        return path.join(path.dirname(pkgJsonPath), 'dist');
    } catch (err) {
        return path.resolve(__dirname, '..', '..', 'TikTok-Live-Connector', 'dist');
    }
}

function registerTikTokConnectorAlias() {
    if (global.__tiktokConnectorAliasInstalled) return;

    const connectorDist = resolveConnectorDist();
    if (!fs.existsSync(connectorDist)) return;

    const originalResolveFilename = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
        if (typeof request === 'string' && request.startsWith('@/')) {
            const target = path.join(connectorDist, request.slice(2));
            return originalResolveFilename.call(this, target, parent, isMain, options);
        }
        return originalResolveFilename.call(this, request, parent, isMain, options);
    };

    global.__tiktokConnectorAliasInstalled = true;
}

module.exports = { registerTikTokConnectorAlias };
