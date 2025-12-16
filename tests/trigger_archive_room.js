const http = require('http');

const roomId = process.argv[2];
if (!roomId) {
    console.error('Please provide room ID');
    process.exit(1);
}

const options = {
    hostname: 'localhost',
    port: 8081,
    path: `/api/rooms/${roomId}/archive_stale`,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    }
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    let data = '';

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        console.log('BODY:', data);
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.end();
