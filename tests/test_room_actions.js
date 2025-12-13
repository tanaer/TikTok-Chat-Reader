const { manager } = require('../manager');

async function testRoomActions() {
    console.log('Test: Creating dummy room...');
    await manager.updateRoom('dummy_test_room', 'Dummy Room', null);

    console.log('Test: Fetching detail stats (should be empty but succeed)...');
    const stats = await manager.getRoomDetailStats('dummy_test_room');
    console.log('Stats:', JSON.stringify(stats, null, 2));

    console.log('Test: Deleting dummy room...');
    await manager.deleteRoom('dummy_test_room');

    // Verify deletion
    const rooms = await manager.getRooms();
    const exists = rooms.find(r => r.room_id === 'dummy_test_room');
    if (exists) {
        console.error('FAILED: Room still exists.');
    } else {
        console.log('SUCCESS: Room deleted.');
    }
}

testRoomActions();
