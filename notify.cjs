/**
 * notify.cjs — Blueprint 全链路错误通知模块
 * 独立文件，server.cjs 只需 require('./notify.cjs')
 * 飞书 webhook 硬编码，不依赖 .env
 */

const fs = require('fs');
const path = require('path');
const http = require('https');

// === Config ===
const FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/b9c59492-4949-4950-a34b-913bf1c7df08';
const DATA_DIR = path.join(__dirname, 'server-data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const ERRORS_FILE = path.join(DATA_DIR, 'errors.json');
const MAX_RECORDS = 500;
const DEDUP_MS = 5 * 60 * 1000; // 5 minutes

// === Dedup ===
const _lastSent = new Map();

function shouldSend(key) {
  const now = Date.now();
  const last = _lastSent.get(key);
  if (last && now - last < DEDUP_MS) return false;
  _lastSent.set(key, now);
  // Cleanup old entries
  if (_lastSent.size > 200) {
    for (const [k, v] of _lastSent) {
      if (now - v > DEDUP_MS) _lastSent.delete(k);
    }
  }
  return true;
}

// === File IO ===
function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
}

function readJSON(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch(e) {
    return [];
  }
}

function appendRecord(filepath, record) {
  ensureDir();
  const arr = readJSON(filepath);
  arr.push(record);
  // FIFO trim
  while (arr.length > MAX_RECORDS) arr.shift();
  try {
    fs.writeFileSync(filepath, JSON.stringify(arr, null, 2), 'utf8');
  } catch(e) {
    console.error('[notify] Write failed:', filepath, e.message);
  }
}

// === Feishu Webhook ===
function sendFeishu(level, title, detail) {
  const emoji = level === 'critical' ? '🔴' : '🟡';
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const body = JSON.stringify({
    msg_type: 'text',
    content: {
      text: `${emoji} [${level.toUpperCase()}] ${title}\n${detail}\n⏰ ${time}`
    }
  });

  const url = new URL(FEISHU_WEBHOOK);
  const req = http.request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        console.error('[notify] Feishu webhook failed:', res.statusCode, data);
      }
    });
  });
  req.on('error', (e) => {
    console.error('[notify] Feishu webhook error:', e.message);
  });
  req.write(body);
  req.end();
}

// === Public API ===

/**
 * Push an alert (backend error / business exception)
 * @param {'critical'|'warning'} level
 * @param {string} title
 * @param {string} detail
 */
function alert(level, title, detail) {
  const record = { level, title, detail, timestamp: new Date().toISOString() };
  // Always store
  appendRecord(ALERTS_FILE, record);
  // Dedup before sending to Feishu
  const key = `alert:${level}:${title}`;
  if (shouldSend(key)) {
    sendFeishu(level, title, detail || '');
  }
  console.log(`[notify] ${level === 'critical' ? '🔴' : '🟡'} ${title}: ${(detail || '').substring(0, 100)}`);
}

/**
 * Report a frontend error
 * @param {object} errorObj - { message, stack, url, userAgent, timestamp }
 */
function reportError(errorObj) {
  if (!errorObj || !errorObj.message) return;
  const record = {
    message: errorObj.message || '',
    stack: errorObj.stack || '',
    url: errorObj.url || '',
    userAgent: errorObj.userAgent || '',
    timestamp: errorObj.timestamp || new Date().toISOString()
  };
  // Always store
  appendRecord(ERRORS_FILE, record);
  // Dedup before sending to Feishu
  const key = `error:${record.message.substring(0, 80)}`;
  if (shouldSend(key)) {
    sendFeishu('warning', '前端错误', record.message + (record.url ? '\n📍 ' + record.url : ''));
  }
}

/**
 * Get recent alerts
 */
function getAlerts(limit) {
  limit = limit || 50;
  const arr = readJSON(ALERTS_FILE);
  return arr.slice(-limit);
}

/**
 * Get recent errors
 */
function getErrors(limit) {
  limit = limit || 50;
  const arr = readJSON(ERRORS_FILE);
  return arr.slice(-limit);
}

module.exports = { alert, reportError, getAlerts, getErrors };
