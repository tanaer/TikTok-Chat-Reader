const { manager } = require('../manager');

async function testRoomStats() {
    console.log('Testing manager.getRoomStats()...');
    try {
        await manager.ensureDb();
        const stats = await manager.getRoomStats();
        console.log('Success. Stats:', JSON.stringify(stats, null, 2));
    } catch (err) {
        console.error('FAILED:', err);
    }
}

testRoomStats();
