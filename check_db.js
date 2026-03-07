require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'root'
});

pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('subscription_addons', 'room_addon_packages', 'payment_qr_codes')").then(r => {
    console.log('Tables:', r.rows);
    pool.end();
}).catch(err => {
    console.error('Error:', err.message);
});
