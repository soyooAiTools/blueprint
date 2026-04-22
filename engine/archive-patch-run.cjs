#!/usr/bin/env node
/**
 * Archive patch-run executions so the restricted executor has persistent
 * history across cycles and the dashboard can show what actually happened.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var config = require('../lib/config.cjs');

var ARCHIVE_ROOT = path.join(config.DATA_DIR, 'patch-run-archive');
var INDEX_FILE = path.join(ARCHIVE_ROOT, 'index.json');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function sha(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function archivePatchRun(runBody) {
  if (!runBody || !runBody.id || !runBody.lastExecution) return null;

  ensureDir(ARCHIVE_ROOT);
  var exec = runBody.lastExecution || {};
  var stamp = exec.executedAt || new Date().toISOString();
  var hash = sha(runBody.id + '|' + stamp + '|' + (exec.result || ''));
  var relFile = path.join('entries', runBody.id + '-' + hash + '.json');
  var absFile = path.join(ARCHIVE_ROOT, relFile);

  var record = {
    id: hash,
    runId: runBody.id,
    family: runBody.family || 'unknown',
    priority: runBody.priority || 'P1',
    status: runBody.status || null,
    executionMode: runBody.executionMode || null,
    executedAt: stamp,
    result: exec.result || null,
    passCount: exec.passCount != null ? exec.passCount : null,
    totalChecks: exec.totalChecks != null ? exec.totalChecks : null,
    patchedFiles: exec.patchedFiles || [],
    blockingReason: runBody.blockingReason || null,
    primaryTarget: runBody.primaryTarget || null,
    linkedPatchTask: runBody.linkedPatchTask || null,
    checks: exec.checks || []
  };

  writeJson(absFile, record);

  var index = readJson(INDEX_FILE, { updatedAt: null, items: [] });
  var exists = (index.items || []).some(function(item) { return item.id === hash; });
  if (!exists) {
    index.items = index.items || [];
    index.items.unshift({
      id: hash,
      runId: record.runId,
      family: record.family,
      result: record.result,
      executedAt: record.executedAt,
      file: relFile
    });
  }
  index.updatedAt = new Date().toISOString();
  index.items = (index.items || []).slice(0, 200);
  writeJson(INDEX_FILE, index);
  return record;
}

function readPatchRunIndex(limit) {
  var index = readJson(INDEX_FILE, { items: [] });
  return (index.items || []).slice(0, limit || 50);
}

module.exports = {
  archivePatchRun: archivePatchRun,
  readPatchRunIndex: readPatchRunIndex,
  getPatchRunSummary: function(limit) {
    var items = readPatchRunIndex(limit || 200);
    var byResult = {};
    var byFamily = {};
    var dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    var last24h = [];

    items.forEach(function(item) {
      var result = item.result || 'unknown';
      var family = item.family || 'unknown';
      byResult[result] = (byResult[result] || 0) + 1;
      byFamily[family] = (byFamily[family] || 0) + 1;
      if (item.executedAt && new Date(item.executedAt).getTime() >= dayAgo) {
        last24h.push(item);
      }
    });

    return {
      total: items.length,
      byResult: Object.keys(byResult).sort().map(function(key) {
        return { result: key, count: byResult[key] };
      }),
      byFamily: Object.keys(byFamily).sort(function(a, b) {
        return byFamily[b] - byFamily[a];
      }).slice(0, 8).map(function(key) {
        return { family: key, count: byFamily[key] };
      }),
      last24hCount: last24h.length,
      last24hByResult: (function() {
        var map = {};
        last24h.forEach(function(item) {
          var key = item.result || 'unknown';
          map[key] = (map[key] || 0) + 1;
        });
        return Object.keys(map).sort().map(function(key) {
          return { result: key, count: map[key] };
        });
      })()
    };
  }
};
