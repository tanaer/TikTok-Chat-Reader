const fs = require('fs');
const path = require('path');

// 1. Revert server.js
const serverPath = path.join(__dirname, '../server.js');
let serverContent = fs.readFileSync(serverPath, 'utf-8');

// Remove Import
serverContent = serverContent.replace("const KeyManager = require('./key_manager');\n", "");
serverContent = serverContent.replace("const keyManager = new KeyManager(process.env.EULER_KEYS || process.env.EULER_API_KEY || '');\n", "");

// Remove Endpoint
const endpointStart = "// User Analysis API with Load Balancing";
const startIdx = serverContent.indexOf(endpointStart);
if (startIdx !== -1) {
    // Find where it ends. It was inserted before "(async () => {"
    const endIdx = serverContent.lastIndexOf("(async () => {");
    if (endIdx > startIdx) {
        serverContent = serverContent.slice(0, startIdx) + serverContent.slice(endIdx);
        console.log('Removed Analysis API from server.js');
    }
}
fs.writeFileSync(serverPath, serverContent, 'utf-8');


// 2. Patch connectionWrapper.js
const wrapperPath = path.join(__dirname, '../connectionWrapper.js');
let wrapperContent = fs.readFileSync(wrapperPath, 'utf-8');

// Add Import
if (!wrapperContent.includes("require('./key_manager')")) {
    wrapperContent = wrapperContent.replace(
        "const { EventEmitter } = require('events');",
        "const { EventEmitter } = require('events');\nconst KeyManager = require('./key_manager');\nconst keyManager = new KeyManager(process.env.EULER_KEYS || process.env.EULER_API_KEY || '');"
    );
}

// Remove Static configuration
// Find: if (process.env.EULER_API_KEY) { ... }
// Replace with comment
wrapperContent = wrapperContent.replace(
    /if \(process\.env\.EULER_API_KEY\) \{[\s\S]*?console\.log\('\[Sign\] EulerStream API Key configured'\);\s*\}/,
    "// Static Euler Key config removed in favor of KeyManager"
);

// Modify connect() to inject key
// Find: connect(isReconnect = false) {
// Add key injection at start of connect
wrapperContent = wrapperContent.replace(
    "connect(isReconnect = false) {",
    `connect(isReconnect = false) {
        // Inject dynamic Euler Key
        const key = keyManager.getActiveKey();
        if (key) {
             SignConfig.apiKey = key;
             this.currentEulerKey = key;
             // this.log('Using Euler Key: ' + key.slice(0, 4) + '...');
        } else {
             this.log('Warning: No active Euler API Key available (All disabled or missing)');
        }
`
);

// Modify error handling to catch 429
// Find: this.log(`Error event triggered: ${err?.info || err?.message || err}`);
/*
  The error object from TikTokLiveConnection when signature fails might contain "Rate Limit" or status 429.
  We need to verify the error structure. Usually `err.info` or `err.message`.
*/

const errorHandlingCode = `
            // Check for Rate Limit to disable key
            const errMsg = (err?.info || err?.message || err || '').toString();
            if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit')) {
                if (this.currentEulerKey) {
                    this.log(\`Disabling Euler Key \${this.currentEulerKey.slice(0,4)}... due to Rate Limit\`);
                    keyManager.disableKey(this.currentEulerKey);
                }
            }
            this.log(\`Error event triggered: \${errMsg}\`);
            console.error(err);
`;

wrapperContent = wrapperContent.replace(
    /this\.log\(`Error event triggered: \$\{err\?\.info \|\| err\?\.message \|\| err\}`\);\s*console\.error\(err\);/,
    errorHandlingCode
);

fs.writeFileSync(wrapperPath, wrapperContent, 'utf-8');
console.log('Patched connectionWrapper.js with KeyManager');
