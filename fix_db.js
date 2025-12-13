
const { initDb, query, run } = require('./db');
const fs = require('fs');
const path = require('path');

(async () => {
    try {
        console.log('Initializing DB...');
        await initDb();
        console.log('DB Initialized.');

        const dbPath = path.join(__dirname, 'data.db');
        const backupPath = path.join(__dirname, 'data.db.bak');

        // Backup
        console.log(`Backing up ${dbPath} to ${backupPath}...`);
        fs.copyFileSync(dbPath, backupPath);

        // Fetch users
        const users = query('SELECT * FROM user');
        console.log(`Found ${users.length} users to migrate.`);

        if (users.length === 0) {
            console.log('No users to migrate.');
            return;
        }

        // Delete all
        console.log('Clearing user table...');
        run('DELETE FROM user');

        console.log('Inserting swapped users...');
        let count = 0;
        for (const u of users) {
            // Debug print first one
            if (count === 0) {
                console.log('Example before swap:', u);
            }

            // User request: 
            // Current user_id = Account (Handle)
            // Current unique_id = Code (Numeric)
            // Desired: user_id = Code (Numeric), unique_id = Account (Handle)

            // So newUserId = u.unique_id (The Code)
            // So newUniqueId = u.user_id (The Handle)

            // CAUTION: Ensure we don't insert nulls if data is missing
            const newUserId = u.unique_id || u.user_id; // Fallback
            const newUniqueId = u.user_id;

            run(`
                INSERT INTO user (user_id, unique_id, nickname, avatar, updated_at, common_language, mastered_languages)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [newUserId, newUniqueId, u.nickname, u.avatar, u.updated_at, u.common_language, u.mastered_languages]);

            count++;
        }

        console.log(`Migration complete. Processed ${count} users.`);

    } catch (err) {
        console.error('Migration failed:', err);
    }
})();
