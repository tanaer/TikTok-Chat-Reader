const { manager } = require('../manager');

async function testRooms() {
    console.log('Testing manager.getRooms()...');
    try {
        await manager.ensureDb();
        const rooms = await manager.getRooms();
        console.log('Success. Rooms:', rooms);
    } catch (err) {
        console.error('FAILED:', err);
    }
}

testRooms();
