// Deep dive into streamData structure
const fs = require('fs');

const html = fs.readFileSync('debug_tiktok_page.html', 'utf8');

const sigiMatch = html.match(/<script id="SIGI_STATE" type="application\/json">(.*?)<\/script>/);
if (sigiMatch) {
    const data = JSON.parse(sigiMatch[1]);
    const liveRoom = data.LiveRoom?.liveRoomUserInfo?.liveRoom;

    if (liveRoom) {
        console.log('=== liveRoom Structure ===');
        console.log('streamData:', JSON.stringify(liveRoom.streamData, null, 2).substring(0, 2000));
        console.log('\n=== hevcStreamData ===');
        console.log(JSON.stringify(liveRoom.hevcStreamData, null, 2).substring(0, 1000));

        // Try to find the actual stream URLs
        if (liveRoom.streamData?.pull_data?.stream_data) {
            console.log('\n=== Parsed stream_data ===');
            const streamData = JSON.parse(liveRoom.streamData.pull_data.stream_data);
            console.log(JSON.stringify(streamData, null, 2).substring(0, 3000));
        }
    }
}
