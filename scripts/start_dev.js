const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const PORT = 8081;

async function killPort(port) {
    if (process.platform !== 'win32') {
        console.log('Auto-kill not implemented for non-Windows yet.');
        return;
    }

    try {
        const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
        const lines = stdout.split('\n');
        const pids = new Set();

        for (const line of lines) {
            if (line.includes('LISTENING')) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1]; // PID is last column
                if (pid && parseInt(pid) > 0) {
                    pids.add(pid);
                }
            }
        }

        if (pids.size > 0) {
            console.log(`Found processes listening on port ${port}: ${[...pids].join(', ')}`);
            for (const pid of pids) {
                console.log(`Killing process ${pid}...`);
                try {
                    await execAsync(`taskkill /F /PID ${pid}`);
                    console.log(`Process ${pid} killed.`);
                } catch (e) {
                    console.warn(`Failed to kill ${pid}: ${e.message}`);
                }
            }
            // Give OS a moment to release
            await new Promise(r => setTimeout(r, 1000));
        }
    } catch (e) {
        // netstat might fail if no match (exit code 1)
        // console.log('Port appears free.');
    }
}

async function start() {
    console.log(`[Dev] Ensuring port ${PORT} is free...`);
    await killPort(PORT);

    console.log('[Dev] Starting server...');
    const server = spawn('node', ['server.js'], { stdio: 'inherit' });

    server.on('close', (code) => {
        console.log(`[Dev] Server exited with code ${code}`);
        process.exit(code);
    });
}

start();
