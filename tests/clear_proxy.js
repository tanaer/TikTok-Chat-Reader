const Database = require('better-sqlite3');
const db = new Database('./database.db');
db.prepare("DELETE FROM settings WHERE key IN ('proxy', 'proxy_url')").run();
console.log('Deleted proxy settings');
const rows = db.prepare("SELECT key, value FROM settings").all();
console.log('Remaining settings:', JSON.stringify(rows, null, 2));
db.close();
