// Test PostgreSQL connection
const { Pool } = require('pg');

const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'tkmonitor',
    user: 'postgres',
    password: 'root',
    connectionTimeoutMillis: 5000,
});

console.log('Testing PostgreSQL connection...');

pool.query('SELECT NOW() as current_time')
    .then(result => {
        console.log('✅ Connection successful!');
        console.log('Current time:', result.rows[0].current_time);
        return pool.end();
    })
    .catch(err => {
        console.error('❌ Connection failed:', err.message);
        console.error('Error code:', err.code);
        return pool.end();
    })
    .finally(() => {
        process.exit(0);
    });
