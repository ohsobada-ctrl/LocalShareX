const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const os = require('os');

const PORT = 9090;
let backendProcess = null;
let frontendProcess = null;
let logClients = [];
let logBuffer = [];
const MAX_LOG_LINES = 200;

// Helper to broadcast logs to clients
function broadcastLog(source, text) {
    if (!text) return;
    const lines = text.toString().split(/\r?\n/);
    for (const line of lines) {
        if (line.trim() === '') continue;
        const logEntry = {
            source,
            text: line,
            time: new Date().toLocaleTimeString()
        };
        logBuffer.push(logEntry);
        if (logBuffer.length > MAX_LOG_LINES) {
            logBuffer.shift();
        }
        for (const client of logClients) {
            client.write(`event: log\ndata: ${JSON.stringify(logEntry)}\n\n`);
        }
    }
}

// Get Local Network IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

// Parse PIDs from netstat output
function getPidsFromNetstat(stdout) {
    if (!stdout) return [];
    const lines = stdout.trim().split('\n');
    const pids = new Set();
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !isNaN(pid) && pid !== '0') {
            pids.add(pid);
        }
    }
    return Array.from(pids);
}

// Kill processes listening on a specific port
function killProcessOnPort(port) {
    return new Promise((resolve) => {
        exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
            if (err || !stdout) {
                return resolve();
            }
            const pids = getPidsFromNetstat(stdout);
            if (pids.length === 0) return resolve();
            
            let killedCount = 0;
            pids.forEach((pid) => {
                exec(`taskkill /F /PID ${pid}`, () => {
                    killedCount++;
                    if (killedCount === pids.length) {
                        resolve();
                    }
                });
            });
        });
    });
}

// Clean Directory contents
function clearDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
        const curPath = path.join(dirPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
            clearDirectory(curPath);
            fs.rmdirSync(curPath);
        } else {
            fs.unlinkSync(curPath);
        }
    }
}

// Clean and kill a specific child process
function killProcess(proc) {
    if (!proc || proc.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        exec(`taskkill /pid ${proc.pid} /T /F`, () => {
            resolve();
        });
    });
}

// Start all services
async function startAll() {
    const isBackendRunning = backendProcess && backendProcess.exitCode === null;
    const isFrontendRunning = frontendProcess && frontendProcess.exitCode === null;

    if (isBackendRunning && isFrontendRunning) {
        broadcastLog('system', 'الخدمات تعمل بالفعل.');
        return;
    }

    broadcastLog('system', 'بدء فحص وتنظيف منافذ الشبكة...');
    await killProcessOnPort(7070);
    await killProcessOnPort(5050);

    // 1. Start Backend (FastAPI)
    const backendPath = path.join(__dirname, 'backend');
    const pythonPath = path.join(backendPath, 'venv', 'Scripts', 'python.exe');

    if (!fs.existsSync(pythonPath)) {
        broadcastLog('system', 'خطأ: لم يتم العثور على python.exe في المسار backend/venv/Scripts/python.exe');
        throw new Error('لم يتم العثور على البيئة الافتراضية للبايثون. يرجى تهيئة venv أولاً.');
    }

    broadcastLog('system', 'جاري تشغيل FastAPI Backend...');
    backendProcess = spawn('venv\\Scripts\\python.exe', ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '7070'], {
        cwd: backendPath,
        shell: true
    });

    backendProcess.stdout.on('data', (data) => broadcastLog('backend', data.toString()));
    backendProcess.stderr.on('data', (data) => broadcastLog('backend', data.toString()));
    backendProcess.on('close', (code) => {
        broadcastLog('system', `تم إغلاق السيرفر الخلفي (FastAPI) بكود: ${code}`);
        backendProcess = null;
    });

    // 2. Start Frontend (React/Vite)
    const frontendPath = path.join(__dirname, 'frontend');
    broadcastLog('system', 'جاري تشغيل React Frontend (Vite) على منفذ 5050...');
    
    frontendProcess = spawn('npm.cmd', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', '5050'], {
        cwd: frontendPath,
        shell: true
    });

    frontendProcess.stdout.on('data', (data) => broadcastLog('frontend', data.toString()));
    frontendProcess.stderr.on('data', (data) => broadcastLog('frontend', data.toString()));
    frontendProcess.on('close', (code) => {
        broadcastLog('system', `تم إغلاق الواجهة الأمامية (Vite) بكود: ${code}`);
        frontendProcess = null;
    });
}

// Stop all services
async function stopAll() {
    broadcastLog('system', 'جاري إيقاف الخدمات تنظيف المنافذ...');
    if (backendProcess) {
        await killProcess(backendProcess);
        backendProcess = null;
    }
    if (frontendProcess) {
        await killProcess(frontendProcess);
        frontendProcess = null;
    }
    await killProcessOnPort(7070);
    await killProcessOnPort(5050);
    broadcastLog('system', 'تم إيقاف جميع الخدمات بنجاح وتحرير المنافذ 7070 و 5050.');
}

// Handle Exit of Dashboard Server
function exitHandler() {
    console.log('Cleaning up child processes before exiting dashboard...');
    if (backendProcess && backendProcess.exitCode === null) {
        try { execSync(`taskkill /pid ${backendProcess.pid} /T /F`); } catch (e) {}
    }
    if (frontendProcess && frontendProcess.exitCode === null) {
        try { execSync(`taskkill /pid ${frontendProcess.pid} /T /F`); } catch (e) {}
    }
    try {
        const stdout7070 = execSync(`netstat -ano | findstr :7070`).toString();
        const pids = getPidsFromNetstat(stdout7070);
        pids.forEach(pid => execSync(`taskkill /F /PID ${pid}`));
    } catch (e) {}
    try {
        const stdout5050 = execSync(`netstat -ano | findstr :5050`).toString();
        const pids = getPidsFromNetstat(stdout5050);
        pids.forEach(pid => execSync(`taskkill /F /PID ${pid}`));
    } catch (e) {}
    process.exit();
}

process.on('SIGINT', exitHandler);
process.on('SIGTERM', exitHandler);
process.on('exit', exitHandler);

// HTTP Server configuration
const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (pathname === '/' || pathname === '/index.html') {
        fs.readFile(path.join(__dirname, 'dashboard_ui.html'), (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('خطأ في تحميل واجهة المستخدم');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(content);
            }
        });
    } else if (pathname === '/api/status' && req.method === 'GET') {
        const status = {
            backend: (backendProcess && backendProcess.exitCode === null) ? 'running' : 'stopped',
            frontend: (frontendProcess && frontendProcess.exitCode === null) ? 'running' : 'stopped',
            localIp: getLocalIP(),
            backendPort: 7070,
            frontendPort: 5050
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
    } else if (pathname === '/api/start' && req.method === 'POST') {
        startAll().then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        });
    } else if (pathname === '/api/stop' && req.method === 'POST') {
        stopAll().then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        });
    } else if (pathname === '/api/open-folder' && req.method === 'POST') {
        try {
            const uploadsPath = path.join(__dirname, 'backend', 'uploads');
            if (!fs.existsSync(uploadsPath)) {
                fs.mkdirSync(uploadsPath, { recursive: true });
            }
            exec(`explorer.exe "${uploadsPath}"`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    } else if (pathname === '/api/clear-storage' && req.method === 'POST') {
        try {
            clearDirectory(path.join(__dirname, 'backend', 'uploads'));
            clearDirectory(path.join(__dirname, 'backend', 'temp_uploads'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    } else if (pathname === '/api/logs' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Content-Encoding': 'none'
        });
        
        for (const log of logBuffer) {
            res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
        }
        
        logClients.push(res);
        
        req.on('close', () => {
            logClients = logClients.filter(client => client !== res);
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    const localIp = getLocalIP();
    console.log(`=======================================================`);
    console.log(`🚀 لوحة التحكم في السيرفر تعمل الآن!`);
    console.log(`👉 افتح الرابط التالي في المتصفح:`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   أو عبر الشبكة المحلية: http://${localIp}:${PORT}`);
    console.log(`=======================================================`);
    
    // Auto open browser on start
    try {
        exec(`start http://localhost:${PORT}`);
    } catch (e) {
        // Ignore if failed
    }
});
