
const axios = require('axios');

async function test() {
    try {
        console.log('Sending POST request...');
        const res = await axios.post('http://localhost:8081/api/rooms', {
            roomId: "sweetly_anya",
            name: "帅酷印尼",
            address: "",
            isMonitorEnabled: false
        });
        console.log('Response:', res.data);
    } catch (e) {
        console.error('Error:', e.response ? e.response.data : e.message);
    }
}

test();
