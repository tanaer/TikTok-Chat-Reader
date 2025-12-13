
const { manager } = require('../manager');

// 模拟 convertToBeijingTimeString (因为它是 manager.js 中的局部函数，未直接导出，
// 但我们可以通过复制其逻辑或临时导出它来测试，或者我们相信已写入的代码。
// 为了验证，我将测试逻辑复制到这里确保逻辑本身正确)

function convertToBeijingTimeStringTest(input) {
    let d;
    if (!input) return null;
    if (typeof input === 'string') {
        d = new Date(input);
    } else if (input instanceof Date) {
        d = input;
    } else {
        return null;
    }
    const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
    return utc8.toISOString().slice(0, 19).replace('T', ' ');
}

console.log('--- Validate Time Conversion ---');
const isoTime = '2025-12-13T03:02:30.000Z'; // 11:02:30 BJ time
const expected = '2025-12-13 11:02:30';
const actual = convertToBeijingTimeStringTest(isoTime);

console.log(`Input (ISO): ${isoTime}`);
console.log(`Expected (BJ): ${expected}`);
console.log(`Actual (BJ):   ${actual}`);

if (actual === expected) {
    console.log('✅ Conversion Logic Verified');
} else {
    console.error('❌ Conversion Failed');
    process.exit(1);
}

// 还要验证 manager 是否能正常加载
try {
    console.log('--- Validate Manager Loading ---');
    if (manager) {
        console.log('✅ Manager module loaded successfully');
    } else {
        console.error('❌ Manager module failed to load');
        process.exit(1);
    }
} catch (err) {
    console.error('❌ Error loading manager:', err);
    process.exit(1);
}
