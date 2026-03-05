try { require('dotenv').config(); } catch (e) { }
const fs = require('fs');
const path = require('path');
const { pool, initDb } = require('./db');

async function runAllMigrations() {
    await initDb();
    
    // Ensure schema_migrations table exists
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(50) PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT NOW()
        )
    `);
    
    // Get already applied migrations
    const { rows: applied } = await pool.query('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(applied.map(r => r.version));
    
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    let executed = 0;
    let skipped = 0;
    
    for (const file of files) {
        // Extract version from filename (e.g., "001_saas_schema.sql" -> "001_saas_schema")
        const version = file.replace('.sql', '');
        
        if (appliedVersions.has(version)) {
            console.log(`Skipping ${file} (already applied)`);
            skipped++;
            continue;
        }
        
        console.log(`Executing migration ${file}...`);
        const sqlPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(sqlPath, 'utf8');
        try {
            await pool.query(sql);
            console.log(`Migration ${file} completed successfully.`);
            executed++;
        } catch (err) {
            console.error(`Error executing ${file}:`, err.message);
            process.exit(1);
        }
    }
    
    console.log(`\n=== Migration Summary ===`);
    console.log(`Executed: ${executed}`);
    console.log(`Skipped: ${skipped}`);
    console.log('All migrations completed.');
}

runAllMigrations().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
