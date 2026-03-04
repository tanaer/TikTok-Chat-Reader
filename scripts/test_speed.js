const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function runTests() {
    console.log('--- Performance Test ---');

    // 1. Refresh user_stats background job
    console.log('\n[Triggering /api/maintenance/refresh_user_stats]');
    let start = Date.now();
    let res = await fetch('http://127.0.0.1:3000/api/maintenance/refresh_user_stats', { method: 'POST' });
    let data = await res.json();
    console.log(`Time: ${Date.now() - start}ms`, data);

    // 2. Test /api/analysis/users
    console.log('\n[Testing /api/analysis/users]');
    start = Date.now();
    res = await fetch('http://127.0.0.1:3000/api/analysis/users?minRooms=1&page=1&pageSize=50');
    data = await res.json();
    console.log(`Time: ${Date.now() - start}ms`, `Results: ${data.users?.length}`);

    // 3. Test /api/analysis/rooms/entry (using some arbitrary dates over a week)
    console.log('\n[Testing /api/analysis/rooms/entry]');
    start = Date.now();
    res = await fetch('http://127.0.0.1:3000/api/analysis/rooms/entry?startDate=2026-02-19&endDate=2026-02-26&limit=100');
    data = await res.json();
    console.log(`Time: ${Date.now() - start}ms`, `Results: ${data.length}`);
}

runTests().catch(console.error);
