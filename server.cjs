// Load .env before anything else (no dotenv dependency - manual parse)
try {
  var _envPath = require('path').join(__dirname, '.env');
  if (require('fs').existsSync(_envPath)) {
    require('fs').readFileSync(_envPath, 'utf8').split('\n').forEach(function(line) {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      var eq = line.indexOf('=');
      if (eq > 0) {
        var key = line.substring(0, eq).trim();
        var val = line.substring(eq + 1).trim().replace(/^["']|["']$/g, '');
        process.env[key] = val; // always override
      }
    });
    console.log('[env] Loaded .env from', _envPath);
  }
} catch(e) { console.warn('[env] Failed to load .env:', e.message); }

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const AdmZip = require('adm-zip');
const { triggerCUAReview, resetCUARetries } = require('./server-cua-review.cjs');
const notify = require('./notify.cjs');

const PORT = process.env.PORT || 3901;
const __dir = __dirname;

// 启动前清理占端口的孤儿进程（跨平台：先试 ss/lsof/fuser，都没有就用 /proc/net/tcp）
try {
  var pgPid = null;
  var pgCmds = [
    'ss -tlnp sport = :' + PORT + ' 2>/dev/null',
    'lsof -ti :' + PORT + ' 2>/dev/null',
    'fuser ' + PORT + '/tcp 2>/dev/null',
  ];
  for (var pgCmd of pgCmds) {
    try {
      var pgResult = require('child_process').execSync(pgCmd, { encoding: 'utf-8', timeout: 3000 }).trim();
      if (pgResult) {
        var pgPidMatch = pgResult.match(/pid=(\d+)/) || pgResult.match(/^(\d+)/m);
        if (pgPidMatch) { pgPid = parseInt(pgPidMatch[1]); break; }
      }
    } catch(e2) { /* tool not available, try next */ }
  }
  if (currentModel !== requiredModel) {
    console.error('[config-guard] FATAL: GEMINI_MODEL=' + currentModel + ', expected ' + requiredModel);
    process.exit(1);
  }
  if (pgPid && pgPid !== process.pid) {
    console.log('[port-guard] Port ' + PORT + ' occupied by PID ' + pgPid + ', killing...');
    try { process.kill(pgPid, 'SIGTERM'); } catch(e2) {}
    var pgWait = Date.now(); while (Date.now() - pgWait < 1000) {} // busy wait 1s (no sleep cmd needed)
    try { process.kill(pgPid, 'SIGKILL'); } catch(e2) {}
    pgWait = Date.now(); while (Date.now() - pgWait < 1000) {}
    console.log('[port-guard] Cleaned up PID ' + pgPid);
  }
} catch (e) { console.warn('[port-guard] skipped:', e.message); }

// 非 PM2 启动时警告（防止手动 node server.cjs 产生孤儿进程）
if (!process.env.pm_id) {
  console.warn('\n⚠️  未通过 PM2 启动！手动测试请用: node server.cjs &  测完记得 kill');
  console.warn('⚠️  生产启动请用: pm2 start ecosystem.config.js\n');
}

// Data directories
const DATA_DIR = path.join(__dir, 'server-data');

// autoCoding pipeline integration
const AUTOCODING_DIR = path.join(__dir, '..', 'autoCoding-tasks');
const AUTOCODING_QUEUE = path.join(AUTOCODING_DIR, 'queue');

// Signal file for OpenClaw wake — write a signal file that HEARTBEAT.md checks
const WAKE_SIGNAL_FILE = path.join(AUTOCODING_DIR, 'wake-signal.json');

function wakeOpenClaw(text) {
  try {
    fs.writeFileSync(WAKE_SIGNAL_FILE, JSON.stringify({
      text: text,
      timestamp: new Date().toISOString()
    }), 'utf-8');
    console.log('[wake] Signal file written: ' + WAKE_SIGNAL_FILE);
  } catch(e) {
    console.warn('[wake] Signal write failed: ' + e.message);
  }
}
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const WEBGL_DIR = path.join(DATA_DIR, 'webgl');
const DIST_DIR = path.join(__dir, 'dist');

if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!fs.existsSync(WEBGL_DIR)) fs.mkdirSync(WEBGL_DIR, { recursive: true });

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

// 