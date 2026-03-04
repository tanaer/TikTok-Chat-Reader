const fs = require('fs');
const path = require('path');
const { pool, initDb } = require('./db');

async function runAllMigrations() {
    await initDb();
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        console.log(`Executing migration ${file}...`);
        const sqlPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(sqlPath, 'utf8');
        try {
            await pool.query(sql);
            console.log(`Migration ${file} completed successfully.`);
        } catch (err) {
            console.error(`Error executing ${file}:`, err.message);
            process.exit(1);
        }
    }
    console.log('All migrations executed successfully.');
}

runAllMigrations().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
