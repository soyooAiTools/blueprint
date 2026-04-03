/**
 * HTTP middleware: sendJSON, readBody, serveStatic, CORS
 * Extracted from server.cjs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../lib/config.cjs');
const notify = require('../adapters/notify.cjs');

// ============ JSON Response ============

function sendJSON(res, data, status) {
  status = status || 200;
  if (status >= 500) {
    try { notify.alert('critical', 'API ' + status, JSON.stringify(data).substring(0, 200)); } catch(e) {}
  }
  var body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ============ Body Parsing ============

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// ============ Static File Serving ============

var _gzipCache = {};

function serveStatic(res, filePath, req) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  var stat = fs.statSync(filePath);
  var ext = path.extname(filePath).toLowerCase();
  var mime = config.MIME[ext] || 'application/octet-stream';
  var content = fs.readFileSync(filePath);
  var cacheControl = ext === '.html'
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable';
  var headers = {
    'Content-Type': mime,
    'Cache-Control': cacheControl,
  };
  if (filePath.endsWith('.wasm')) {
    headers['Content-Type'] = 'application/wasm';
  }
  var COMPRESSIBLE = { '.html': 1, '.js': 1, '.css': 1, '.json': 1, '.svg': 1, '.xml': 1, '.wasm': 1 };
  var acceptEncoding = (req && req.headers && req.headers['accept-encoding']) || '';
  if (COMPRESSIBLE[ext] && content.length > 10240 && acceptEncoding.includes('gzip')) {
    var mtime = stat.mtimeMs;
    var cached = _gzipCache[filePath];
    var compressed;
    if (cached && cached.mtime === mtime) {
      compressed = cached.data;
    } else {
      compressed = zlib.gzipSync(content);
      _gzipCache[filePath] = { mtime: mtime, data: compressed };
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = compressed.length;
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(compressed);
  } else {
    headers['Content-Length'] = content.length;
    res.writeHead(200, headers);
    res.end(content);
  }
  return true;
}

// ============ CORS ============

function handleCORS(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// ============ Error Handler ============

function errorHandler(res, error, context) {
  console.error('[' + (context || 'server') + '] Error:', error.message || error);
  if (!res.headersSent) {
    sendJSON(res, { error: (error.message || 'Internal server error') }, 500);
  }
}

module.exports = {
  sendJSON: sendJSON,
  readBody: readBody,
  readRawBody: readRawBody,
  serveStatic: serveStatic,
  handleCORS: handleCORS,
  errorHandler: errorHandler,
};
