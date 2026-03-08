#!/usr/bin/env node
require('dotenv').config();

const db = require('../db');

function parseArgs(argv = []) {
    const options = {
        days: 60,
        batchSize: 500,
        maxBatches: 0,
        startId: 0,
        dryRun: false,
    };

    for (const arg of argv) {
        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }
        const [rawKey, rawValue] = arg.split('=');
        const key = String(rawKey || '').trim();
        const value = rawValue === undefined ? '' : rawValue.trim();
        switch (key) {
            case '--days':
                options.days = Number(value || options.days);
                break;
            case '--batch-size':
                options.batchSize = Number(value || options.batchSize);
                break;
            case '--max-batches':
                options.maxBatches = Number(value || options.maxBatches);
                break;
            case '--start-id':
                options.startId = Number(value || options.startId);
                break;
            default:
                break;
        }
    }

    options.days = Number.isFinite(options.days) && options.days > 0 ? Math.trunc(options.days) : 60;
    options.batchSize = Number.isFinite(options.batchSize) && options.batchSize > 0 ? Math.trunc(options.batchSize) : 500;
    options.maxBatches = Number.isFinite(options.maxBatches) && options.maxBatches >= 0 ? Math.trunc(options.maxBatches) : 0;
    options.startId = Number.isFinite(options.startId) && options.startId >= 0 ? Math.trunc(options.startId) : 0;
    return options;
}

function printHelp() {
    console.log(`用法: node scripts/backfill_event_columns.js [options]\n\n选项:\n  --days=60         仅回填最近 N 天事件\n  --batch-size=500  每批处理条数\n  --max-batches=0   最多处理批次数，0 表示直到处理完\n  --start-id=0      从指定 event.id 之后开始，便于断点续跑\n  --dry-run         仅扫描并输出统计，不执行更新\n  -h, --help        查看帮助`);
}

function parseJsonPayload(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function toOptionalText(value) {
    if (value === undefined || value === null || value === '') return null;
    return String(value);
}

function toInteger(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toBooleanInteger(value) {
    if (value === true || value === 1 || value === '1') return 1;
    if (value === false || value === 0 || value === '0') return 0;
    const normalized = String(value || '').trim().toLowerCase();
    if (['true', 'yes', 'y', 'on'].includes(normalized)) return 1;
    if (['false', 'no', 'n', 'off'].includes(normalized)) return 0;
    return 0;
}

function extractBackfillValues(payload = {}) {
    return {
        giftName: toOptionalText(payload.giftName || payload.gift_name),
        giftImage: toOptionalText(payload.giftImage || payload.giftPictureUrl || payload.gift_image),
        groupId: toOptionalText(payload.groupId || payload.group_id),
        region: toOptionalText(payload.region),
        isAdmin: toBooleanInteger(payload.isAdmin || payload.is_admin),
        isSuperAdmin: toBooleanInteger(payload.isSuperAdmin || payload.is_super_admin),
        isModerator: toBooleanInteger(payload.isModerator || payload.is_moderator),
        fanLevel: toInteger(payload.fanLevel || payload.fan_level, 0),
        fanClubName: toOptionalText(payload.fanClubName || payload.fan_club_name),
    };
}

async function fetchBatch(afterId, days, batchSize) {
    const result = await db.pool.query(
        `SELECT id, data_json
         FROM event
         WHERE id > $1
           AND timestamp >= NOW() - ($2::text || ' days')::interval
           AND data_json IS NOT NULL
           AND data_json != ''
           AND (
                gift_name IS NULL OR gift_name = ''
             OR gift_image IS NULL OR gift_image = ''
             OR group_id IS NULL OR group_id = ''
             OR region IS NULL OR region = ''
             OR COALESCE(is_admin, 0) = 0
             OR COALESCE(is_super_admin, 0) = 0
             OR COALESCE(is_moderator, 0) = 0
             OR COALESCE(fan_level, 0) = 0
             OR fan_club_name IS NULL OR fan_club_name = ''
           )
         ORDER BY id ASC
         LIMIT $3`,
        [afterId, String(days), batchSize]
    );
    return result.rows.map(row => db.toCamelCase(row));
}

async function applyBackfill(rowId, values, dryRun = false) {
    if (dryRun) return 0;
    const result = await db.pool.query(
        `UPDATE event
         SET gift_name = COALESCE(NULLIF(gift_name, ''), $2),
             gift_image = COALESCE(NULLIF(gift_image, ''), $3),
             group_id = COALESCE(NULLIF(group_id, ''), $4),
             region = COALESCE(NULLIF(region, ''), $5),
             is_admin = CASE WHEN COALESCE(is_admin, 0) = 1 THEN 1 ELSE $6 END,
             is_super_admin = CASE WHEN COALESCE(is_super_admin, 0) = 1 THEN 1 ELSE $7 END,
             is_moderator = CASE WHEN COALESCE(is_moderator, 0) = 1 THEN 1 ELSE $8 END,
             fan_level = CASE WHEN COALESCE(fan_level, 0) > 0 THEN fan_level ELSE $9 END,
             fan_club_name = COALESCE(NULLIF(fan_club_name, ''), $10)
         WHERE id = $1`,
        [
            rowId,
            values.giftName,
            values.giftImage,
            values.groupId,
            values.region,
            values.isAdmin,
            values.isSuperAdmin,
            values.isModerator,
            values.fanLevel,
            values.fanClubName,
        ]
    );
    return result.rowCount || 0;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    await db.initDb();

    const stats = {
        scanned: 0,
        updated: 0,
        matched: 0,
        parsed: 0,
        parseFailed: 0,
        skippedEmpty: 0,
        batches: 0,
        lastId: options.startId,
    };

    let afterId = options.startId;
    console.log('[backfill_event_columns] start', options);

    while (true) {
        if (options.maxBatches > 0 && stats.batches >= options.maxBatches) {
            break;
        }

        const rows = await fetchBatch(afterId, options.days, options.batchSize);
        if (!rows.length) {
            break;
        }

        stats.batches += 1;
        for (const row of rows) {
            const rowId = Number(row.id || 0);
            afterId = rowId;
            stats.lastId = rowId;
            stats.scanned += 1;

            const payload = parseJsonPayload(row.dataJson);
            if (!payload) {
                stats.parseFailed += 1;
                continue;
            }
            stats.parsed += 1;

            const values = extractBackfillValues(payload);
            const hasAnyValue = Object.values(values).some(value => value !== null && value !== '' && value !== 0);
            if (!hasAnyValue) {
                stats.skippedEmpty += 1;
                continue;
            }

            stats.matched += 1;
            if (options.dryRun) {
                continue;
            }
            stats.updated += await applyBackfill(rowId, values, false);
        }

        console.log(`[backfill_event_columns] batch=${stats.batches} scanned=${stats.scanned} updated=${stats.updated} lastId=${stats.lastId} matched=${stats.matched}`);
    }

    console.log('[backfill_event_columns] done', stats);
}

main()
    .catch((error) => {
        console.error('[backfill_event_columns] fatal:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await db.pool.end().catch(() => {});
    });
