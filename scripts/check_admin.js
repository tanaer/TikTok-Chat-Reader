require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root',
});
async function main() {
    const r = await p.query("SELECT id, username, email, role, status FROM users WHERE role = 'admin' LIMIT 5");
    console.log('Admin users:', JSON.stringify(r.rows, null, 2));
    await p.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
