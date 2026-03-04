#!/usr/bin/env node
/**
 * Seed Admin Account
 * Creates or resets admin@localhost with a proper bcrypt hash
 * 
 * Usage: node scripts/seed_admin.js
 * Default credentials: admin@localhost / admin123
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../db');

const ADMIN_EMAIL = 'admin@localhost';
const ADMIN_PASSWORD = 'admin123';
const SALT_ROUNDS = 12;

async function seedAdmin() {
    try {
        console.log('[Seed] Generating bcrypt hash for admin password...');
        const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);

        // Check if admin exists
        const existing = await db.get('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]);

        if (existing) {
            // Update existing admin with proper bcrypt hash
            await db.run(
                `UPDATE users SET password_hash = $1, role = 'admin', status = 'active', updated_at = NOW() WHERE email = $2`,
                [passwordHash, ADMIN_EMAIL]
            );
            console.log(`[Seed] ✅ Admin account updated: ${ADMIN_EMAIL}`);
        } else {
            // Create new admin
            await db.run(
                `INSERT INTO users (email, password_hash, nickname, role, status, email_verified)
                 VALUES ($1, $2, '管理员', 'admin', 'active', true)`,
                [ADMIN_EMAIL, passwordHash]
            );
            console.log(`[Seed] ✅ Admin account created: ${ADMIN_EMAIL}`);
        }

        console.log(`[Seed] 📧 Email: ${ADMIN_EMAIL}`);
        console.log(`[Seed] 🔑 Password: ${ADMIN_PASSWORD}`);
        console.log('[Seed] ⚠️  Please change the password after first login!');

        process.exit(0);
    } catch (err) {
        console.error('[Seed] ❌ Failed:', err.message);
        process.exit(1);
    }
}

seedAdmin();
