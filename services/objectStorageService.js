const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { getSchemeAConfig } = require('./featureFlagService');
const metricsService = require('./metricsService');

const AWS_ALGORITHM = 'AWS4-HMAC-SHA256';
const AWS_SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

class ObjectStorageError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ObjectStorageError';
        this.code = code;
        this.details = details;
        if (details.statusCode) this.statusCode = details.statusCode;
    }
}

function ensureUrl(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) {
        throw new ObjectStorageError('OBJECT_STORAGE_NOT_CONFIGURED', '对象存储 endpoint 未配置');
    }
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
}

function encodeRfc3986(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeHeaderValue(value) {
    return String(value).trim().replace(/\s+/g, ' ');
}

function formatAmzDate(now = new Date()) {
    const iso = now.toISOString();
    return {
        amzDate: iso.replace(/[:-]|\.\d{3}/g, ''),
        dateStamp: iso.slice(0, 10).replace(/-/g, ''),
    };
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
    return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function getSigningKey(secretKey, dateStamp, region, service) {
    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}

function guessContentType(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    switch (ext) {
        case '.mp4':
            return 'video/mp4';
        case '.mov':
            return 'video/quicktime';
        case '.mkv':
            return 'video/x-matroska';
        case '.webm':
            return 'video/webm';
        case '.m3u8':
            return 'application/vnd.apple.mpegurl';
        case '.json':
            return 'application/json';
        default:
            return 'application/octet-stream';
    }
}

class ObjectStorageService {
    constructor(config = null) {
        const schemeAConfig = getSchemeAConfig();
        this.config = config || schemeAConfig.objectStorage;
    }

    isConfigured() {
        return Boolean(
            this.config.endpoint &&
            this.config.bucket &&
            this.config.accessKeyId &&
            this.config.accessKeySecret
        );
    }

    ensureConfigured() {
        if (!this.isConfigured()) {
            throw new ObjectStorageError('OBJECT_STORAGE_NOT_CONFIGURED', '对象存储配置不完整');
        }
    }

    getEndpointUrl() {
        return ensureUrl(this.config.endpoint);
    }

    buildObjectPath(objectKey) {
        const endpointUrl = this.getEndpointUrl();
        const prefix = endpointUrl.pathname.replace(/\/+$/, '');
        const encodedBucket = encodeRfc3986(this.config.bucket);
        const encodedKey = String(objectKey || '')
            .split('/')
            .filter(Boolean)
            .map(encodeRfc3986)
            .join('/');
        const pathSegments = [prefix, encodedBucket, encodedKey].filter(Boolean);
        return `/${pathSegments.join('/').replace(/^\/+/, '')}`;
    }

    buildObjectUrl(objectKey, queryString = '') {
        const endpointUrl = this.getEndpointUrl();
        const url = new URL(endpointUrl.toString());
        url.pathname = this.buildObjectPath(objectKey);
        url.search = queryString ? `?${queryString}` : '';
        return url;
    }

    buildCanonicalQuery(query = {}) {
        return Object.entries(query)
            .flatMap(([key, value]) => {
                if (Array.isArray(value)) {
                    return value.map(item => [key, item]);
                }
                return [[key, value]];
            })
            .filter(([, value]) => value !== undefined && value !== null)
            .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
                if (leftKey === rightKey) {
                    return String(leftValue).localeCompare(String(rightValue));
                }
                return String(leftKey).localeCompare(String(rightKey));
            })
            .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
            .join('&');
    }

    buildCanonicalHeaders(headers = {}) {
        const normalized = Object.entries(headers)
            .map(([key, value]) => [String(key).toLowerCase(), normalizeHeaderValue(value)])
            .sort(([left], [right]) => left.localeCompare(right));

        return {
            canonicalHeaders: normalized.map(([key, value]) => `${key}:${value}\n`).join(''),
            signedHeaders: normalized.map(([key]) => key).join(';'),
            normalizedHeaders: Object.fromEntries(normalized),
        };
    }

    createSignature({ method, objectKey, query = {}, headers = {}, payloadHash = UNSIGNED_PAYLOAD, now = new Date(), includeAmzDateHeader = false }) {
        this.ensureConfigured();

        const endpointUrl = this.getEndpointUrl();
        const { amzDate, dateStamp } = formatAmzDate(now);
        const region = this.config.region || 'auto';
        const credentialScope = `${dateStamp}/${region}/${AWS_SERVICE}/aws4_request`;
        const canonicalUri = this.buildObjectPath(objectKey);
        const canonicalQuery = this.buildCanonicalQuery(query);
        const baseHeaders = {
            host: endpointUrl.host,
            ...(includeAmzDateHeader ? { 'x-amz-date': amzDate } : {}),
            ...headers,
        };
        const { canonicalHeaders, signedHeaders, normalizedHeaders } = this.buildCanonicalHeaders(baseHeaders);
        const canonicalRequest = [
            method.toUpperCase(),
            canonicalUri,
            canonicalQuery,
            canonicalHeaders,
            signedHeaders,
            payloadHash,
        ].join('\n');
        const stringToSign = [
            AWS_ALGORITHM,
            amzDate,
            credentialScope,
            sha256Hex(canonicalRequest),
        ].join('\n');
        const signingKey = getSigningKey(this.config.accessKeySecret, dateStamp, region, AWS_SERVICE);
        const signature = hmac(signingKey, stringToSign, 'hex');

        return {
            amzDate,
            dateStamp,
            credentialScope,
            signature,
            signedHeaders,
            normalizedHeaders,
            canonicalRequest,
            stringToSign,
        };
    }

    async uploadFile(objectKey, filePath, options = {}) {
        this.ensureConfigured();

        if (!filePath || !fs.existsSync(filePath)) {
            throw new ObjectStorageError('LOCAL_FILE_NOT_FOUND', '本地录播文件不存在', { filePath });
        }

        const startTime = Date.now();
        const payloadHash = UNSIGNED_PAYLOAD;
        const contentType = options.contentType || guessContentType(filePath);
        const headers = {
            'content-type': contentType,
            'x-amz-content-sha256': payloadHash,
        };
        const signed = this.createSignature({ method: 'PUT', objectKey, headers, payloadHash, includeAmzDateHeader: true });
        const authorization = `${AWS_ALGORITHM} Credential=${this.config.accessKeyId}/${signed.credentialScope}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`;
        const requestHeaders = {
            ...signed.normalizedHeaders,
            authorization,
            'x-amz-date': signed.amzDate,
        };
        const uploadUrl = this.buildObjectUrl(objectKey);
        const fileStats = await fs.promises.stat(filePath);

        metricsService.emitLog('info', 'object_storage.upload', {
            status: 'started',
            provider: this.config.provider,
            bucket: this.config.bucket,
            objectKey,
            fileSizeBytes: fileStats.size,
        });

        const response = await fetch(uploadUrl, {
            method: 'PUT',
            headers: requestHeaders,
            body: fs.createReadStream(filePath),
            duplex: 'half',
        });

        if (!response.ok) {
            const responseText = await response.text();
            metricsService.incrementCounter('object_storage.upload.failure', 1, { provider: this.config.provider }, { log: false });
            metricsService.emitLog('error', 'object_storage.upload', {
                status: 'error',
                provider: this.config.provider,
                bucket: this.config.bucket,
                objectKey,
                statusCode: response.status,
                durationMs: Date.now() - startTime,
                error: responseText.slice(0, 300),
            });
            throw new ObjectStorageError('OBJECT_STORAGE_UPLOAD_FAILED', '对象存储上传失败', {
                statusCode: response.status,
                responseText,
            });
        }

        const result = {
            provider: this.config.provider,
            bucket: this.config.bucket,
            objectKey,
            etag: (response.headers.get('etag') || '').replace(/"/g, '') || null,
            requestId: response.headers.get('x-amz-request-id') || response.headers.get('x-oss-request-id') || null,
            fileSizeBytes: fileStats.size,
            contentType,
        };

        metricsService.incrementCounter('object_storage.upload.success', 1, { provider: this.config.provider }, { log: false });
        metricsService.recordTiming('object_storage.upload.duration_ms', Date.now() - startTime, { provider: this.config.provider }, { log: false });
        metricsService.emitLog('info', 'object_storage.upload', {
            status: 'success',
            provider: this.config.provider,
            bucket: this.config.bucket,
            objectKey,
            durationMs: Date.now() - startTime,
            fileSizeBytes: fileStats.size,
            etag: result.etag,
        });

        return result;
    }

    async deleteObject(objectKey) {
        this.ensureConfigured();
        const startTime = Date.now();
        const payloadHash = sha256Hex('');
        const headers = {
            'x-amz-content-sha256': payloadHash,
        };
        const signed = this.createSignature({ method: 'DELETE', objectKey, headers, payloadHash, includeAmzDateHeader: true });
        const authorization = `${AWS_ALGORITHM} Credential=${this.config.accessKeyId}/${signed.credentialScope}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`;
        const response = await fetch(this.buildObjectUrl(objectKey), {
            method: 'DELETE',
            headers: {
                ...signed.normalizedHeaders,
                authorization,
                'x-amz-date': signed.amzDate,
            },
        });

        if (!response.ok && response.status !== 404) {
            const responseText = await response.text();
            metricsService.incrementCounter('object_storage.delete.failure', 1, { provider: this.config.provider }, { log: false });
            metricsService.emitLog('error', 'object_storage.delete', {
                status: 'error',
                provider: this.config.provider,
                bucket: this.config.bucket,
                objectKey,
                statusCode: response.status,
                durationMs: Date.now() - startTime,
                error: responseText.slice(0, 300),
            });
            throw new ObjectStorageError('OBJECT_STORAGE_DELETE_FAILED', '对象存储删除失败', {
                statusCode: response.status,
                responseText,
            });
        }

        metricsService.incrementCounter('object_storage.delete.success', 1, { provider: this.config.provider }, { log: false });
        metricsService.recordTiming('object_storage.delete.duration_ms', Date.now() - startTime, { provider: this.config.provider }, { log: false });
        metricsService.emitLog('info', 'object_storage.delete', {
            status: 'success',
            provider: this.config.provider,
            bucket: this.config.bucket,
            objectKey,
            durationMs: Date.now() - startTime,
            statusCode: response.status,
        });

        return {
            deleted: true,
            statusCode: response.status,
        };
    }

    createSignedGetUrl(objectKey, options = {}) {
        this.ensureConfigured();

        const expiresInSeconds = Math.max(60, Number(options.expiresInSeconds || this.config.signedUrlTtlSecs || 900));
        const now = options.now || new Date();
        const { amzDate, dateStamp } = formatAmzDate(now);
        const region = this.config.region || 'auto';
        const credentialScope = `${dateStamp}/${region}/${AWS_SERVICE}/aws4_request`;
        const query = {
            'X-Amz-Algorithm': AWS_ALGORITHM,
            'X-Amz-Credential': `${this.config.accessKeyId}/${credentialScope}`,
            'X-Amz-Date': amzDate,
            'X-Amz-Expires': String(expiresInSeconds),
            'X-Amz-SignedHeaders': 'host',
        };
        const signed = this.createSignature({
            method: 'GET',
            objectKey,
            query,
            headers: { host: this.getEndpointUrl().host },
            payloadHash: UNSIGNED_PAYLOAD,
            now,
        });
        const finalQuery = `${this.buildCanonicalQuery(query)}&X-Amz-Signature=${signed.signature}`;
        return this.buildObjectUrl(objectKey, finalQuery).toString();
    }

    getPublicObjectUrl(objectKey) {
        if (this.config.publicBaseUrl) {
            const url = new URL(this.config.publicBaseUrl.endsWith('/') ? this.config.publicBaseUrl : `${this.config.publicBaseUrl}/`);
            url.pathname = `${url.pathname.replace(/\/+$/, '')}/${String(objectKey || '').replace(/^\/+/, '')}`;
            return url.toString();
        }
        return this.buildObjectUrl(objectKey).toString();
    }
}

module.exports = {
    ObjectStorageService,
    ObjectStorageError,
    guessContentType,
    UNSIGNED_PAYLOAD,
};
