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
    const tables = ['users', 'balance_log', 'payment_records', 'refresh_tokens', 'subscription_plans', 'user_subscriptions', 'room_addon_packages', 'user_room_addons'];
    for (const t of tables) {
        const r = await p.query(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position", [t]
        );
        console.log(`\n${t} (${r.rows.length} columns):`);
        for (const row of r.rows) {
            console.log(`  ${row.column_name} (${row.data_type})`);
        }
    }
    await p.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
