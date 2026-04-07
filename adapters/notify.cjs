/**
 * notify.cjs — Blueprint 全链路错误通知模块
 * 独立文件，server.cjs 只需 require('./notify.cjs')
 * 飞书 webhook 硬编码，不依赖 .env
 */

const fs = require('fs');
const path = require('path');
const http = require('https');

// === Config ===
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || '';
const DATA_DIR = path.join(__dirname, 'server-data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const ERRORS_FILE = path.join(DATA_DIR, 'errors.json');
const MAX_RECORDS = 500;
const DEDUP_MS = 5 * 60 * 1000; // 5 minutes

// === Feishu App API (triggers OpenClaw agent for auto-repair) ===
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const MONITOR_CHAT_ID = 'oc_2b4f89c248d0b046feba747fd42acf95';
let _appToken = null;
let _appTokenExpires = 0;

async function getAppToken() {
  if (_appToken && Date.now() < _appTokenExpires - 60000) return _appToken;
  try {
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
    });
    const data = await resp.json();
    if (data.code === 0 && data.tenant_access_token) {
      _appToken = data.tenant_access_token;
      _appTokenExpires = Date.now() + (data.expire || 7200) * 1000;
      return _appToken;
    }
    console.error('[notify] App token error:', data.code, data.msg);
    return null;
  } catch(e) {
    console.error('[notify] App token fetch failed:', e.message);
    return null;
  }
}

async function sendAppApiMessage(chatId, text) {
  const token = await getAppToken();
  if (!token) return false;
  try {
    const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text })
      })
    });
    const data = await resp.json();
    if (data.code === 0) {
      console.log('[notify] App API message sent to', chatId);
      return true;
    }
    console.error('[notify] App API send failed:', data.code, data.msg);
    return false;
  } catch(e) {
    console.error('[notify] App API error:', e.message);
    return false;
  }
}

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
 * @param {object} [extra] — optional structured context { stage, classification, taskId }
 */
function alert(level, title, detail, extra) {
  const record = {
    level,
    title,
    detail,
    timestamp: new Date().toISOString(),
    stage: (extra && extra.stage) || null,
    classification: (extra && extra.classification) || null,
    taskId: (extra && extra.taskId) || null,
  };
  // Always store
  appendRecord(ALERTS_FILE, record);
  // Dedup before sending to Feishu — include stage for finer-grained dedup
  const dedupStage = record.stage ? ':' + record.stage : '';
  const key = `alert:${level}:${title}${dedupStage}`;
  if (shouldSend(key)) {
    const stageTag = record.stage ? ` [${record.stage}]` : '';
    const classTag = record.classification ? ` (${record.classification})` : '';
    sendFeishu(level, title + stageTag + classTag, detail || '');
  }
  console.log(`[notify] ${level === 'critical' ? '🔴' : '🟡'} ${title}${record.stage ? ' @' + record.stage : ''}: ${(detail || '').substring(0, 100)}`);
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
