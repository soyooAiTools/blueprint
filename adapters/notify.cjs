/**
 * notify.cjs — Blueprint 全链路错误通知模块
 * 独立文件，server.cjs 只需 require('./notify.cjs')
 * 2026-04-17: Feishu webhook/App API removed — only file storage retained
 */

const fs = require('fs');
const path = require('path');

// === Config ===
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
  // Dedup logging
  const dedupStage = record.stage ? ':' + record.stage : '';
  const key = `alert:${level}:${title}${dedupStage}`;
  if (shouldSend(key)) {
    console.log(`[notify] ${level === 'critical' ? '🔴' : '🟡'} ${title}${record.stage ? ' @' + record.stage : ''}: ${(detail || '').substring(0, 100)}`);
  }
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
  appendRecord(ERRORS_FILE, record);
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
