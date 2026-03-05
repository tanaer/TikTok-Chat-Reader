/**
 * SaaS Database Migration Script
 * 
 * Safely adds missing columns to EXISTING production tables.
 * Run with: node migrate_saas.js
 * 
 * Operations (all safe, idempotent):
 *   1. users: ADD username column
 *   2. balance_log: ADD balance_before column
 *   3. payment_records: ADD type, item_name, remark columns
 *   4. Populate username for existing users
 *   5. Create unique index on username
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root',
    max: 5,
});

async function migrate() {
    const client = await pool.connect();
    console.log('[Migrate] Connected to database.\n');

    try {
        await client.query('BEGIN');

        // =============================================
        // 1. users 表: 添加 username 列
        // =============================================
        console.log('--- Step 1: users.username ---');
        const hasUsername = await columnExists(client, 'users', 'username');
        if (!hasUsername) {
            await client.query(`ALTER TABLE users ADD COLUMN username VARCHAR(100)`);
            console.log('  [+] Added column: users.username');
        } else {
            console.log('  [=] Column already exists: users.username');
        }

        // 为已有用户填充 username（从 email 提取 @ 前部分，处理重复）
        const nullUsernames = await client.query(
            `SELECT id, email FROM users WHERE username IS NULL OR username = ''`
        );
        if (nullUsernames.rows.length > 0) {
            console.log(`  [*] Populating username for ${nullUsernames.rows.length} users...`);
            for (const row of nullUsernames.rows) {
                let base = row.email ? row.email.split('@')[0] : `user_${row.id}`;
                // 确保唯一性
                let candidate = base;
                let suffix = 1;
                while (true) {
                    const dup = await client.query(
                        `SELECT id FROM users WHERE username = $1 AND id != $2`, [candidate, row.id]
                    );
                    if (dup.rows.length === 0) break;
                    candidate = `${base}_${suffix++}`;
                }
                await client.query(`UPDATE users SET username = $1 WHERE id = $2`, [candidate, row.id]);
            }
            console.log(`  [+] Username populated for ${nullUsernames.rows.length} users.`);
        } else {
            console.log('  [=] All users already have username.');
        }

        // 创建唯一索引（IF NOT EXISTS）
        await client.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL`
        );
        console.log('  [+] Unique index on users.username ensured.\n');

        // =============================================
        // 2. balance_log 表: 添加 balance_before 列
        // =============================================
        console.log('--- Step 2: balance_log.balance_before ---');
        const hasBalanceBefore = await columnExists(client, 'balance_log', 'balance_before');
        if (!hasBalanceBefore) {
            await client.query(`ALTER TABLE balance_log ADD COLUMN balance_before INTEGER DEFAULT 0`);
            console.log('  [+] Added column: balance_log.balance_before\n');
        } else {
            console.log('  [=] Column already exists: balance_log.balance_before\n');
        }

        // =============================================
        // 3. payment_records 表: 添加 type, item_name, remark 列
        // =============================================
        console.log('--- Step 3: payment_records columns ---');
        const cols = [
            { name: 'type', sql: `ALTER TABLE payment_records ADD COLUMN type VARCHAR(30)` },
            { name: 'item_name', sql: `ALTER TABLE payment_records ADD COLUMN item_name VARCHAR(200)` },
            { name: 'remark', sql: `ALTER TABLE payment_records ADD COLUMN remark TEXT` },
        ];
        for (const col of cols) {
            const exists = await columnExists(client, 'payment_records', col.name);
            if (!exists) {
                await client.query(col.sql);
                console.log(`  [+] Added column: payment_records.${col.name}`);
            } else {
                console.log(`  [=] Column already exists: payment_records.${col.name}`);
            }
        }

        // =============================================
        // 4. 修复 balance_log 外键约束 (旧表 -> 新表)
        //    使用 NOT VALID 避免已有孤立数据阻塞迁移
        // =============================================
        console.log('\n--- Step 4: Fix balance_log foreign keys ---');

        // 检查并修复 balance_log.user_id FK (app_user -> users)
        const fkUser = await client.query(
            `SELECT ccu.table_name AS foreign_table FROM information_schema.table_constraints AS tc
             JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
             WHERE tc.table_name = 'balance_log' AND tc.constraint_type = 'FOREIGN KEY'
             AND tc.constraint_name = 'balance_log_user_id_fkey'`
        );
        if (fkUser.rows.length > 0 && fkUser.rows[0].foreign_table !== 'users') {
            await client.query(`ALTER TABLE balance_log DROP CONSTRAINT balance_log_user_id_fkey`);
            await client.query(`ALTER TABLE balance_log ADD CONSTRAINT balance_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID`);
            console.log('  [+] Fixed: balance_log.user_id -> users.id (NOT VALID for existing rows)');
        } else if (fkUser.rows.length === 0) {
            await client.query(`ALTER TABLE balance_log ADD CONSTRAINT balance_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID`);
            console.log('  [+] Added: balance_log.user_id -> users.id (NOT VALID)');
        } else {
            console.log('  [=] balance_log.user_id FK already correct');
        }

        // 检查并修复 balance_log.order_id FK (orders -> payment_records)
        const fkOrder = await client.query(
            `SELECT ccu.table_name AS foreign_table FROM information_schema.table_constraints AS tc
             JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
             WHERE tc.table_name = 'balance_log' AND tc.constraint_type = 'FOREIGN KEY'
             AND tc.constraint_name = 'balance_log_order_id_fkey'`
        );
        if (fkOrder.rows.length > 0 && fkOrder.rows[0].foreign_table !== 'payment_records') {
            await client.query(`ALTER TABLE balance_log DROP CONSTRAINT balance_log_order_id_fkey`);
            await client.query(`ALTER TABLE balance_log ADD CONSTRAINT balance_log_order_id_fkey FOREIGN KEY (order_id) REFERENCES payment_records(id) NOT VALID`);
            console.log('  [+] Fixed: balance_log.order_id -> payment_records.id (NOT VALID for existing rows)');
        } else if (fkOrder.rows.length === 0) {
            await client.query(`ALTER TABLE balance_log ADD CONSTRAINT balance_log_order_id_fkey FOREIGN KEY (order_id) REFERENCES payment_records(id) NOT VALID`);
            console.log('  [+] Added: balance_log.order_id -> payment_records.id (NOT VALID)');
        } else {
            console.log('  [=] balance_log.order_id FK already correct');
        }

        await client.query('COMMIT');
        console.log('\n========================================');
        console.log('[Migrate] All migrations completed successfully!');
        console.log('========================================\n');

        // =============================================
        // 4. 验证
        // =============================================
        console.log('--- Verification ---');
        await verify(client, 'users', ['username']);
        await verify(client, 'balance_log', ['balance_before']);
        await verify(client, 'payment_records', ['type', 'item_name', 'remark']);

        const userCount = await client.query(`SELECT COUNT(*) AS c FROM users`);
        const withUsername = await client.query(`SELECT COUNT(*) AS c FROM users WHERE username IS NOT NULL AND username != ''`);
        console.log(`\n  Users total: ${userCount.rows[0].c}, with username: ${withUsername.rows[0].c}`);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('\n[Migrate] ERROR - Transaction rolled back:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

async function columnExists(client, table, column) {
    const result = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, column]
    );
    return result.rows.length > 0;
}

async function verify(client, table, columns) {
    for (const col of columns) {
        const exists = await columnExists(client, table, col);
        console.log(`  ${exists ? '[OK]' : '[FAIL]'} ${table}.${col}`);
    }
}

migrate().catch(err => {
    console.error('[Migrate] Fatal error:', err);
    process.exit(1);
});
