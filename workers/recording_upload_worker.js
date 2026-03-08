require('dotenv').config();

const fs = require('fs');
const db = require('../db');
const metricsService = require('../services/metricsService');
const { getSchemeAConfig } = require('../services/featureFlagService');
const { RecordingStorageService } = require('../services/recordingStorageService');

const DEFAULT_MAX_UPLOAD_ATTEMPTS = 5;
const DEFAULT_MAX_CLEANUP_ATTEMPTS = 10;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildWorkerTaskSelectSql(limit, maxAttempts) {
    return {
        sql: `
            SELECT id
            FROM recording_task
            WHERE status IN ('local_completed', 'upload_failed', 'completed')
              AND file_path IS NOT NULL
              AND file_path <> ''
              AND COALESCE(upload_status, 'not_requested') IN ('not_requested', 'pending', 'failed')
              AND COALESCE(upload_attempt_count, 0) < $1
            ORDER BY COALESCE(end_time, start_time) ASC, id ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
        `,
        params: [maxAttempts, limit],
    };
}

function buildCleanupTaskSelectSql(limit, cutoffTime, maxAttempts) {
    return {
        sql: `
            SELECT id
            FROM recording_task
            WHERE status = 'uploaded'
              AND file_path IS NOT NULL
              AND file_path <> ''
              AND COALESCE(upload_status, 'not_requested') = 'uploaded'
              AND COALESCE(cleanup_status, 'not_requested') IN ('pending', 'failed')
              AND COALESCE(cleanup_attempt_count, 0) < $1
              AND COALESCE(upload_completed_at, end_time, start_time) <= $2
            ORDER BY COALESCE(upload_completed_at, end_time, start_time) ASC, id ASC
            LIMIT $3
            FOR UPDATE SKIP LOCKED
        `,
        params: [maxAttempts, cutoffTime, limit],
    };
}

class RecordingUploadWorker {
    constructor(options = {}) {
        this.schemeAConfig = options.schemeAConfig || getSchemeAConfig();
        this.recordingStorageService = options.recordingStorageService || new RecordingStorageService({
            schemeAConfig: this.schemeAConfig,
        });
        this.pollMs = this.schemeAConfig.worker.recordingUploadPollMs;
        this.batchSize = this.schemeAConfig.worker.recordingUploadBatchSize;
        this.cleanupBatchSize = this.schemeAConfig.worker.recordingLocalCleanupBatchSize;
        this.cleanupDelayMs = this.schemeAConfig.worker.recordingLocalCleanupDelayMs;
        this.maxUploadAttempts = Math.max(1, Number(process.env.RECORDING_UPLOAD_MAX_ATTEMPTS || DEFAULT_MAX_UPLOAD_ATTEMPTS));
        this.maxCleanupAttempts = Math.max(1, Number(process.env.RECORDING_LOCAL_CLEANUP_MAX_ATTEMPTS || DEFAULT_MAX_CLEANUP_ATTEMPTS));
        this.shuttingDown = false;
    }

    async init() {
        await db.initDb();
        if (!this.schemeAConfig.worker.enableRecordingUpload) {
            metricsService.emitLog('warn', 'recording.upload_worker', {
                status: 'disabled',
                reason: 'feature_flag_off',
            });
            return false;
        }

        this.recordingStorageService.objectStorageService.ensureConfigured();

        metricsService.emitLog('info', 'recording.upload_worker', {
            status: 'started',
            pollMs: this.pollMs,
            batchSize: this.batchSize,
            cleanupBatchSize: this.cleanupBatchSize,
            cleanupDelayMs: this.cleanupDelayMs,
            cleanupEnabled: this.schemeAConfig.worker.enableRecordingLocalCleanup,
            maxUploadAttempts: this.maxUploadAttempts,
            provider: this.schemeAConfig.objectStorage.provider,
            bucket: this.schemeAConfig.objectStorage.bucket,
        });
        return true;
    }

    async claimPendingTasks(limit = this.batchSize) {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const selectQuery = buildWorkerTaskSelectSql(limit, this.maxUploadAttempts);
            const selectResult = await client.query(selectQuery.sql, selectQuery.params);
            const ids = selectResult.rows.map(row => row.id);

            if (ids.length === 0) {
                await client.query('COMMIT');
                return [];
            }

            const updateResult = await client.query(`
                UPDATE recording_task
                SET status = 'uploading',
                    upload_status = 'uploading',
                    upload_started_at = NOW(),
                    upload_attempt_count = COALESCE(upload_attempt_count, 0) + 1,
                    upload_error_msg = NULL,
                    cleanup_status = 'blocked',
                    storage_provider = COALESCE(storage_provider, $2),
                    storage_bucket = COALESCE(storage_bucket, $3)
                WHERE id = ANY($1::int[])
                RETURNING id, room_id, account_id, start_time, end_time, file_path, file_size,
                          status, error_msg, storage_provider, storage_bucket, storage_object_key,
                          storage_metadata_json, upload_status, upload_attempt_count, cleanup_status
            `, [ids, this.schemeAConfig.objectStorage.provider, this.schemeAConfig.objectStorage.bucket]);
            await client.query('COMMIT');
            return updateResult.rows.map(row => db.toCamelCase(row));
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async claimCleanupTasks(limit = this.cleanupBatchSize) {
        if (!this.schemeAConfig.worker.enableRecordingLocalCleanup) {
            return [];
        }

        const cutoffTime = new Date(Date.now() - this.cleanupDelayMs).toISOString();
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const selectQuery = buildCleanupTaskSelectSql(limit, cutoffTime, this.maxCleanupAttempts);
            const selectResult = await client.query(selectQuery.sql, selectQuery.params);
            const ids = selectResult.rows.map(row => row.id);

            if (ids.length === 0) {
                await client.query('COMMIT');
                return [];
            }

            const updateResult = await client.query(`
                UPDATE recording_task
                SET cleanup_status = 'deleting',
                    cleanup_started_at = NOW(),
                    cleanup_attempt_count = COALESCE(cleanup_attempt_count, 0) + 1,
                    cleanup_error_msg = NULL
                WHERE id = ANY($1::int[])
                RETURNING id, room_id, file_path, status, upload_status, cleanup_status,
                          cleanup_attempt_count, storage_object_key, upload_completed_at
            `, [ids]);
            await client.query('COMMIT');
            return updateResult.rows.map(row => db.toCamelCase(row));
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async markTaskUploaded(task, uploadResult) {
        const metadataJson = JSON.stringify({
            task: uploadResult.metadata,
            upload: {
                requestId: uploadResult.requestId || null,
                contentType: uploadResult.contentType || null,
                publicUrl: uploadResult.publicUrl || null,
            },
        });

        await db.pool.query(`
            UPDATE recording_task
            SET status = 'uploaded',
                storage_provider = $2,
                storage_bucket = $3,
                storage_object_key = $4,
                storage_etag = $5,
                storage_metadata_json = $6,
                file_size = COALESCE(file_size, $7),
                upload_status = 'uploaded',
                upload_completed_at = NOW(),
                upload_error_msg = NULL,
                cleanup_status = CASE
                    WHEN $8 = true THEN 'pending'
                    ELSE 'skipped'
                END,
                cleanup_started_at = NULL,
                cleanup_completed_at = CASE WHEN $8 = true THEN cleanup_completed_at ELSE NOW() END,
                cleanup_error_msg = NULL
            WHERE id = $1
        `, [
            task.id,
            uploadResult.provider,
            uploadResult.bucket,
            uploadResult.objectKey,
            uploadResult.etag,
            metadataJson,
            uploadResult.fileSizeBytes || null,
            this.schemeAConfig.worker.enableRecordingLocalCleanup,
        ]);
    }

    async markTaskFailed(task, error) {
        await db.pool.query(`
            UPDATE recording_task
            SET status = 'upload_failed',
                upload_status = 'failed',
                upload_error_msg = $2,
                cleanup_status = 'blocked'
            WHERE id = $1
        `, [task.id, metricsService.safeErrorMessage(error)]);
    }

    async markCleanupSucceeded(task) {
        await db.pool.query(`
            UPDATE recording_task
            SET status = 'local_deleted',
                cleanup_status = 'deleted',
                cleanup_completed_at = NOW(),
                cleanup_error_msg = NULL,
                local_file_deleted_at = NOW()
            WHERE id = $1
        `, [task.id]);
    }

    async markCleanupFailed(task, error) {
        await db.pool.query(`
            UPDATE recording_task
            SET status = 'uploaded',
                cleanup_status = 'failed',
                cleanup_error_msg = $2
            WHERE id = $1
        `, [task.id, metricsService.safeErrorMessage(error)]);
    }

    async deleteLocalFile(task) {
        if (!task.filePath) {
            return { deleted: false, reason: 'missing_file_path' };
        }
        if (!fs.existsSync(task.filePath)) {
            return { deleted: false, reason: 'already_missing' };
        }
        await fs.promises.unlink(task.filePath);
        return { deleted: true, reason: 'deleted' };
    }

    async processTask(task) {
        const startTime = Date.now();
        try {
            const uploadResult = await this.recordingStorageService.uploadRecordingTask(task);
            await this.markTaskUploaded(task, uploadResult);
            metricsService.incrementCounter('recording.upload_worker.success', 1, {}, { log: false });
            metricsService.recordTiming('recording.upload_worker.duration_ms', Date.now() - startTime, { outcome: 'success' }, { log: false });
            metricsService.emitLog('info', 'recording.upload_worker', {
                status: 'success',
                taskId: task.id,
                roomId: task.roomId,
                durationMs: Date.now() - startTime,
                objectKey: uploadResult.objectKey,
                uploadAttemptCount: task.uploadAttemptCount,
                cleanupStatus: this.schemeAConfig.worker.enableRecordingLocalCleanup ? 'pending' : 'skipped',
            });
            return { success: true, taskId: task.id };
        } catch (error) {
            await this.markTaskFailed(task, error);
            metricsService.incrementCounter('recording.upload_worker.failure', 1, {}, { log: false });
            metricsService.recordTiming('recording.upload_worker.duration_ms', Date.now() - startTime, { outcome: 'error' }, { log: false });
            metricsService.emitLog('error', 'recording.upload_worker', {
                status: 'error',
                taskId: task.id,
                roomId: task.roomId,
                durationMs: Date.now() - startTime,
                uploadAttemptCount: task.uploadAttemptCount,
                error: metricsService.safeErrorMessage(error),
                errorCode: error.code || null,
            });
            return { success: false, taskId: task.id, error };
        }
    }

    async processCleanupTask(task) {
        const startTime = Date.now();
        try {
            const result = await this.deleteLocalFile(task);
            await this.markCleanupSucceeded(task);
            metricsService.incrementCounter('recording.cleanup_worker.success', 1, { reason: result.reason }, { log: false });
            metricsService.recordTiming('recording.cleanup_worker.duration_ms', Date.now() - startTime, { outcome: 'success' }, { log: false });
            metricsService.emitLog('info', 'recording.cleanup_worker', {
                status: 'success',
                taskId: task.id,
                roomId: task.roomId,
                durationMs: Date.now() - startTime,
                result: result.reason,
            });
            return { success: true, taskId: task.id };
        } catch (error) {
            await this.markCleanupFailed(task, error);
            metricsService.incrementCounter('recording.cleanup_worker.failure', 1, {}, { log: false });
            metricsService.recordTiming('recording.cleanup_worker.duration_ms', Date.now() - startTime, { outcome: 'error' }, { log: false });
            metricsService.emitLog('error', 'recording.cleanup_worker', {
                status: 'error',
                taskId: task.id,
                roomId: task.roomId,
                durationMs: Date.now() - startTime,
                cleanupAttemptCount: task.cleanupAttemptCount,
                error: metricsService.safeErrorMessage(error),
            });
            return { success: false, taskId: task.id, error };
        }
    }

    async runOnce() {
        const claimedTasks = await this.claimPendingTasks(this.batchSize);
        let processedUploads = 0;

        if (claimedTasks.length > 0) {
            metricsService.emitLog('info', 'recording.upload_worker', {
                status: 'claimed',
                batchSize: claimedTasks.length,
            });

            for (const task of claimedTasks) {
                if (this.shuttingDown) break;
                await this.processTask(task);
                processedUploads += 1;
            }
        }

        const cleanupTasks = await this.claimCleanupTasks(this.cleanupBatchSize);
        let processedCleanup = 0;
        if (cleanupTasks.length > 0) {
            metricsService.emitLog('info', 'recording.cleanup_worker', {
                status: 'claimed',
                batchSize: cleanupTasks.length,
            });

            for (const task of cleanupTasks) {
                if (this.shuttingDown) break;
                await this.processCleanupTask(task);
                processedCleanup += 1;
            }
        }

        return {
            claimedUploads: claimedTasks.length,
            processedUploads,
            claimedCleanup: cleanupTasks.length,
            processedCleanup,
        };
    }

    async run() {
        const shouldRun = await this.init();
        if (!shouldRun) return;

        while (!this.shuttingDown) {
            try {
                await this.runOnce();
            } catch (error) {
                metricsService.emitLog('error', 'recording.upload_worker', {
                    status: 'loop_error',
                    error: metricsService.safeErrorMessage(error),
                });
            }
            if (!this.shuttingDown) {
                await sleep(this.pollMs);
            }
        }

        metricsService.emitLog('info', 'recording.upload_worker', {
            status: 'stopped',
        });
    }

    requestShutdown(signal = 'manual') {
        this.shuttingDown = true;
        metricsService.emitLog('warn', 'recording.upload_worker', {
            status: 'shutdown_requested',
            signal,
        });
    }
}

if (require.main === module) {
    const worker = new RecordingUploadWorker();
    process.on('SIGINT', () => worker.requestShutdown('SIGINT'));
    process.on('SIGTERM', () => worker.requestShutdown('SIGTERM'));

    worker.run().catch(error => {
        console.error('[RECORDING_UPLOAD_WORKER] Fatal error:', error);
        process.exitCode = 1;
    });
}

module.exports = {
    RecordingUploadWorker,
    buildWorkerTaskSelectSql,
    buildCleanupTaskSelectSql,
};
