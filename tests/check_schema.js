const { pool } = require('../db');

async function main() {
    const usersRes = await pool.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position"
    );
    console.log('=== users table ===');
    for (const r of usersRes.rows) {
        console.log(`  ${r.column_name} (${r.data_type}) nullable=${r.is_nullable}`);
    }

    const balRes = await pool.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'balance_log' ORDER BY ordinal_position"
    );
    console.log('\n=== balance_log table ===');
    for (const r of balRes.rows) {
        console.log(`  ${r.column_name} (${r.data_type}) nullable=${r.is_nullable}`);
    }

    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
