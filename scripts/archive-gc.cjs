#!/usr/bin/env node
/**
 * Archive GC — enforce TTL on server-data/task-logs/ + auto-fix archives.
 *
 * What gets cleaned:
 *   server-data/task-logs/<taskId>/        → entire dir deleted if all files older than TTL
 *   server-data/task-logs/auto-fix/*.json  → deleted if mtime older than TTL
 *   server-data/task-logs/auto-fix/*.prompt.txt → deleted with parent attempt
 *   server-data/model-fatal-index.jsonl.bak.* → rotated backups older than TTL
 *   server-data/metrics/pipeline-metrics.jsonl.bak.* → same
 *
 * Defaults: 30-day TTL, dry-run by default. Use --purge to actually delete.
 *
 * Usage:
 *   node scripts/archive-gc.cjs              # dry-run, 30d
 *   node scripts/archive-gc.cjs --purge      # delete
 *   node scripts/archive-gc.cjs --days=60 --purge
 *   node scripts/archive-gc.cjs --purge --verbose
 *
 * Safe to run as cron. Never touches files younger than TTL.
 */

var fs = require('fs');
var path = require('path');

var argv = process.argv.slice(2);
var dryRun = argv.indexOf('--purge') === -1;
var verbose = argv.indexOf('--verbose') !== -1 || argv.indexOf('-v') !== -1;
var daysArg = argv.find(function(a) { return a.indexOf('--days=') === 0; });
var TTL_DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;
if (!TTL_DAYS || TTL_DAYS < 1) {
  console.error('invalid --days value');
  process.exit(2);
}
var TTL_MS = TTL_DAYS * 86400 * 1000;
var CUTOFF = Date.now() - TTL_MS;

var REPO_ROOT = path.join(__dirname, '..');
var TASK_LOGS_DIR = path.join(REPO_ROOT, 'server-data', 'task-logs');
var AUTO_FIX_DIR = path.join(TASK_LOGS_DIR, 'auto-fix');
var SERVER_DATA = path.join(REPO_ROOT, 'server-data');
var METRICS_DIR = path.join(SERVER_DATA, 'metrics');

var stats = {
  taskDirsScanned: 0,
  taskDirsRemoved: 0,
  taskFilesRemoved: 0,
  autoFixFilesRemoved: 0,
  rotatedBackupsRemoved: 0,
  bytesFreed: 0,
  errors: [],
};

function log() {
  if (!verbose) return;
  console.log.apply(console, arguments);
}

function safeStat(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

function safeRmFile(p) {
  try {
    var st = fs.statSync(p);
    if (!dryRun) fs.unlinkSync(p);
    stats.bytesFreed += st.size || 0;
    return true;
  } catch (e) { stats.errors.push(p + ': ' + e.message); return false; }
}

function safeRmDir(p) {
  try {
    if (!dryRun) {
      if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true });
      else fs.rmdirSync(p, { recursive: true });
    }
    return true;
  } catch (e) { stats.errors.push(p + ': ' + e.message); return false; }
}

// ── task-logs/<taskId>/ per-task archives ──
function scanTaskLogs() {
  if (!fs.existsSync(TASK_LOGS_DIR)) return;
  var entries = fs.readdirSync(TASK_LOGS_DIR);
  entries.forEach(function(name) {
    if (name === 'auto-fix') return; // handled separately
    var dir = path.join(TASK_LOGS_DIR, name);
    var st = safeStat(dir);
    if (!st || !st.isDirectory()) return;
    stats.taskDirsScanned++;

    var files;
    try { files = fs.readdirSync(dir); } catch (e) { return; }
    // Consider a task stale when its newest file is older than cutoff.
    var newestMtime = 0;
    files.forEach(function(f) {
      var fst = safeStat(path.join(dir, f));
      if (fst && fst.mtimeMs > newestMtime) newestMtime = fst.mtimeMs;
    });
    if (newestMtime === 0 || newestMtime >= CUTOFF) return;

    log('[task-log] stale', name, 'newestAge=' + Math.round((Date.now() - newestMtime) / 86400000) + 'd');
    // Sum bytes before deletion
    var totalBytes = 0;
    files.forEach(function(f) {
      var fst = safeStat(path.join(dir, f));
      if (fst) totalBytes += fst.size;
    });
    if (safeRmDir(dir)) {
      stats.taskDirsRemoved++;
      stats.taskFilesRemoved += files.length;
      stats.bytesFreed += totalBytes;
    }
  });
}

// ── auto-fix per-attempt archives ──
function scanAutoFix() {
  if (!fs.existsSync(AUTO_FIX_DIR)) return;
  fs.readdirSync(AUTO_FIX_DIR).forEach(function(f) {
    if (f === '_index.jsonl') return; // keep the index
    if (f.indexOf('.bak.') !== -1) return; // rotated indexes handled below
    var full = path.join(AUTO_FIX_DIR, f);
    var st = safeStat(full);
    if (!st || !st.isFile()) return;
    if (st.mtimeMs >= CUTOFF) return;
    log('[auto-fix] stale', f, 'age=' + Math.round((Date.now() - st.mtimeMs) / 86400000) + 'd');
    if (safeRmFile(full)) stats.autoFixFilesRemoved++;
  });
}

// ── rotated *.bak.YYYYMMDD backups ──
function scanRotatedBackups() {
  var candidates = [];
  [SERVER_DATA, METRICS_DIR, AUTO_FIX_DIR, TASK_LOGS_DIR].forEach(function(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function(f) {
      if (f.indexOf('.bak.') !== -1) candidates.push(path.join(dir, f));
    });
  });
  candidates.forEach(function(p) {
    var st = safeStat(p);
    if (!st || !st.isFile()) return;
    if (st.mtimeMs >= CUTOFF) return;
    log('[rotated] stale', path.relative(REPO_ROOT, p));
    if (safeRmFile(p)) stats.rotatedBackupsRemoved++;
  });
}

function humanBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}

console.log('[archive-gc] mode=' + (dryRun ? 'DRY-RUN' : 'PURGE') + ' ttl=' + TTL_DAYS + 'd cutoff=' + new Date(CUTOFF).toISOString());
scanTaskLogs();
scanAutoFix();
scanRotatedBackups();

console.log('');
console.log('[archive-gc] summary:');
console.log('  task dirs scanned: ' + stats.taskDirsScanned);
console.log('  task dirs removed: ' + stats.taskDirsRemoved + ' (files=' + stats.taskFilesRemoved + ')');
console.log('  auto-fix files removed: ' + stats.autoFixFilesRemoved);
console.log('  rotated backups removed: ' + stats.rotatedBackupsRemoved);
console.log('  bytes freed: ' + humanBytes(stats.bytesFreed));
if (stats.errors.length) {
  console.log('  errors: ' + stats.errors.length);
  stats.errors.slice(0, 10).forEach(function(e) { console.log('    - ' + e); });
}
if (dryRun) console.log('(dry-run — pass --purge to actually delete)');

process.exit(stats.errors.length ? 1 : 0);
