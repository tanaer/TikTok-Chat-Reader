const fs = require('fs');
const path = require('path');
const { getSchemeAConfig } = require('./featureFlagService');
const metricsService = require('./metricsService');
const { ObjectStorageService, ObjectStorageError, guessContentType } = require('./objectStorageService');

function sanitizeStorageSegment(value, fallback = 'unknown') {
    const normalized = String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
    return normalized || fallback;
}

function toDateParts(input) {
    const date = input ? new Date(input) : new Date();
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const year = safeDate.getUTCFullYear();
    const month = String(safeDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(safeDate.getUTCDate()).padStart(2, '0');
    return { year, month, day };
}

class RecordingStorageService {
    constructor(options = {}) {
        this.schemeAConfig = options.schemeAConfig || getSchemeAConfig();
        this.objectStorageService = options.objectStorageService || new ObjectStorageService(this.schemeAConfig.objectStorage);
    }

    isUploadEnabled() {
        return Boolean(this.schemeAConfig.worker.enableRecordingUpload);
    }

    buildObjectKey(task) {
        const { year, month, day } = toDateParts(task.startTime || task.endTime || new Date());
        const roomSegment = sanitizeStorageSegment(task.roomId, 'room');
        const taskIdSegment = sanitizeStorageSegment(task.id || 'task');
        const originalFileName = path.basename(task.filePath || `${roomSegment}-${taskIdSegment}.mp4`);
        const fileName = sanitizeStorageSegment(originalFileName, `${roomSegment}-${taskIdSegment}.mp4`);
        return `recordings/${year}/${month}/${day}/${roomSegment}/${taskIdSegment}-${fileName}`;
    }

    buildStorageMetadata(task) {
        let localFileExists = false;
        let localFileSize = null;
        try {
            if (task.filePath && fs.existsSync(task.filePath)) {
                localFileExists = true;
                localFileSize = fs.statSync(task.filePath).size;
            }
        } catch (error) {
            localFileExists = false;
        }

        return {
            taskId: Number(task.id || 0) || null,
            roomId: task.roomId || null,
            accountId: task.accountId ?? null,
            originalFileName: task.filePath ? path.basename(task.filePath) : null,
            localFileExists,
            localFileSize,
            startTime: task.startTime || null,
            endTime: task.endTime || null,
            status: task.status || null,
        };
    }

    async uploadRecordingTask(task) {
        if (!this.isUploadEnabled()) {
            throw new ObjectStorageError('RECORDING_UPLOAD_DISABLED', '录播上传功能未启用');
        }
        if (!task || !task.filePath) {
            throw new ObjectStorageError('RECORDING_TASK_INVALID', '录播任务缺少 file_path');
        }
        if (!fs.existsSync(task.filePath)) {
            throw new ObjectStorageError('LOCAL_FILE_NOT_FOUND', '本地录播文件不存在', { filePath: task.filePath });
        }

        const objectKey = task.storageObjectKey || this.buildObjectKey(task);
        const metadata = this.buildStorageMetadata(task);

        metricsService.emitLog('info', 'recording.upload_worker', {
            status: 'uploading',
            taskId: task.id,
            roomId: task.roomId,
            objectKey,
        });

        const uploadResult = await this.objectStorageService.uploadFile(objectKey, task.filePath, {
            contentType: guessContentType(task.filePath),
        });

        return {
            provider: this.schemeAConfig.objectStorage.provider,
            bucket: this.schemeAConfig.objectStorage.bucket,
            objectKey,
            etag: uploadResult.etag,
            requestId: uploadResult.requestId,
            fileSizeBytes: uploadResult.fileSizeBytes,
            contentType: uploadResult.contentType,
            metadata,
            publicUrl: this.objectStorageService.getPublicObjectUrl(objectKey),
        };
    }

    createRecordingSignedUrl(task, options = {}) {
        if (!task || !task.storageObjectKey) {
            throw new ObjectStorageError('RECORDING_TASK_NO_OBJECT', '录播任务尚未绑定对象存储 key');
        }
        return this.objectStorageService.createSignedGetUrl(task.storageObjectKey, options);
    }

    async deleteRecordingObject(task) {
        if (!task || !task.storageObjectKey) {
            throw new ObjectStorageError('RECORDING_TASK_NO_OBJECT', '录播任务尚未绑定对象存储 key');
        }
        return this.objectStorageService.deleteObject(task.storageObjectKey);
    }
}

module.exports = {
    RecordingStorageService,
    sanitizeStorageSegment,
};
