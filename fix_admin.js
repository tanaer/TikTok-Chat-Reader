const db = require('./db.js');
db.run("UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'")
    .then(() => { console.log('Done'); process.exit(0); })
    .catch(console.error);
