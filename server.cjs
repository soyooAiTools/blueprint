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

// [config-guard] Check LLM provider API key
(function() {
  var doubaoKey = process.env.DOUBAO_API_KEY;
  if (!doubaoKey) { console.warn('[config-guard] WARN: DOUBAO_API_KEY not set — LLM features may fail'); }
  else { console.log('[config-guard] DOUBAO_API_KEY OK'); }
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

// Ops modules (extracted from harness)
var { killPortOccupier } = require('./lib/port-guard.cjs');
var { initWatchdog } = require('./lib/watchdog.cjs');
var { initGracefulShutdown } = require('./lib/lifecycle.cjs');

var PORT = config.PORT;

// ============ Port Guard ============
// Under PM2 cluster mode the LISTEN socket for PORT is held by the PM2 God Daemon
// (not by any worker process), so ss/lsof would report PM2's PID as the "occupier".
// Killing it used to cascade-kill ALL apps (incident 2026-04-15 16:40). PM2 handles
// port conflicts itself during reload, so skip port-guard entirely when under PM2.
if (!process.env.pm_id) {
  try { killPortOccupier(PORT); } catch (e) { console.warn('[port-guard] skipped:', e.message); }
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
var storyboardFlowHandlers = require('./api/storyboard-flow.cjs').init(ctx);
var dashboardHandlers = require('./api/dashboard.cjs').init(ctx);
var assetHandlers = require('./api/assets.cjs').init(ctx);

// Merge all handlers into one flat object
var allHandlers = Object.assign({},
  projectHandlers,
  workerHandlers,
  storyboardHandlers,
  storyboardFlowHandlers,
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

  // 反馈 01 (2026-04-26): frontend/dist/ 已 untrack,新部署若忘了 npm run build,
  // 这里给明确诊断而非静默 404,免得运维以为是路由 bug。
  if (pathname === '/' || !path.extname(pathname)) {
    console.error('[FATAL] SPA entry missing: ' + indexFile + ' — run: cd frontend && npm run build');
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Frontend not built. On the server, run: cd frontend && npm run build');
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

// ============ Ops: watchdog + lifecycle (delegated to lib/) ============
if (process.env.BLUEPRINT_DISABLE_WATCHDOG === '1') {
  console.log('[Watchdog] disabled by BLUEPRINT_DISABLE_WATCHDOG=1');
} else {
  initWatchdog({
    taskQueue: taskQueue,
    readProject: readProject,
    writeProject: writeProject,
    projectSM: projectSM,
    runWatchdogCycle: dashboardHandlers.runWatchdogCycle,
  });
}

initGracefulShutdown({
  server: server,
  taskQueue: taskQueue,
  activeGenerations: activeGenerations,
});
