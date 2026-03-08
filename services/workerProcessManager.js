const { spawn } = require('child_process');
const path = require('path');
const metricsService = require('./metricsService');

class WorkerProcessManager {
    constructor(options = {}) {
        this.name = String(options.name || 'worker');
        this.scriptPath = options.scriptPath ? path.resolve(options.scriptPath) : '';
        this.cwd = options.cwd || process.cwd();
        this.env = { ...process.env, ...(options.env || {}) };
        this.enabled = Boolean(options.enabled);
        this.restartDelayMs = Math.max(1000, Number(options.restartDelayMs || 5000));
        this.maxRestarts = Math.max(0, Number(options.maxRestarts || 0));
        this.stopTimeoutMs = Math.max(1000, Number(options.stopTimeoutMs || 15000));
        this.child = null;
        this.starting = false;
        this.stopping = false;
        this.restartCount = 0;
        this.restartTimer = null;
        this.stopPromise = null;
        this.stopResolve = null;
    }

    isRunning() {
        return Boolean(this.child && !this.child.killed);
    }

    getStatus() {
        return {
            name: this.name,
            enabled: this.enabled,
            running: this.isRunning(),
            pid: this.child?.pid || null,
            restartCount: this.restartCount,
            scriptPath: this.scriptPath,
        };
    }

    start() {
        if (!this.enabled || !this.scriptPath || this.starting || this.isRunning()) {
            return false;
        }

        this.starting = true;
        this.stopping = false;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;

        const child = spawn(process.execPath, [this.scriptPath], {
            cwd: this.cwd,
            env: this.env,
            stdio: 'inherit',
        });

        this.child = child;
        this.starting = false;

        metricsService.emitLog('info', 'worker.guardian', {
            workerName: this.name,
            status: 'started',
            pid: child.pid,
            scriptPath: this.scriptPath,
            restartCount: this.restartCount,
        });

        child.on('error', (error) => {
            metricsService.emitLog('error', 'worker.guardian', {
                workerName: this.name,
                status: 'spawn_error',
                error: metricsService.safeErrorMessage(error),
            });
        });

        child.on('exit', (code, signal) => {
            const expected = this.stopping;
            const exitedChild = this.child;
            this.child = null;

            metricsService.emitLog(expected ? 'info' : 'warn', 'worker.guardian', {
                workerName: this.name,
                status: expected ? 'stopped' : 'exited',
                pid: exitedChild?.pid || null,
                exitCode: code,
                signal: signal || null,
                restartCount: this.restartCount,
            });

            if (this.stopResolve) {
                const resolve = this.stopResolve;
                this.stopResolve = null;
                this.stopPromise = null;
                resolve();
            }

            if (!expected && this.enabled) {
                if (this.maxRestarts > 0 && this.restartCount >= this.maxRestarts) {
                    metricsService.emitLog('error', 'worker.guardian', {
                        workerName: this.name,
                        status: 'restart_exhausted',
                        maxRestarts: this.maxRestarts,
                    });
                    return;
                }

                this.restartCount += 1;
                this.restartTimer = setTimeout(() => {
                    this.start();
                }, this.restartDelayMs);

                metricsService.emitLog('warn', 'worker.guardian', {
                    workerName: this.name,
                    status: 'restart_scheduled',
                    restartCount: this.restartCount,
                    restartDelayMs: this.restartDelayMs,
                });
            }
        });

        return true;
    }

    async stop(signal = 'SIGTERM') {
        this.stopping = true;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;

        if (!this.child) {
            return;
        }

        if (!this.stopPromise) {
            this.stopPromise = new Promise((resolve) => {
                this.stopResolve = resolve;
            });
        }

        const child = this.child;

        try {
            child.kill(signal);
        } catch (error) {
            metricsService.emitLog('warn', 'worker.guardian', {
                workerName: this.name,
                status: 'stop_signal_failed',
                signal,
                error: metricsService.safeErrorMessage(error),
            });
            if (this.stopResolve) {
                const resolve = this.stopResolve;
                this.stopResolve = null;
                this.stopPromise = null;
                resolve();
            }
        }

        const killTimer = setTimeout(() => {
            if (this.child && this.child.pid === child.pid) {
                metricsService.emitLog('warn', 'worker.guardian', {
                    workerName: this.name,
                    status: 'force_kill',
                    pid: child.pid,
                    stopTimeoutMs: this.stopTimeoutMs,
                });
                try {
                    this.child.kill('SIGKILL');
                } catch (error) {
                    metricsService.emitLog('error', 'worker.guardian', {
                        workerName: this.name,
                        status: 'force_kill_failed',
                        pid: child.pid,
                        error: metricsService.safeErrorMessage(error),
                    });
                }
            }
        }, this.stopTimeoutMs);

        try {
            await this.stopPromise;
        } finally {
            clearTimeout(killTimer);
        }
    }
}

module.exports = {
    WorkerProcessManager,
};
