#!/usr/bin/env node
/**
 * Promote patch-run outcomes into feedback drafts.
 *
 * This closes the loop between execution and governance:
 * - successful outcomes become stability/coverage signals
 * - needs-patch outcomes become escalation signals
 * - skipped/manual-guarded outcomes become approval queue signals
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var archive = require('./archive-patch-run.cjs');

var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var OUT_ROOT = path.join(LEARNING_ROOT, 'drafts', 'patch-feedback');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function sha(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function summarize(entries) {
  var families = {};
  entries.forEach(function(item) {
    var key = item.family || 'unknown';
    if (!families[key]) {
      families[key] = {
        family: key,
        totalRuns: 0,
        latestResult: null,
        latestAt: null,
        latestEntry: null,
        resultCounts: {},
      };
    }
    var row = families[key];
    row.totalRuns++;
    var result = item.result || 'unknown';
    row.resultCounts[result] = (row.resultCounts[result] || 0) + 1;
    if (!row.latestAt || (item.executedAt && item.executedAt > row.latestAt)) {
      row.latestAt = item.executedAt || null;
      row.latestResult = result;
      row.latestEntry = item;
    }
  });
  return Object.keys(families).map(function(key) { return families[key]; });
}

function classifyFeedback(summary) {
  var latest = summary.latestResult || 'unknown';
  if (latest === 'patched-and-verified' || latest === 'verified-covered') {
    return {
      kind: 'coverage-signal',
      queue: 'stability',
      priority: 'P2',
      recommendation: 'Keep watching this family; current code path appears covered.',
    };
  }
  if (latest === 'needs-patch' || latest === 'patch-applied-needs-review' || latest === 'verification-missing') {
    return {
      kind: 'escalation-signal',
      queue: 'escalation',
      priority: 'P0',
      recommendation: 'Escalate this family back into governance priority because execution still needs code changes.',
    };
  }
  if (latest === 'skipped') {
    return {
      kind: 'approval-signal',
      queue: 'approval',
      priority: 'P1',
      recommendation: 'Manual-guarded family is blocked on approval before mutation.',
    };
  }
  return {
    kind: 'triage-signal',
    queue: 'triage',
    priority: 'P1',
    recommendation: 'Inspect this family manually; execution outcome was not recognized.',
  };
}

function promotePatchFeedbackDrafts() {
  var entries = archive.readPatchRunIndex(200) || [];
  ensureDir(OUT_ROOT);
  var manifest = [];

  summarize(entries).forEach(function(item) {
    var feedback = classifyFeedback(item);
    var draft = {
      id: 'draft-patch-feedback-' + sha(item.family),
      sourceType: 'patch-feedback',
      status: 'candidate',
      title: 'Patch feedback: ' + item.family,
      family: item.family,
      priority: feedback.priority,
      kind: feedback.kind,
      queue: feedback.queue,
      recommendation: feedback.recommendation,
      latestResult: item.latestResult,
      latestAt: item.latestAt,
      totalRuns: item.totalRuns,
      resultCounts: item.resultCounts,
      linkedPatchRun: item.latestEntry ? item.latestEntry.runId : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    var file = path.join(OUT_ROOT, draft.id + '.json');
    writeJson(file, draft);
    manifest.push({
      id: draft.id,
      family: draft.family,
      priority: draft.priority,
      queue: draft.queue,
      latestResult: draft.latestResult,
      file: path.relative(LEARNING_ROOT, file)
    });
  });

  writeJson(path.join(OUT_ROOT, 'index.json'), {
    updatedAt: new Date().toISOString(),
    count: manifest.length,
    items: manifest
  });

  console.log(JSON.stringify({
    promotedAt: new Date().toISOString(),
    targetRepo: LEARNING_ROOT,
    count: manifest.length
  }, null, 2));
}

if (require.main === module) promotePatchFeedbackDrafts();

module.exports = {
  promotePatchFeedbackDrafts: promotePatchFeedbackDrafts
};
