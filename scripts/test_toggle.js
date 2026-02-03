const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function testToggle() {
    console.log('Testing PUT /api/tiktok_accounts/1 status toggle...');

    // First enable
    try {
        const res1 = await fetch('http://localhost:8081/api/tiktok_accounts/1', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isActive: 1 })
        });

        if (res1.ok) {
            const data = await res1.json();
            console.log('Enable Result:', data);
            if (data.is_active === 1) console.log('✅ Enable Successful');
            else console.log('❌ Enable Failed: is_active is ' + data.is_active);
        } else {
            console.log('❌ Enable Failed:', res1.status, await res1.text());
        }
    } catch (e) {
        console.log('❌ Connection error:', e.message);
    }

    // Then disable
    try {
        const res2 = await fetch('http://localhost:8081/api/tiktok_accounts/1', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isActive: 0 })
        });

        if (res2.ok) {
            const data = await res2.json();
            console.log('Disable Result:', data);
            if (data.is_active === 0) console.log('✅ Disable Successful');
            else console.log('❌ Disable Failed: is_active is ' + data.is_active);
        } else {
            console.log('❌ Disable Failed:', res2.status, await res2.text());
        }
    } catch (e) {
        console.log('❌ Connection error:', e.message);
    }
}

testToggle();
