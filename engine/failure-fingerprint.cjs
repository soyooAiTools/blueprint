/**
 * Failure Fingerprint → Knowledge Binding (L2)
 *
 * For each normalized failure fingerprint, try to answer:
 *   1. Is there a memory entry describing this class of failure?       (memoryHits)
 *   2. Is there a git commit that claims to fix it?                    (commitHits)
 *   3. What is the most recent "fix" commit and when did it land?      (resolvedBy / resolvedAt)
 *   4. Does any auto-fix recipe match this fingerprint?                (autoFixRecipe)
 *
 * Used by:
 *   - api/dashboard.cjs getPipelineMetrics — decorates top fingerprints
 *   - engine/auto-fix.cjs — recipe lookup
 *   - watchdog L3 regression watcher — uses resolvedAt to detect regressions
 *
 * 2026-04-16 — introduced alongside metrics.cjs dedup.
 */

var fs = require('fs');
var path = require('path');
var { execSync } = require('child_process');

var MEMORY_DIR = '/root/.claude/projects/-root/memory';
var REPO_DIR = path.join(__dirname, '..');
var RECIPES_FILE = path.join(__dirname, '..', 'worker', 'fix-recipes.json');

// ─── Keyword extraction ───────────────────────────────────────────────

/**
 * Pull stable keywords from a fingerprint so grep hits "the essence" and not
 * stopwords. Prefer error-code-like tokens (ENOENT, ECONNRESET, FATAL,
 * PascalCase identifiers) over English words.
 */
function extractKeywords(fingerprint) {
  if (!fingerprint) return [];
  var kws = new Set();
  var s = String(fingerprint);

  // Error codes: all-caps tokens >= 4 chars (ENOENT, ECONNRESET, FATAL, CODE)
  var errCodes = s.match(/\b[A-Z]{4,}\b/g) || [];
  errCodes.forEach(function(c) { kws.add(c); });

  // CamelCase / PascalCase identifiers with >= 2 caps (MonoBehaviour, GameFlowManagerMain)
  var ids = s.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  ids.forEach(function(c) { kws.add(c); });

  // Quoted strings — often contain structural tokens like "data" or "split"
  var quoted = s.match(/"([a-zA-Z_][\w-]{2,})"/g) || [];
  quoted.forEach(function(c) { kws.add(c.replace(/"/g, '')); });

  // Known domain phrases — hand-picked for this project, cheap lookup
  var phrasesToCheck = [
    'skeleton', 'csCode', 'phaseId', 'canonical', 'GFM_Tools',
    'spec-validate', 'fix-loop', 'build-api', 'LINUX_BUILD_URL',
    'SetActive', 'Instantiate', 'MODEL_FATAL', 'black screen', '黑屏',
    'Visual freeze', 'CUA', 'silent-pass', 'silent-skip',
    'port-guard', 'reload', 'restart', 'truthy',
  ];
  phrasesToCheck.forEach(function(p) {
    if (s.toLowerCase().indexOf(p.toLowerCase()) >= 0) kws.add(p);
  });

  return Array.from(kws);
}

// ─── Memory scan ──────────────────────────────────────────────────────

/**
 * Grep ~/.claude/projects/-root/memory/*.md for any of the keywords.
 * Returns files that match >= 1 keyword, with a score (number of distinct
 * keywords matched) so the caller can sort by relevance.
 */
function grepMemoryForFingerprint(fingerprint) {
  var kws = extractKeywords(fingerprint);
  if (kws.length === 0) return [];
  var hits = [];
  var files;
  try { files = fs.readdirSync(MEMORY_DIR); }
  catch(e) { return []; }

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    var body;
    try { body = fs.readFileSync(path.join(MEMORY_DIR, f), 'utf-8'); }
    catch(e) { continue; }
    var matched = [];
    for (var k = 0; k < kws.length; k++) {
      // Case-insensitive simple includes — memory files are short, no need
      // for regex gymnastics
      if (body.toLowerCase().indexOf(kws[k].toLowerCase()) >= 0) {
        matched.push(kws[k]);
      }
    }
    if (matched.length > 0) {
      hits.push({ file: f, matchedKeywords: matched, score: matched.length });
    }
  }
  hits.sort(function(a, b) { return b.score - a.score; });
  return hits.slice(0, 5);
}

// ─── Git log scan ─────────────────────────────────────────────────────

var _gitLogCache = null;
var _gitLogCacheAt = 0;
var GIT_LOG_TTL_MS = 5 * 60 * 1000;

function loadGitLog() {
  if (_gitLogCache && Date.now() - _gitLogCacheAt < GIT_LOG_TTL_MS) {
    return _gitLogCache;
  }
  try {
    // Format: hash<TAB>isoDate<TAB>subject — stable, machine-parseable
    var raw = execSync(
      'git -C ' + REPO_DIR + ' log --all --pretty=format:"%H%x09%cI%x09%s" --since="60 days ago"',
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    _gitLogCache = raw.split('\n').filter(Boolean).map(function(line) {
      var parts = line.split('\t');
      return { hash: parts[0], date: parts[1], subject: parts[2] || '' };
    });
    _gitLogCacheAt = Date.now();
  } catch(e) {
    _gitLogCache = [];
    _gitLogCacheAt = Date.now();
  }
  return _gitLogCache;
}

/**
 * Find commits whose subject mentions any of the keywords AND looks like a
 * fix commit (fix:, 修复, patch, resolve, fixes, fixed).
 */
function grepGitLogForFingerprint(fingerprint) {
  var kws = extractKeywords(fingerprint);
  if (kws.length === 0) return [];
  var commits = loadGitLog();
  var fixPattern = /^(fix|修复|patch|resolve|fixed|fixes|hotfix|perf|refactor)\b|fix[: ]|修[复正]/i;
  var hits = [];
  commits.forEach(function(c) {
    if (!c.subject) return;
    var matched = [];
    for (var k = 0; k < kws.length; k++) {
      if (c.subject.toLowerCase().indexOf(kws[k].toLowerCase()) >= 0) {
        matched.push(kws[k]);
      }
    }
    if (matched.length === 0) return;
    // Prefer commits that look like fixes — keep others too but at lower score
    var isFix = fixPattern.test(c.subject);
    hits.push({
      hash: c.hash,
      date: c.date,
      subject: c.subject,
      matchedKeywords: matched,
      score: matched.length + (isFix ? 2 : 0),
      isFix: isFix,
    });
  });
  hits.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    // Same score → newer commit wins
    return (b.date || '').localeCompare(a.date || '');
  });
  return hits.slice(0, 5);
}

// ─── Recipe lookup ────────────────────────────────────────────────────

var _recipesCache = null;
var _recipesCacheAt = 0;

function loadRecipes() {
  if (_recipesCache && Date.now() - _recipesCacheAt < 30000) return _recipesCache;
  try {
    _recipesCache = JSON.parse(fs.readFileSync(RECIPES_FILE, 'utf-8'));
  } catch(e) {
    _recipesCache = [];
  }
  _recipesCacheAt = Date.now();
  return _recipesCache;
}

function findAutoFixRecipe(fingerprint) {
  var recipes = loadRecipes();
  for (var i = 0; i < recipes.length; i++) {
    var r = recipes[i];
    try {
      var re = new RegExp(r.fingerprintPattern, 'i');
      if (re.test(fingerprint)) return r;
    } catch(e) { continue; }
  }
  return null;
}

// ─── Main binding ─────────────────────────────────────────────────────

/**
 * Bind a fingerprint to all available knowledge sources.
 * Returns:
 *   {
 *     memoryHits: [{file, matchedKeywords, score}],
 *     commitHits: [{hash, date, subject, score, isFix}],
 *     resolvedBy: '<commit hash>' | null,
 *     resolvedAt: '<iso date>' | null,
 *     autoFixRecipe: { fingerprintPattern, recipeFile, description, risk } | null
 *   }
 */
// Look up a commit in the cached git log by partial hash (7+ chars)
function findCommitByHash(partial) {
  if (!partial || partial.length < 7) return null;
  var commits = loadGitLog();
  for (var i = 0; i < commits.length; i++) {
    if (commits[i].hash.indexOf(partial) === 0) return commits[i];
  }
  return null;
}

function bindKnowledge(fingerprint) {
  var memoryHits = grepMemoryForFingerprint(fingerprint);
  var commitHits = grepGitLogForFingerprint(fingerprint);
  var autoFixRecipe = findAutoFixRecipe(fingerprint);

  // resolvedBy precedence:
  //   1. If the matched recipe has relatedCommits, use the NEWEST of those
  //      (explicit, human-curated — beats fuzzy grep on weak keywords like "data")
  //   2. Otherwise, highest-scoring fix commit from git grep
  var resolvedCommit = null;
  if (autoFixRecipe && Array.isArray(autoFixRecipe.relatedCommits) && autoFixRecipe.relatedCommits.length) {
    var curated = autoFixRecipe.relatedCommits
      .map(findCommitByHash)
      .filter(Boolean)
      .sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
    if (curated.length > 0) resolvedCommit = curated[0];
  }
  if (!resolvedCommit) {
    for (var i = 0; i < commitHits.length; i++) {
      if (commitHits[i].isFix) { resolvedCommit = commitHits[i]; break; }
    }
  }

  return {
    memoryHits: memoryHits,
    commitHits: commitHits,
    resolvedBy: resolvedCommit ? resolvedCommit.hash : null,
    resolvedAt: resolvedCommit ? resolvedCommit.date : null,
    autoFixRecipe: autoFixRecipe ? {
      recipeFile: autoFixRecipe.recipeFile,
      description: autoFixRecipe.description,
      risk: autoFixRecipe.risk,
    } : null,
  };
}

module.exports = {
  bindKnowledge: bindKnowledge,
  extractKeywords: extractKeywords,
  grepMemoryForFingerprint: grepMemoryForFingerprint,
  grepGitLogForFingerprint: grepGitLogForFingerprint,
  findAutoFixRecipe: findAutoFixRecipe,
  loadRecipes: loadRecipes,
};
