/**
 * health-standalone.cjs — 独立健康监控进程
 * PM2: health-api, 端口 3902
 * 路由: /api/health, /api/alerts, /api/errors, /dashboard
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const notify = require('./notify.cjs');

const PORT = 3902;
const BLUEPRINT_PORT = 3901;

function sendJSON(res, data, status) {
  if (res.headersSent) return; // Fix ERR_HTTP_HEADERS_SENT
  status = status || 200;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendHTML(res, html) {
  if (res.headersSent) return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(html);
}

// Health probes
function probeBlueprint() {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => { if (!resolved) { resolved = true; resolve(result); } };
    const req = http.request({ hostname: '127.0.0.1', port: BLUEPRINT_PORT, path: '/api/projects', method: 'GET', timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => done({ status: res.statusCode === 200 ? 'ok' : 'error', code: res.statusCode }));
    });
    req.on('error', (e) => done({ status: 'down', error: e.message }));
    req.on('timeout', () => { req.destroy(); done({ status: 'timeout' }); });
    req.end();
  });
}

function probeGemini() {
  return new Promise((resolve) => {
    const apiKey = process.env.GEMINI_API_KEY || '';
    if (!apiKey) return resolve({ status: 'no_key' });
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const mod = require('https');
    let resolved = false;
    const done = (result) => { if (!resolved) { resolved = true; resolve(result); } };
    const req = mod.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'GET', timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => done({ status: res.statusCode === 200 ? 'ok' : 'error', code: res.statusCode }));
    });
    req.on('error', (e) => done({ status: 'down', error: e.message }));
    req.on('timeout', () => { req.destroy(); done({ status: 'timeout' }); });
    req.end();
  });
}

// Parse body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch(e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// Proxy to blueprint
function proxyTo(req, res, targetPath) {
  const proxy = http.request({ hostname: '127.0.0.1', port: BLUEPRINT_PORT, path: targetPath, method: req.method, headers: req.headers, timeout: 10000 }, (proxyRes) => {
    if (res.headersSent) return;
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on('error', () => sendJSON(res, { error: 'blueprint unavailable' }, 502));
  proxy.on('timeout', () => { proxy.destroy(); sendJSON(res, { error: 'timeout' }, 504); });
  req.pipe(proxy);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  try {
    // Dashboard
    if (pathname === '/dashboard') {
      const dashPath = path.join(__dirname, 'dashboard.html');
      try {
        const html = fs.readFileSync(dashPath, 'utf8');
        return sendHTML(res, html);
      } catch(e) {
        return sendJSON(res, { error: 'dashboard.html not found' }, 404);
      }
    }

    // Health
    if (pathname === '/api/health' && req.method === 'GET') {
      const [bp, gm] = await Promise.all([probeBlueprint(), probeGemini()]);
      const overall = (bp.status === 'ok') ? 'ok' : 'degraded';
      if (bp.status !== 'ok') {
        notify.alert('critical', 'Blueprint API down', JSON.stringify(bp));
      }
      if (gm.status !== 'ok' && gm.status !== 'no_key') {
        notify.alert('critical', 'Gemini API down', JSON.stringify(gm));
      }
      return sendJSON(res, { status: overall, probes: { blueprint: bp, gemini: gm }, timestamp: new Date().toISOString() });
    }

    // Alerts
    if (pathname === '/api/alerts' && req.method === 'GET') {
      const limit = parseInt(parsed.searchParams.get('limit')) || 50;
      return sendJSON(res, notify.getAlerts(limit));
    }

    // Errors - GET
    if (pathname === '/api/errors' && req.method === 'GET') {
      const limit = parseInt(parsed.searchParams.get('limit')) || 50;
      return sendJSON(res, notify.getErrors(limit));
    }

    // Errors - POST (frontend reporter)
    if (pathname === '/api/errors' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body) notify.reportError(body);
      return sendJSON(res, { ok: true }, 201);
    }

    // Proxy workers/tasks to blueprint
    if (pathname === '/api/workers' || pathname === '/api/tasks') {
      return proxyTo(req, res, pathname + parsed.search);
    }

    sendJSON(res, { error: 'not found' }, 404);
  } catch(e) {
    console.error('[health-api] Unhandled:', e.message);
    sendJSON(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log('[HealthAPI] Standalone server on port ' + PORT);
});
