const { TikTokConnectionWrapper } = require('../connectionWrapper');

const target = 'blooming1881';

(async () => {
    console.log(`Checking status_code for ${target}...`);
    const wrapper = new TikTokConnectionWrapper(target, {}, true);

    try {
        await wrapper.connect();
        if (wrapper.connection) {
            const state = wrapper.connection.state;
            console.log('Connection State:', JSON.stringify(state, null, 2));
            if (state.roomInfo) {
                console.log('status_code:', state.roomInfo.status_code);
                console.log('status:', state.roomInfo.status);
            } else {
                console.log('No roomInfo in state.');
            }
            wrapper.disconnect();
        }
    } catch (e) {
        console.error('Connection failed:', e);
    }
})();
