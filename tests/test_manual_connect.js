/**
 * Test manual connect through the full stack (simulates frontend)
 */
require('dotenv').config();

const { io } = require('socket.io-client');

const ROOM = process.argv[2] || 'yy001384';
const URL = 'http://localhost:8081';

console.log(`Testing manual connect to ${ROOM} via ${URL}...`);

const socket = io(URL, { transports: ['websocket'] });

socket.on('connect', () => {
    console.log('Socket connected, emitting setUniqueId...');
    socket.emit('setUniqueId', ROOM);
});

socket.on('connect_error', (err) => {
    console.log('Socket connect error:', err.message);
    process.exit(1);
});

socket.on('tiktokConnecting', (data) => {
    console.log('tiktokConnecting:', data);
});

socket.on('tiktokConnected', (data) => {
    console.log('');
    console.log('✅ tiktokConnected! Room ID:', data?.roomId);
    console.log('Waiting 5s for events...');

    let eventCount = 0;
    socket.on('chat', (msg) => {
        eventCount++;
        console.log(`[CHAT] ${msg.uniqueId}: ${msg.comment}`);
    });

    socket.on('gift', (msg) => {
        eventCount++;
        console.log(`[GIFT] ${msg.uniqueId}`);
    });

    setTimeout(() => {
        console.log(`\nTotal events: ${eventCount}`);
        socket.disconnect();
        process.exit(0);
    }, 5000);
});

socket.on('tiktokDisconnected', (reason) => {
    console.log('');
    console.log('❌ tiktokDisconnected:', reason);
    socket.disconnect();
    process.exit(1);
});

// Timeout
setTimeout(() => {
    console.log('Test timeout (60s)');
    process.exit(1);
}, 60000);
