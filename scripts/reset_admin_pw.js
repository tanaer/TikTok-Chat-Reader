require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const p = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root',
});
async function main() {
    const hash = await bcrypt.hash('admin123', 10);
    await p.query("UPDATE users SET password_hash = $1 WHERE username = 'admin'", [hash]);
    console.log('Admin password reset to admin123');
    await p.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
