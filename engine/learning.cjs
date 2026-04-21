/**
 * Autonomous Learning Module
 *
 * Closes the last gap in Blueprint's self-improving pipeline by tracking three
 * data sources:
 *
 *   1. pending-fixes.json   — escalations where auto-fix (L4–L7) gave up:
 *                             recipe exhausted (>= MAX applies), recipe reverted
 *                             as regression, or top-N failure fingerprints with
 *                             no recipe match / generation failure.
 *
 *   2. pending-rules.json   — candidate static-check rules mined from Codex
 *                             reviewer warnings in pipeline.jsonl. High-frequency
 *                             warning phrases become rule proposals.
 *
 *   3. recipe-stats.json    — aggregate recipe success / revert counts so
 *                             dashboard can flag drifting recipes and so the
 *                             architecture-escalation path has data to score.
 *
 * All scans are pure side-effect functions — idempotent, cron-safe. Writes are
 * atomic (write-then-rename).
 *
 * Entry points (also wired into api/dashboard.cjs watchdog Phase 8):
 *   - scanPendingFixes()   every watchdog cycle (cheap, ~10ms)
 *   - computeRecipeStats() every watchdog cycle (cheap)
 *   - scanPendingRules()   every 6h (expensive, globs all pipeline.jsonl)
 *   - getLearningSummary() — read accessor for /api/learning
 *
 * 2026-04-21 — initial implementation per user request for fully autonomous
 * learning after P0/P1 batch fixes landed.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var REPO_ROOT = path.join(__dirname, '..');
var DATA_DIR = path.join(REPO_ROOT, 'server-data');
var PENDING_FIXES = path.join(DATA_DIR, 'pending-fixes.json');
var PENDING_RULES = path.join(DATA_DIR, 'pending-rules.json');
var RECIPE_STATS = path.join(DATA_DIR, 'recipe-stats.json');
var STATE_FILE = path.join(DATA_DIR, 'auto-fix-state.json');
var RECIPES_FILE = path.join(REPO_ROOT, 'worker', 'fix-recipes.json');
var TASK_LOGS = path.join(DATA_DIR, 'task-logs');
var RULES_SCAN_STATE = path.join(DATA_DIR, 'rules-scan-state.json');

var RULES_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
var MIN_WARNING_CLUSTER = 3; // warning phrase must appear >= 3x to become candidate
var MAX_PENDING_ITEMS = 50;

function log(msg) { console.log('[learning] ' + msg); }

function safeRead(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch(e) { return fallback; }
}

function atomicWrite(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch(e) { log('write failed ' + file + ': ' + e.message); }
}

function fpHash(s) { return crypto.createHash('md5').update(String(s || '')).digest('hex').slice(0, 10); }

// ── pending-fixes scan ───────────────────────────────────────────────────

function scanPendingFixes(topFailReasons) {
  var state = safeRead(STATE_FILE, { cooldowns: {}, history: [], invalidRecipes: {} });
  var items = [];
  var seen = {};

  // Source 1: recipes that auto-fix gave up on (manual-only cooldown)
  Object.keys(state.cooldowns || {}).forEach(function(fp) {
    var cd = state.cooldowns[fp];
    if (!cd || (cd.status !== 'manual-only' && cd.status !== 'reverted')) return;
    var key = fp.slice(0, 120);
    if (seen[key]) return;
    seen[key] = true;
    items.push({
      id: 'pf-' + fpHash(fp),
      fingerprint: key,
      reason: cd.status === 'reverted' ? 'regression-reverted' : 'recipe-exhausted',
      cooldownAt: cd.at ? new Date(cd.at).toISOString() : null,
      priority: 'p0',
      suggestedAction: cd.status === 'reverted'
        ? 'The auto-generated recipe made things worse — design a new fix or widen static-check.'
        : 'Recipe applied 3+ times without resolving. Architectural change likely needed.',
    });
  });

  // Source 2: invalid recipes (explicit regression list)
  Object.keys(state.invalidRecipes || {}).forEach(function(recipeId) {
    var inv = state.invalidRecipes[recipeId];
    var key = 'recipe:' + recipeId;
    if (seen[key]) return;
    seen[key] = true;
    items.push({
      id: 'pf-' + fpHash(key),
      fingerprint: (inv.fingerprint || '').slice(0, 120),
      recipeId: recipeId,
      reason: 'regression-reverted',
      cooldownAt: inv.at || null,
      priority: 'p0',
      suggestedAction: 'Recipe caused regression. Revert confirmed=' + (inv.reverted ? 'yes' : 'no') + '. Redesign.',
    });
  });

  // Source 3: top failure fingerprints not matched by any recipe
  var recipes = safeRead(RECIPES_FILE, []);
  (topFailReasons || []).forEach(function(fp) {
    var fingerprint = fp.fingerprint || fp.reason || '';
    if (!fingerprint) return;
    var matched = false;
    for (var i = 0; i < recipes.length; i++) {
      try {
        if (new RegExp(recipes[i].fingerprintPattern, 'i').test(fingerprint)) { matched = true; break; }
      } catch(e) {}
    }
    if (matched) return;
    var key = fingerprint.slice(0, 120);
    if (seen[key]) return;
    seen[key] = true;
    items.push({
      id: 'pf-' + fpHash(fingerprint),
      fingerprint: key,
      reason: 'no-recipe-match',
      hitCount: fp.retries || fp.hitCount || 0,
      uniqueTasks: fp.uniqueTasks || 0,
      firstSeen: fp.firstSeen || null,
      lastSeen: fp.lastSeen || null,
      sampleError: (fp.sampleReason || '').slice(0, 300),
      failedAtStage: fp.failedAtStage || null,
      priority: (fp.uniqueTasks || 0) >= 3 ? 'p0' : (fp.retries || 0) >= 5 ? 'p1' : 'p2',
      suggestedAction: 'Failure fingerprint seen >=3 times but no recipe matches. Let L5 auto-generate recipe, or hand-design a static-check rule.',
    });
  });

  // Sort by priority then hitCount, trim
  var priOrder = { p0: 0, p1: 1, p2: 2 };
  items.sort(function(a, b) {
    var pa = priOrder[a.priority] || 3;
    var pb = priOrder[b.priority] || 3;
    if (pa !== pb) return pa - pb;
    return (b.hitCount || 0) - (a.hitCount || 0);
  });
  if (items.length > MAX_PENDING_ITEMS) items = items.slice(0, MAX_PENDING_ITEMS);

  var out = { updatedAt: new Date().toISOString(), count: items.length, items: items };
  atomicWrite(PENDING_FIXES, out);
  return out;
}

// ── recipe-stats aggregation ──────────────────────────────────────────────

function computeRecipeStats() {
  var state = safeRead(STATE_FILE, { cooldowns: {}, history: [], invalidRecipes: {} });
  var recipes = safeRead(RECIPES_FILE, []);
  var byId = {};

  recipes.forEach(function(r) {
    byId[r.id] = {
      id: r.id,
      description: r.description || '',
      risk: r.risk || 'unknown',
      autoApply: r.autoApply !== false,
      applied: 0,
      reverted: 0,
      firstApplied: null,
      lastApplied: null,
      manualOnly: false,
    };
  });

  (state.history || []).forEach(function(h) {
    var rec = byId[h.recipe];
    if (!rec) return;
    rec.applied++;
    if (!rec.firstApplied || h.at < rec.firstApplied) rec.firstApplied = h.at;
    if (!rec.lastApplied || h.at > rec.lastApplied) rec.lastApplied = h.at;
  });

  Object.keys(state.invalidRecipes || {}).forEach(function(rid) {
    if (byId[rid]) { byId[rid].reverted++; byId[rid].manualOnly = true; }
  });

  Object.keys(state.cooldowns || {}).forEach(function(fp) {
    var cd = state.cooldowns[fp];
    if (cd && cd.status === 'manual-only') {
      // cd doesn't directly store recipeId; skip — manual-only is per-fingerprint
    }
  });

  var list = Object.keys(byId).map(function(k) {
    var r = byId[k];
    var total = r.applied + r.reverted;
    r.failureRate = total > 0 ? Math.round(r.reverted / total * 100) + '%' : '0%';
    r.successRate = total > 0 ? Math.round(r.applied / total * 100) + '%' : 'n/a';
    r.escalate = r.applied >= 3 && r.reverted / Math.max(1, total) > 0.5;
    return r;
  });

  list.sort(function(a, b) { return (b.applied + b.reverted) - (a.applied + a.reverted); });

  var out = { updatedAt: new Date().toISOString(), count: list.length, recipes: list };
  atomicWrite(RECIPE_STATS, out);
  return out;
}

// ── pending-rules scan (codex reviewer warnings → rule candidates) ───────

var WARNING_RE = /\[codex-reviewer\][^\n]*\[warning\][^\n]*/g;
var WARN_INLINE = /\[warning\]\s*([^\n]+?)(?:\s*$|\n)/;

function normalizeWarning(text) {
  return String(text || '')
    .replace(/['"`]/g, '')
    .replace(/\bproj_\d+_\w+/g, 'PROJ')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function scanPendingRules(opts) {
  opts = opts || {};
  var scanState = safeRead(RULES_SCAN_STATE, { lastRunAt: 0 });
  if (!opts.force && (Date.now() - (scanState.lastRunAt || 0)) < RULES_SCAN_INTERVAL_MS) {
    return { skipped: true, nextRunInMs: RULES_SCAN_INTERVAL_MS - (Date.now() - (scanState.lastRunAt || 0)) };
  }

  var dirs = [];
  try { dirs = fs.readdirSync(TASK_LOGS); } catch(e) {}
  var clusters = {};
  var ageCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  dirs.forEach(function(taskId) {
    var jl = path.join(TASK_LOGS, taskId, 'pipeline.jsonl');
    var st;
    try { st = fs.statSync(jl); } catch(e) { return; }
    if (st.mtimeMs < ageCutoff) return;
    var data;
    try { data = fs.readFileSync(jl, 'utf-8'); } catch(e) { return; }
    // Sample: grab warning lines, not full parse — jsonl may be huge
    var matches = data.match(WARNING_RE) || [];
    matches.forEach(function(line) {
      var m = WARN_INLINE.exec(line);
      if (!m) return;
      var norm = normalizeWarning(m[1]);
      if (!norm || norm.length < 12) return;
      if (!clusters[norm]) {
        clusters[norm] = { phrase: norm, count: 0, firstSeen: st.mtime.toISOString(), lastSeen: st.mtime.toISOString(), sampleTasks: [], sampleSnippets: [] };
      }
      clusters[norm].count++;
      if (clusters[norm].sampleTasks.indexOf(taskId) < 0 && clusters[norm].sampleTasks.length < 3) {
        clusters[norm].sampleTasks.push(taskId);
      }
      if (clusters[norm].sampleSnippets.length < 2) {
        clusters[norm].sampleSnippets.push(m[1].slice(0, 200));
      }
    });
  });

  var items = Object.keys(clusters)
    .map(function(k) { return clusters[k]; })
    .filter(function(c) { return c.count >= MIN_WARNING_CLUSTER; })
    .map(function(c) {
      return {
        id: 'pr-' + fpHash(c.phrase),
        phrase: c.phrase,
        hitCount: c.count,
        uniqueTasks: c.sampleTasks.length,
        sampleTaskIds: c.sampleTasks,
        sampleSnippets: c.sampleSnippets,
        suggestedRule: {
          slug: 'codex-warning-' + fpHash(c.phrase),
          severity: 'warn',
          description: 'Auto-mined from ' + c.count + ' Codex reviewer warnings: ' + c.phrase.slice(0, 80),
          regexHint: c.phrase.replace(/\s+/g, '\\s+').slice(0, 120),
        },
        status: 'candidate',
      };
    })
    .sort(function(a, b) { return b.hitCount - a.hitCount; });

  if (items.length > MAX_PENDING_ITEMS) items = items.slice(0, MAX_PENDING_ITEMS);

  var out = { updatedAt: new Date().toISOString(), count: items.length, items: items };
  atomicWrite(PENDING_RULES, out);
  atomicWrite(RULES_SCAN_STATE, { lastRunAt: Date.now(), clusterCount: items.length });
  log('scanPendingRules: ' + items.length + ' candidate rules (from ' + dirs.length + ' tasks)');
  return out;
}

// ── Read accessor ────────────────────────────────────────────────────────

function getLearningSummary() {
  return {
    pendingFixes: safeRead(PENDING_FIXES, { count: 0, items: [] }),
    pendingRules: safeRead(PENDING_RULES, { count: 0, items: [] }),
    recipeStats: safeRead(RECIPE_STATS, { count: 0, recipes: [] }),
    scanState: safeRead(RULES_SCAN_STATE, { lastRunAt: 0 }),
  };
}

module.exports = {
  scanPendingFixes: scanPendingFixes,
  scanPendingRules: scanPendingRules,
  computeRecipeStats: computeRecipeStats,
  getLearningSummary: getLearningSummary,
};
