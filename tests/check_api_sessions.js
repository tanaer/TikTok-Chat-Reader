const { manager } = require('../manager');

(async () => {
    try {
        await manager.ensureDb();
        const sessions = await manager.getSessions('blooming1881');
        console.log('API Result:', JSON.stringify(sessions, null, 2));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
})();
