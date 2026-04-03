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

// [config-guard] Refuse to start with wrong model
(function() {
  var requiredModel = 'gemini-3.1-pro-preview';
  var currentModel = process.env.GEMINI_MODEL;
  if (!currentModel) { console.error('[config-guard] FATAL: GEMINI_MODEL not set'); process.exit(1); }
  if (currentModel !== requiredModel) { console.error('[config-guard] FATAL: GEMINI_MODEL=' + currentModel + ', expected ' + requiredModel); process.exit(1); }
  console.log('[config-guard] GEMINI_MODEL=' + currentModel + ' OK');
})();

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');

var config = require('./lib/config.cjs');
var { readProject, writeProject, listProjects, generateId } = require('./lib/project-store.cjs');
var { projectSM } = require("./lib/state-machine.cjs");
var TaskQueue = require('./lib/task-queue.cjs');
var middleware = require('./api/middleware.cjs');
var { createRouter } = require('./api/router.cjs');
var notify = require('./adapters/notify.cjs');
var { triggerCUAReview, resetCUARetries } = require('./adapters/server-cua-review.cjs');

var PORT = config.PORT;

// ============ Port Guard ============
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
    } catch(e2) {}
  }
  if (!pgPid) {
    try {
      var pgHex = PORT.toString(16).toUpperCase().padStart(4, '0');
      var pgTcp = fs.readFileSync('/proc/net/tcp', 'utf8');
      var pgLines = pgTcp.split('\n').filter(function(l) { return l.indexOf(':' + pgHex) !== -1 && l.indexOf('0A') !== -1; });
      if (pgLines.length > 0) {
        var pgInode = pgLines[0].trim().split(/\s+/)[9];
        var pgDirs = fs.readdirSync('/proc').filter(function(d) { return /^\d+$/.test(d); });
        for (var pgDir of pgDirs) {
          try {
            var pgFds = fs.readdirSync('/proc/' + pgDir + '/fd');
            for (var pgFd of pgFds) {
              try {
                var pgLink = fs.readlinkSync('/proc/' + pgDir + '/fd/' + pgFd);
                if (pgLink.indexOf('socket:[' + pgInode + ']') !== -1) { pgPid = parseInt(pgDir); break; }
              } catch(e3) {}
            }
            if (pgPid) break;
          } catch(e3) {}
        }
      }
    } catch(e2) {}
  }
  if (pgPid && pgPid !== process.pid) {
    console.log('[port-guard] Port ' + PORT + ' occupied by PID ' + pgPid + ', killing...');
    try { process.kill(pgPid, 'SIGTERM'); } catch(e2) {}
    var pgWait = Date.now(); while (Date.now() - pgWait < 1000) {}
    try { process.kill(pgPid, 'SIGKILL'); } catch(e2) {}
    pgWait = Date.now(); while (Date.now() - pgWait < 1000) {}
    console.log('[port-guard] Cleaned up PID ' + pgPid);
  }
} catch (e) { console.warn('[port-guard] skipped:', e.message); }

if (!process.env.pm_id) {
  console.warn('\n\u26A0\uFE0F  未通过 PM2 启动！手动测试请用: node server.cjs &  测完记得 kill');
  console.warn('\u26A0\uFE0F  生产启动请用: pm2 start ecosystem.config.js\n');
}

// ============ Ensure directories ============
if (!fs.existsSync(config.PROJECTS_DIR)) fs.mkdirSync(config.PROJECTS_DIR, { recursive: true });
if (!fs.existsSync(config.WEBGL_DIR)) fs.mkdirSync(config.WEBGL_DIR, { recursive: true });

// ============ Shared state ============
var taskQueue = new TaskQueue();
var modelProvider = require("./lib/model-provider.cjs");
var pipeline = require("./engine/pipeline.cjs");

var serverCtx = require('./lib/server-context.cjs');
var wakeOpenClaw = serverCtx.wakeOpenClaw;
var parseStats = serverCtx.parseStats;
var recordParseStat = serverCtx.recordParseStat;
var activeGenerations = serverCtx.activeGenerations;

// ============ Build shared ctx ============
var ctx = {
  taskQueue: taskQueue,
  config: config,
  sendJSON: middleware.sendJSON,
  readBody: middleware.readBody,
  serveStatic: middleware.serveStatic,
  readProject: readProject,
  writeProject: writeProject,
  listProjects: listProjects,
  generateId: generateId,
  notify: notify,
  wakeOpenClaw: wakeOpenClaw,
  triggerCUAReview: triggerCUAReview,
  resetCUARetries: resetCUARetries,
  parseStats: parseStats,
  recordParseStat: recordParseStat,
  activeGenerations: activeGenerations,
  modelProvider: modelProvider,
  pipeline: pipeline,
};

// ============ Init handler modules ============
var projectHandlers = require('./api/projects.cjs').init(ctx);
var workerHandlers = require('./api/worker.cjs').init(ctx);
var storyboardHandlers = require('./api/storyboard.cjs').init(ctx);
var dashboardHandlers = require('./api/dashboard.cjs').init(ctx);
var assetHandlers = require('./api/assets.cjs').init(ctx);

// Merge all handlers into one flat object
var allHandlers = Object.assign({},
  projectHandlers,
  workerHandlers,
  storyboardHandlers,
  dashboardHandlers,
  assetHandlers
);

// ============ Create router & server ============
var routeHandler = createRouter(allHandlers);

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;

  // Try API routes first
  if (routeHandler(req, res)) return;

  // WebGL static files
  if (pathname.startsWith('/webgl/')) {
    var webglFile = path.join(config.WEBGL_DIR, pathname.slice(7));
    if (middleware.serveStatic(res, webglFile, req)) return;
  }

  // Dashboard page
  if (pathname === '/dashboard' || pathname === '/dashboard.html') {
    var dashFile = path.join(__dirname, 'dashboard.html');
    if (middleware.serveStatic(res, dashFile, req)) return;
  }

  // Frontend static files
  var staticFile = path.join(config.DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  if (middleware.serveStatic(res, staticFile, req)) return;

  // SPA fallback
  var indexFile = path.join(config.DIST_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    middleware.serveStatic(res, indexFile, req);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.on('error', function(err) {
  if (err.code === 'EADDRINUSE') {
    console.error('[FATAL] Port ' + PORT + ' still in use after port-guard. Retrying in 2s...');
    setTimeout(function() { server.close(); server.listen(PORT); }, 2000);
    return;
  }
  throw err;
});

server.listen(PORT, function() {
  console.log('Blueprint Editor Server running on http://localhost:' + PORT);
  console.log('  Projects dir: ' + config.PROJECTS_DIR);
});

// ============ Stale Task Recovery ============
setInterval(function() {
  try {
    var result = taskQueue.reclaimStale(900, 180);
    if (result.count > 0) {
      console.log('[Stale Recovery] Reclaimed ' + result.count + ' stale task(s)');
      result.fixes.forEach(function(f) { console.log('[Stale Recovery]   ' + f); });
      result.fixes.forEach(function(f) {
        var taskIdMatch = f.match(/\] (\S+) ->/);
        if (taskIdMatch) {
          var staleProject = readProject(taskIdMatch[1]);
          if (staleProject && staleProject.status === 'processing') {
            projectSM.forceTransition(staleProject, 'submitted', 'stale-recovery');
            staleProject.statusMessage = '[watchdog] Task reclaimed, retrying';
            writeProject(staleProject);
          }
        }
      });
    }
  } catch (e) { console.warn('[Stale Recovery] Error: ' + e.message); }
}, 60000);

// ============ Graceful Shutdown ============
function gracefulShutdown(signal) {
  if (activeGenerations.count > 0) {
    console.log('[server] ' + signal + ' received, waiting for ' + activeGenerations.count + ' active generation(s)...');
    var waitCount = 0;
    var waitTimer = setInterval(function() {
      waitCount++;
      if (activeGenerations.count <= 0 || waitCount > 60) {
        clearInterval(waitTimer);
        if (activeGenerations.count > 0) console.log('[server] Force shutdown after 60s');
        else console.log('[server] All generations finished, shutting down');
        process.exit(0);
      }
    }, 1000);
    return;
  }
  console.log('[server] ' + signal + ' received, closing...');
  try { taskQueue.close(); } catch(e) {}
  server.close(function() { console.log('[server] Closed.'); process.exit(0); });
  setTimeout(function() { process.exit(1); }, 3000);
}
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });

// ============ Task Watchdog v2 ============
(function initTaskWatchdog() {
  var WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;
  var watchdogRuns = 0;
  setInterval(function() {
    watchdogRuns++;
    var result = dashboardHandlers.runWatchdogCycle('auto-' + watchdogRuns);
    if (result.issues.length > 0) {
      console.log('[Watchdog] Run #' + watchdogRuns + ': ' + result.issues.length + ' issue(s), ' + result.fixes.length + ' fix(es)');
      result.issues.forEach(function(i) { console.log('[Watchdog]   ' + i); });
      result.fixes.forEach(function(f) { console.log('[Watchdog]   ' + f); });
    }
    if (result.issues.length === 0 && watchdogRuns % 15 === 0) {
      console.log('[Watchdog] Run #' + watchdogRuns + ' — all clear');
    }
  }, WATCHDOG_INTERVAL_MS);
  console.log('[Watchdog] v2 (SQLite) initialized — interval ' + (WATCHDOG_INTERVAL_MS/1000) + 's');
})();
