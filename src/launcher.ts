
import { spawn, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');

// Colors for logs
const colors = {
    service: '\x1b[36m', // Cyan
    ui: '\x1b[35m',      // Magenta
    reset: '\x1b[0m'
};

console.log('🚀 Starting Sync Client System (Two-Process Mode)...');

// 1. Start Background Service
const service = spawn('npx', ['ts-node', 'src/main.ts'], {
    cwd: rootDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, USE_NATIVE_WATCHER: 'true' } // Force native watcher for testing? Or make optional.
                                                       // Let's default to false unless arg passed, or respect existing env.
                                                       // Actually user wants to test native watcher. Let's pass it if env is not set?
                                                       // For now, let's inherit env.
});

console.log(`${colors.service}[Service] Starting... (PID: ${service.pid})${colors.reset}`);

service.stdout.on('data', (data) => {
    process.stdout.write(`${colors.service}[Service] ${data.toString()}${colors.reset}`);
});

service.stderr.on('data', (data) => {
    process.stderr.write(`${colors.service}[Service] ${data.toString()}${colors.reset}`);
});

// 2. Start Electron UI
// Wait a bit for service to potentially start pipe? (Not strictly required as UI retries)
const ui = spawn('npx', ['electron', '.'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
    env: process.env
});

console.log(`${colors.ui}[UI] Starting... (PID: ${ui.pid})${colors.reset}`);

// Handle shutdowns
const cleanup = () => {
    console.log('\n🛑 Shutting down processes...');
    if (!service.killed) service.kill();
    if (!ui.killed) ui.kill();
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

ui.on('close', (code) => {
    console.log(`UI exited with code ${code}`);
    cleanup();
});

service.on('close', (code) => {
    console.log(`Service exited with code ${code}`);
    cleanup();
});
