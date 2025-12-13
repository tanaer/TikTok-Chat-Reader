
const http = require('http');

console.log('Testing http://localhost:8081/ ...');
const start = Date.now();

const req = http.get('http://localhost:8081/', (res) => {
    const ttfb = Date.now() - start;
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const total = Date.now() - start;
        console.log(`--------------------------------`);
        console.log(`Status Code: ${res.statusCode}`);
        console.log(`TTFB (Time to First Byte): ${ttfb} ms`);
        console.log(`Total Download Time: ${total} ms`);
        console.log(`Content Length: ${data.length} bytes`);
        console.log(`--------------------------------`);

        if (total < 200) {
            console.log('RESULT: Server is responding INSTANTLY.');
        } else if (total < 1000) {
            console.log('RESULT: Server response is normal.');
        } else {
            console.log('RESULT: Server response is SLOW.');
        }
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
});
