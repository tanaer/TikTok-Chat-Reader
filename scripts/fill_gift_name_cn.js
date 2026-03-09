require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE || 'tkmonitor',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
});

const args = new Set(process.argv.slice(2));
const isDryRun = args.has('--dry-run');
const overrideFile = path.join(__dirname, 'gift_name_cn_overrides.json');

function loadOverrides() {
    if (!fs.existsSync(overrideFile)) return {};
    return JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeTranslation(nameEn, nameCn) {
    let value = String(nameCn || '').trim();
    if (!value) return value;

    if (nameEn.includes('TikTok')) {
        value = value.replace(/抖音/g, 'TikTok');
        value = value.replace(/TikTok(?=[\u4e00-\u9fff])/g, 'TikTok ');
    }

    if (nameEn.includes('LIVE')) {
        value = value.replace(/实时/g, '直播');
    }

    value = value
        .replace(/\s+/g, ' ')
        .replace(/’/g, '’')
        .replace(/&/g, '&')
        .trim();

    if (nameEn === 'Unknown') return '未知礼物';
    return value;
}

async function translateName(nameEn, attempt = 1) {
    if (nameEn === 'Unknown') return '未知礼物';
    if (/[\x{4e00}-\x{9fff}]/u.test(nameEn)) return nameEn;

    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(nameEn);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                Accept: 'application/json,text/plain,*/*',
            },
        });

        if (!response.ok) {
            throw new Error(`translate failed: ${response.status}`);
        }

        const data = await response.json();
        const translated = Array.isArray(data?.[0])
            ? data[0].map(item => item?.[0] || '').join('').trim()
            : '';

        if (!translated) {
            throw new Error('empty translation');
        }

        return normalizeTranslation(nameEn, translated);
    } catch (error) {
        if (attempt >= 4) throw error;
        await sleep(attempt * 500);
        return translateName(nameEn, attempt + 1);
    }
}

async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Map();
    let cursor = 0;

    async function runOne() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            const item = items[index];
            const value = await worker(item, index);
            results.set(item, value);
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => runOne()));
    return results;
}

async function main() {
    const overrides = loadOverrides();
    const { rows } = await pool.query(`
        SELECT DISTINCT TRIM(name_en) AS name_en
        FROM gift
        WHERE COALESCE(NULLIF(TRIM(name_en), ''), NULL) IS NOT NULL
        ORDER BY TRIM(name_en) ASC
    `);

    const names = rows.map(row => row.name_en);
    const resolved = await mapWithConcurrency(names, 6, async (nameEn, index) => {
        const translated = overrides[nameEn] || await translateName(nameEn);
        console.log(`[${index + 1}/${names.length}] ${nameEn} => ${translated}${overrides[nameEn] ? ' [override]' : ''}`);
        return translated;
    });

    const generatedMap = Object.fromEntries(
        Array.from(resolved.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    );

    const outputFile = '/tmp/gift_name_cn_map.generated.json';
    fs.writeFileSync(outputFile, JSON.stringify(generatedMap, null, 2));
    console.log(`Saved generated mapping to ${outputFile}`);

    if (isDryRun) {
        console.log('Dry run complete. Database was not updated.');
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const [nameEn, nameCn] of resolved.entries()) {
            await client.query(
                `UPDATE gift SET name_cn = $1, updated_at = NOW() WHERE TRIM(name_en) = $2`,
                [nameCn, nameEn]
            );
        }
        await client.query('COMMIT');
        console.log(`Updated ${resolved.size} unique English gift names.`);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
