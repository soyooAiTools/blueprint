/**
 * health-api.cjs — 独立监控模块
 * 在 server.cjs 里一行引入：require('./health-api.cjs')(server, sendJSON, DATA_DIR, workerHeartbeats)
 * 或者直接挂载到 http server 上
 * 
 * 提供：
 *   GET  /api/health   — 探针状态
 *   GET  /api/alerts   — 告警列表
 *   POST /api/alerts   — 提交告警
 *   GET  /api/errors   — 错误列表
 *   POST /api/errors   — 提交错误
 *   GET  /dashboard    — Dashboard HTML
 */
var fs = require('fs');
var path = require('path');
var https = require('https');

var WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/b9c59492-4949-4950-a34b-913bf1c7df08';
var _alertsCache = [];
var _errorsCache = [];
var _lastNotifyMap = {}; // dedup: title → timestamp

// Load persisted data
function loadCache(dir) {
  try { _alertsCache = JSON.parse(fs.readFileSync(path.join(dir, 'pending-alerts.json'), 'utf-8')); } catch(e) {}
  try { _errorsCache = JSON.parse(fs.readFileSync(path.join(dir, 'errors.json'), 'utf-8')); } catch(e) {}
}

function saveAlerts(dir) {
  try { fs.writeFileSync(path.join(dir, 'pending-alerts.json'), JSON.stringify(_alertsCache)); } catch(e) {}
}

function saveErrors(dir) {
  try { fs.writeFileSync(path.join(dir, 'errors.json'), JSON.stringify(_errorsCache)); } catch(e) {}
}

// Feishu webhook notification (no auth needed, domestic direct)
function notifyFeishu(level, title, detail) {
  try {
    var now = Date.now();
    var key = level + ':' + title;
    if (_lastNotifyMap[key] && now - _lastNotifyMap[key] < 300000) return; // 5min dedup
    _lastNotifyMap[key] = now;

    var emoji = (level === 'critical' || level === 'error') ? '\ud83d\udd34' : level === 'warning' ? '\ud83d\udfe1' : '\ud83d\udd35';
    var text = emoji + ' ' + title + (detail ? '\n' + detail : '') + '\n' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    var body = JSON.stringify({ msg_type: 'text', content: { text: text } });

    var req = https.request(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { console.log('[HealthAPI Webhook]', res.statusCode, d.slice(0, 60)); });
    });
    req.on('error', function(e) { console.error('[HealthAPI Webhook] Error:', e.message); });
    req.setTimeout(5000, function() { req.destroy(); });
    req.write(body);
    req.end();
  } catch(e) { console.error('[HealthAPI Webhook]', e.message); }
}

// Push alert (also notifies Feishu for critical/error/warning)
function pushAlert(dir, level, title, detail) {
  var alert = { level: level, title: title, detail: detail || '', timestamp: Date.now() };
  _alertsCache.push(alert);
  if (_alertsCache.length > 200) _alertsCache = _alertsCache.slice(-100);
  saveAlerts(dir);
  if (level === 'critical' || level === 'error' || level === 'warning') {
    notifyFeishu(level, title, detail);
  }
}

module.exports = function mount(opts) {
  /*
   * opts = {
   *   dataDir: '/opt/blueprint-editor/server-data',
   *   getWorkers: function() { return { ... }; },  // returns worker heartbeat map
   *   dashboardPath: '/opt/blueprint-editor/dashboard.html'
   * }
   */
  var dataDir = opts.dataDir;
  var getWorkers = opts.getWorkers || function() { return {}; };
  var dashboardPath = opts.dashboardPath;

  loadCache(dataDir);

  // Returns route handlers keyed by name
  var handlers = {};

  handlers.getHealth = function(req, res, sendJSON) {
    var probes = {
      'blueprint-api': 'ok',
      'frontend': 'ok',
      'luna-build': 'unknown',
      'gemini': 'unknown',
      'worker': 'unknown'
    };

    // Worker probe
    try {
      var wData = getWorkers();
      var wKeys = Object.keys(wData);
      var online = wKeys.filter(function(k) {
        var lastSeen = wData[k].lastSeen || wData[k].timestamp || 0;
        return Date.now() - lastSeen < 120000;
      });
      probes.worker = online.length > 0 ? 'ok' : (wKeys.length > 0 ? 'warn' : 'down');
    } catch(e) { probes.worker = 'unknown'; }

    sendJSON(res, {
      status: 'ok',
      probes: probes,
      timestamp: Date.now(),
      alerts: _alertsCache.length,
      errors: _errorsCache.length
    });
  };

  handlers.getAlerts = function(req, res, sendJSON) {
    sendJSON(res, _alertsCache.slice(-50));
  };

  handlers.postAlert = function(req, res, sendJSON, body) {
    var data = typeof body === 'string' ? JSON.parse(body) : body;
    pushAlert(dataDir, data.level || 'info', data.title || 'Alert', data.detail || '');
    sendJSON(res, { ok: true });
  };

  handlers.getErrors = function(req, res, sendJSON) {
    sendJSON(res, _errorsCache.slice(-50));
  };

  handlers.postError = function(req, res, sendJSON, body) {
    var data = typeof body === 'string' ? JSON.parse(body) : body;
    data.timestamp = Date.now();
    _errorsCache.push(data);
    if (_errorsCache.length > 200) _errorsCache = _errorsCache.slice(-100);
    saveErrors(dataDir);
    sendJSON(res, { ok: true });
  };

  handlers.getDashboard = function(req, res) {
    try {
      var html = fs.readFileSync(dashboardPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(404);
      res.end('Dashboard not found');
    }
  };

  // Expose pushAlert for server.cjs to use
  handlers.pushAlert = function(level, title, detail) {
    pushAlert(dataDir, level, title, detail);
  };

  handlers.notifyFeishu = notifyFeishu;

  return handlers;
};
