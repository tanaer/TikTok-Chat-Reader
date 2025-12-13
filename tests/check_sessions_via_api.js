const http = require('http');

const options = {
    hostname: 'localhost',
    port: 8081,
    path: '/api/rooms/blooming1881/sessions',
    method: 'GET',
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
        try {
            const json = JSON.parse(data);
            console.log(`Found ${json.length} sessions`);
            if (json.length > 0) {
                console.log('First session:', json[0]);
            }
        } catch (e) {
            console.log('BODY:', data);
        }
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.end();
