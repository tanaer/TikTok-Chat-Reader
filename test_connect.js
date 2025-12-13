const { WebcastPushConnection } = require('tiktok-live-connector');

// Get username from args or default
const username = process.argv[2] || '@mz.404__';

console.log(`Attempting to connect to ${username} with Node.js lib...`);

let connection = new WebcastPushConnection(username);

connection.connect()
    .then(state => {
        console.log(`SUCCESS: Connected to roomId ${state.roomId}`);
        process.exit(0);
    })
    .catch(err => {
        console.error(`FAILED: ${err.toString()}`);
        if (err.toString().includes('UserNotFound')) {
            console.log("Suggestion: User might be seemingly offline or blocked.");
        }
        process.exit(1);
    });
