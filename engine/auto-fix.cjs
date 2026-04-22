/**
 * Auto-fix engine (L4–L7)
 *
 * Full auto-fix closed loop:
 *   L4  applyRecipe     — sub-agent edits real files (backup→fix→verify→revert)
 *   L5  generateRecipe  — new fingerprint → Claude analyzes → writes recipe JSON+MD
 *   L6  autoApplyFix    — orchestrates: find/generate recipe → apply → verify
 *   L7  autoLearn       — after successful fix → writes memory entry
 *
 * Entry point: runAutoFixCycle(topFailReasons) — called by watchdog Phase 7
 *
 * Safety rails:
 *   - Backup all affected files before any edit
 *   - node -c verification on every changed .js/.cjs file
 *   - Revert ALL changes on any verification failure
 *   - Cooldown: 1 hour per fingerprint after attempt
 *   - Rate limit: max 2 auto-fixes per watchdog cycle
 *   - Skip if any worker is busy (don't touch code mid-task)
 *
 * 2026-04-16 — L4 originally read-only; upgraded to full auto by user request.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var os = require('os');
var { execSync } = require('child_process');
var { loadRecipes, bindKnowledge, findAutoFixRecipe } = require('./failure-fingerprint.cjs');
var archiveWriter;
try { archiveWriter = require('./archive-writer.cjs'); }
catch(e) { archiveWriter = { writeAutoFixAttempt: function() { return null; } }; }

var REPO_ROOT = path.join(__dirname, '..');
var RECIPES_FILE = path.join(REPO_ROOT, 'worker', 'fix-recipes.json');
var STATE_FILE = path.join(REPO_ROOT, 'server-data', 'auto-fix-state.json');
var BACKUP_ROOT = path.join(REPO_ROOT, 'server-data', 'auto-fix-backups');
var CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
var MEMORY_DIR_LEGACY = path.join(os.homedir(), '.claude', 'projects', '-root', 'memory');
var MEMORY_DIR = fs.existsSync(path.join(CODEX_HOME, 'projects', '-root', 'memory'))
  ? path.join(CODEX_HOME, 'projects', '-root', 'memory')
  : MEMORY_DIR_LEGACY;
var MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
var COOLDOWN_MS = 60 * 60 * 1000; // 1h per fingerprint
var MAX_PER_CYCLE = 2;
var MAX_RECIPE_APPLIES = 3; // same recipe applied 3× without resolving → manual-only

// Lazy-load runner to avoid circular deps
var _runner = null;
function getRunner() {
  if (_runner) return _runner;
  try { _runner = require(path.join(REPO_ROOT, 'worker', 'codex-coder.js')).runCodexText; }
  catch(e) { _runner = null; }
  return _runner;
}

function log(msg) { console.log('[auto-fix] ' + msg); }

// Inflight guard — prevent overlapping cycles from duplicating work
var _inflight = false;

// ─── State persistence ──────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch(e) { return { cooldowns: {}, history: [] }; }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch(e) { log('saveState error: ' + e.message); }
}

function fpHash(fp) { return crypto.createHash('md5').update(fp || '').digest('hex').slice(0, 8); }

function isOnCooldown(state, fp) {
  var cd = state.cooldowns[fp];
  if (!cd) return false;
  return (Date.now() - (cd.at || 0)) < COOLDOWN_MS;
}

function setCooldown(state, fp, status) {
  state.cooldowns[fp] = { at: Date.now(), status: status };
}

// ─── Backup / Restore ───────────────────────────────────────────────

function backupFiles(filePaths) {
  var backups = {};
  filePaths.forEach(function(rel) {
    var abs = path.join(REPO_ROOT, rel);
    try {
      if (fs.existsSync(abs)) backups[rel] = fs.readFileSync(abs, 'utf-8');
    } catch(e) { log('backup read failed: ' + rel + ' — ' + e.message); }
  });
  return backups;
}

function restoreFiles(backups) {
  Object.keys(backups).forEach(function(rel) {
    try { fs.writeFileSync(path.join(REPO_ROOT, rel), backups[rel]); }
    catch(e) { log('restore failed: ' + rel + ' — ' + e.message); }
  });
}

// Persist a backup snapshot so a later regression can revert the apply.
// Snapshot lives at server-data/auto-fix-backups/<recipeId>/<rel.path>.
// Overwrites previous snapshot for the same recipe.
function saveBackupSnapshot(recipeId, backups) {
  try {
    var dir = path.join(BACKUP_ROOT, recipeId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    Object.keys(backups).forEach(function(rel) {
      var abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, backups[rel]);
    });
    fs.writeFileSync(path.join(dir, '_files.json'), JSON.stringify(Object.keys(backups), null, 2));
  } catch(e) { log('saveBackupSnapshot failed: ' + e.message); }
}

function restoreBackupSnapshot(recipeId) {
  var dir = path.join(BACKUP_ROOT, recipeId);
  var idx = path.join(dir, '_files.json');
  if (!fs.existsSync(idx)) return { ok: false, error: 'no snapshot' };
  try {
    var files = JSON.parse(fs.readFileSync(idx, 'utf-8'));
    files.forEach(function(rel) {
      var src = path.join(dir, rel);
      var dst = path.join(REPO_ROOT, rel);
      if (fs.existsSync(src)) fs.writeFileSync(dst, fs.readFileSync(src));
    });
    return { ok: true, files: files };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ─── Verification ───────────────────────────────────────────────────

function verifyFiles(filePaths) {
  var errors = [];
  filePaths.forEach(function(rel) {
    if (!/\.(js|cjs|mjs)$/.test(rel)) return;
    var abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) return;
    try {
      execSync('node -c "' + abs + '"', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    } catch(e) {
      errors.push(rel + ': ' + (e.stderr || e.message).slice(0, 200));
    }
  });
  return errors;
}

// ─── L4: Apply recipe (sub-agent edits real files) ──────────────────

/**
 * Parse sub-agent output for file contents.
 * Expected format:
 *   ===FILE:relative/path===
 *   <content>
 *   ===ENDFILE===
 */
function parseFileOutputs(text) {
  var files = {};
  var re = /===FILE:([^=]+)===([\s\S]*?)===ENDFILE===/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var fpath = m[1].trim();
    var content = m[2];
    // Strip leading/trailing newline from content block
    if (content.charAt(0) === '\n') content = content.slice(1);
    if (content.charAt(content.length - 1) === '\n') content = content.slice(0, -1);
    files[fpath] = content;
  }
  return files;
}

/**
 * Run sub-agent that actually produces fixed file contents.
 * Returns { ok, filesChanged: [...], diagnosis, error }
 *
 * 2026-04-16 rewrite: embed file contents directly in the prompt instead of
 * making CC CLI use the Read tool. Previous approach had TWO failure modes:
 *   1. Read tool couldn't find files in tempDir (basename vs full-path mismatch)
 *   2. Multi-turn tool calls + CC CLI boot overhead exceeded 4-min timeout
 * New approach: single API round-trip, no tools, completes in 30-60s.
 */
async function applyRecipe(fingerprintId) {
  var recipes = loadRecipes();
  var recipe = null;
  // Match by id or regex
  for (var i = 0; i < recipes.length; i++) {
    if (recipes[i].id === fingerprintId) { recipe = recipes[i]; break; }
    try {
      if (new RegExp(recipes[i].fingerprintPattern, 'i').test(fingerprintId)) { recipe = recipes[i]; break; }
    } catch(e) {}
  }
  if (!recipe) {
    try { archiveWriter.writeAutoFixAttempt({ recipeId: fingerprintId, fingerprint: fingerprintId, outcome: 'no-recipe', error: 'No recipe for: ' + fingerprintId }); } catch(e) {}
    return { ok: false, error: 'No recipe for: ' + fingerprintId };
  }

  var recipeBody = null;
  try {
    recipeBody = fs.readFileSync(path.join(REPO_ROOT, 'worker', recipe.recipeFile), 'utf-8');
  } catch(e) {}
  if (!recipeBody) {
    try { archiveWriter.writeAutoFixAttempt({ recipeId: recipe.id, fingerprint: fingerprintId, outcome: 'recipe-file-missing', error: 'Recipe file missing: ' + recipe.recipeFile }); } catch(e) {}
    return { ok: false, error: 'Recipe file missing: ' + recipe.recipeFile };
  }

  var runner = getRunner();
  if (!runner) {
    try { archiveWriter.writeAutoFixAttempt({ recipeId: recipe.id, fingerprint: fingerprintId, outcome: 'runner-unavailable', error: 'runCodexText unavailable' }); } catch(e) {}
    return { ok: false, error: 'runCodexText unavailable' };
  }

  // Read affected files and embed in prompt (no Read tool needed)
  var fileContents = [];
  (recipe.affectedFiles || []).forEach(function(rel) {
    var abs = path.join(REPO_ROOT, rel);
    try {
      if (fs.existsSync(abs)) {
        fileContents.push('===CURRENT:' + rel + '===\n' + fs.readFileSync(abs, 'utf-8') + '\n===END===');
      }
    } catch(e) { log('read affected file failed: ' + rel + ' — ' + e.message); }
  });

  // Backup
  var backups = backupFiles(recipe.affectedFiles || []);
  // Snapshot "before" content for diff archiving — backups are sufficient (they ARE before)
  var filesBefore = Object.assign({}, backups);

  var systemPrompt = [
    'You are an auto-fix agent for the Blueprint Editor pipeline.',
    '',
    '# Your task',
    'Apply a specific fix described in the recipe below.',
    '',
    '# Output format (STRICT — parsed programmatically)',
    'First output a short diagnosis (2-3 sentences).',
    'Then for each file you fix, output the COMPLETE fixed file content:',
    '',
    '===FILE:relative/path/to/file.js===',
    '<full file content after fix>',
    '===ENDFILE===',
    '',
    'You may output multiple ===FILE...===ENDFILE=== blocks.',
    'Use the EXACT relative paths from the recipe affectedFiles list.',
    'Do NOT use any tools. The file contents are already provided below.',
    '',
    '# Recipe: ' + recipe.id,
    '- description: ' + recipe.description,
    '- risk: ' + (recipe.risk || 'unknown'),
    '- affectedFiles: ' + (recipe.affectedFiles || []).join(', '),
    '',
    '# Recipe playbook',
    recipeBody,
  ].join('\n');

  var userPrompt = [
    'Apply the fix described in the recipe. The current file contents are provided below.',
    'Output the COMPLETE fixed file content for each file wrapped in ===FILE:path=== / ===ENDFILE=== markers.',
    '',
    '# Current file contents',
    '',
  ].concat(fileContents).join('\n');

  log('Applying recipe ' + recipe.id + ' (' + (recipe.affectedFiles || []).length + ' files, prompt=' + (systemPrompt.length + userPrompt.length) + 'c)');
  var result;
  // Shared archive helper for every early-return path below.
  var archiveAttempt = function(outcome, extras) {
    try {
      archiveWriter.writeAutoFixAttempt(Object.assign({
        recipeId: recipe.id,
        fingerprint: fingerprintId,
        subAgentPrompt: { system: systemPrompt, user: userPrompt },
        subAgentOutputHead: (result && result.text) || '',
        subAgentOutputLen: result && result.text ? result.text.length : 0,
        filesBefore: filesBefore,
        filesAfter: extras && extras.filesAfter ? extras.filesAfter : {},
        rejectedPaths: (extras && extras.rejectedPaths) || [],
        verifyErrors: (extras && extras.verifyErrors) || [],
        outcome: outcome,
        reverted: !!(extras && extras.reverted),
        error: (extras && extras.error) || null,
        diagnosis: (extras && extras.diagnosis) || '',
      }, extras || {}));
    } catch(e) { log('archive-writer failed: ' + e.message); }
  };
  try {
    result = await runner({
      systemPrompt: systemPrompt,
      userPrompt: userPrompt,
      // No additionalFiles — contents embedded in prompt, no Read tool needed
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      timeoutMs: 6 * 60 * 1000,
      minOutputLen: 100,
      taskId: 'autofix-' + recipe.id,
      noTools: true,
      log: function(m) { log(m); },
    });
  } catch(e) {
    archiveAttempt('sub-agent-threw', { error: 'Sub-agent threw: ' + e.message });
    return { ok: false, error: 'Sub-agent threw: ' + e.message, recipe: recipe.id };
  }

  if (!result || !result.ok) {
    var resultErr = result ? result.error : 'no result';
    archiveAttempt('sub-agent-failed', { error: resultErr });
    return { ok: false, error: resultErr, recipe: recipe.id };
  }

  // Parse fixed file outputs
  var fixedFiles = parseFileOutputs(result.text || '');
  var changedPaths = Object.keys(fixedFiles);

  if (changedPaths.length === 0) {
    log('Sub-agent produced no ===FILE=== blocks — treating as diagnostic-only');
    archiveAttempt('no-output', {
      error: 'No file outputs in sub-agent response',
      diagnosis: (result.text || '').slice(0, 500),
    });
    return { ok: false, error: 'No file outputs in sub-agent response', diagnosis: (result.text || '').slice(0, 500), recipe: recipe.id };
  }

  // Validate and write fixed files
  var allowedFiles = recipe.affectedFiles || [];
  var rejectedPaths = [];
  changedPaths.forEach(function(rel) {
    // Path traversal guard: reject ../ and absolute paths
    if (/\.\.[\\/]/.test(rel) || path.isAbsolute(rel)) {
      rejectedPaths.push(rel);
      log('REJECT path traversal: ' + rel);
      return;
    }
    // Whitelist guard: sub-agent output must match recipe.affectedFiles
    if (allowedFiles.length > 0 && allowedFiles.indexOf(rel) < 0) {
      rejectedPaths.push(rel);
      log('REJECT path not in recipe.affectedFiles: ' + rel);
      return;
    }
    // Resolved path must stay within REPO_ROOT
    var abs = path.resolve(REPO_ROOT, rel);
    if (!abs.startsWith(REPO_ROOT + path.sep) && abs !== REPO_ROOT) {
      rejectedPaths.push(rel);
      log('REJECT resolved path escapes repo: ' + abs);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, fixedFiles[rel]);
    } catch(e) {
      log('Write failed: ' + rel + ' — ' + e.message);
    }
  });
  if (rejectedPaths.length > 0) {
    log('WARNING: ' + rejectedPaths.length + ' path(s) rejected by safety check: ' + rejectedPaths.join(', '));
  }
  // Filter changedPaths to only actually written files
  changedPaths = changedPaths.filter(function(p) { return rejectedPaths.indexOf(p) < 0; });
  // Build filesAfter snapshot for diff archive (only paths that were actually written).
  var filesAfter = {};
  changedPaths.forEach(function(rel) { filesAfter[rel] = fixedFiles[rel]; });

  if (changedPaths.length === 0 && rejectedPaths.length > 0) {
    log('All file outputs rejected — reverting');
    restoreFiles(backups);
    archiveAttempt('all-rejected', {
      rejectedPaths: rejectedPaths,
      reverted: true,
      error: 'All paths rejected by safety check',
    });
    return { ok: false, error: 'All paths rejected by safety check', reverted: true, recipe: recipe.id };
  }

  // Verify
  var verifyErrors = verifyFiles(changedPaths);
  if (verifyErrors.length > 0) {
    log('Verification FAILED — reverting: ' + verifyErrors.join('; '));
    restoreFiles(backups);
    archiveAttempt('verify-failed', {
      filesAfter: filesAfter,
      rejectedPaths: rejectedPaths,
      verifyErrors: verifyErrors,
      reverted: true,
      error: 'Verification failed: ' + verifyErrors.join('; '),
    });
    return { ok: false, error: 'Verification failed: ' + verifyErrors.join('; '), reverted: true, recipe: recipe.id };
  }

  log('Recipe ' + recipe.id + ' applied successfully: ' + changedPaths.join(', '));
  // Persist pre-apply backup so runAutoFixCycle can revert if the recipe turns
  // out to be wrong (fingerprint re-surfaces after apply).
  saveBackupSnapshot(recipe.id, backups);
  var diagnosisText = (result.text || '').split('===FILE')[0].trim().slice(0, 500);
  var archiveInfo = null;
  try {
    archiveInfo = archiveWriter.writeAutoFixAttempt({
      recipeId: recipe.id,
      fingerprint: fingerprintId,
      subAgentPrompt: { system: systemPrompt, user: userPrompt },
      subAgentOutputHead: result.text || '',
      subAgentOutputLen: (result.text || '').length,
      filesBefore: filesBefore,
      filesAfter: filesAfter,
      rejectedPaths: rejectedPaths,
      verifyErrors: [],
      outcome: 'applied',
      diagnosis: diagnosisText,
    });
  } catch(e) { log('archive-writer success-path failed: ' + e.message); }
  return {
    ok: true,
    recipe: recipe.id,
    filesChanged: changedPaths,
    diagnosis: diagnosisText,
    archive: archiveInfo,
  };
}

// ─── L5: Auto-generate recipe ───────────────────────────────────────

async function generateRecipe(fingerprint, context) {
  var runner = getRunner();
  if (!runner) return { ok: false, error: 'runCodexText unavailable' };

  var id = 'auto-' + fpHash(fingerprint);
  context = context || {};

  var systemPrompt = [
    'You are a pipeline diagnostic agent for the Blueprint Editor (Luna playable ad AI coding pipeline).',
    '',
    '# Key pipeline files (all in /opt/blueprint-editor/)',
    '- engine/pipeline.cjs — 8-stage orchestrator',
    '- engine/stages/compile.cjs, static-check.cjs, visual-check.cjs, cua-verify.cjs, spec-validate.cjs',
    '- engine/recode.cjs — patch recode',
    '- worker/codex-coder.js — unified Codex entry',
    '- worker/codex-code-coder.js — Codex code worker implementation',
    '- worker/worker-coder.js — legacy coder',
    '- lib/model-provider.cjs — LLM providers',
    '- .env, worker/.env — config',
    '',
    '# Your task',
    'Analyze a recurring failure fingerprint. Identify root cause. Produce a fix recipe.',
    '',
    '# Output format (STRICT — parsed programmatically)',
    'Output a JSON block then a markdown block, nothing else:',
    '',
    '```json',
    '{',
    '  "id": "' + id + '",',
    '  "fingerprintPattern": "<regex matching this fingerprint class>",',
    '  "description": "<one-line>",',
    '  "risk": "low|medium|high",',
    '  "autoApply": true,',
    '  "affectedFiles": ["<relative paths>"],',
    '  "relatedMemories": []',
    '}',
    '```',
    '',
    '```markdown',
    '# ' + id,
    '## Diagnosis',
    '<2-4 sentences>',
    '## Root Cause',
    '<file:line>',
    '## Fix',
    '<exact code changes>',
    '## Verification',
    '<command>',
    '```',
    '',
    'Set risk to "low" if the fix is a config change or a simple guard clause.',
    'Set risk to "medium" if it touches core pipeline logic.',
    'Set risk to "high" if it could affect codegen output or task flow.',
    'Set autoApply to true for low and medium risk, false for high only.',
  ].join('\n');

  var userPrompt = [
    '## Failure fingerprint',
    fingerprint,
    '',
    '## Error sample',
    context.sampleReason || 'N/A',
    '',
    '## Stage: ' + (context.stage || 'unknown'),
    '## Hit count: ' + (context.retries || '?') + ' retries across ' + (context.uniqueTasks || '?') + ' tasks',
    '',
    'Use the Read tool to inspect the relevant pipeline files. Identify the root cause and produce the recipe.',
  ].join('\n');

  log('Generating recipe for: ' + fingerprint.slice(0, 80));
  var result;
  try {
    result = await runner({
      systemPrompt: systemPrompt,
      userPrompt: userPrompt,
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      timeoutMs: 6 * 60 * 1000,
      minOutputLen: 200,
      taskId: 'gen-recipe-' + id,
      log: function(m) { log(m); },
    });
  } catch(e) {
    return { ok: false, error: 'Sub-agent threw: ' + e.message };
  }

  if (!result || !result.ok) {
    return { ok: false, error: result ? result.error : 'no result' };
  }

  var text = result.text || '';
  var jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  var mdMatch = text.match(/```markdown\s*\n([\s\S]*?)\n\s*```/);

  if (!jsonMatch) return { ok: false, error: 'No JSON block in output', raw: text.slice(0, 500) };

  var recipe;
  try { recipe = JSON.parse(jsonMatch[1]); }
  catch(e) { return { ok: false, error: 'JSON parse: ' + e.message, raw: jsonMatch[1].slice(0, 300) }; }

  // Ensure required fields
  recipe.id = recipe.id || id;
  recipe.recipeFile = recipe.recipeFile || ('fix-recipes/' + id + '.md');

  var recipeBody = mdMatch ? mdMatch[1] : '# ' + id + '\n\nAuto-generated.\n\n' + text;

  // Write recipe markdown
  var recipeDir = path.join(REPO_ROOT, 'worker', 'fix-recipes');
  try { fs.mkdirSync(recipeDir, { recursive: true }); } catch(e) {}
  fs.writeFileSync(path.join(REPO_ROOT, 'worker', recipe.recipeFile), recipeBody);

  // Append to fix-recipes.json (no duplicates)
  var recipes = [];
  try { recipes = JSON.parse(fs.readFileSync(RECIPES_FILE, 'utf-8')); } catch(e) {}
  var idx = recipes.findIndex(function(r) { return r.id === recipe.id; });
  if (idx >= 0) recipes[idx] = recipe; else recipes.push(recipe);
  fs.writeFileSync(RECIPES_FILE, JSON.stringify(recipes, null, 2));

  log('Recipe generated: ' + recipe.id + ' (risk=' + recipe.risk + ', autoApply=' + recipe.autoApply + ')');
  return { ok: true, recipe: recipe, recipeBody: recipeBody };
}

// ─── L7: Auto-learn (write memory after successful fix) ─────────────

function autoLearn(fingerprint, recipe, applyResult) {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    var id = recipe.id || recipe;
    var safeName = 'autofix_' + String(id).replace(/[^a-z0-9_-]/gi, '_');
    var memFile = safeName + '.md';
    var memPath = path.join(MEMORY_DIR, memFile);
    var date = new Date().toISOString().slice(0, 10);

    var content = [
      '---',
      'name: Auto-fix ' + id,
      'description: ' + date + ' 自动修复 pipeline 指纹 ' + String(fingerprint).slice(0, 60),
      'type: feedback',
      '---',
      '',
      'Pipeline 错误指纹 `' + String(fingerprint).slice(0, 100) + '` 已被 auto-fix 自动修复。',
      '',
      '**Recipe:** ' + id,
      '**Risk:** ' + (recipe.risk || 'unknown'),
      '**Files changed:** ' + (applyResult.filesChanged || []).join(', '),
      '**Diagnosis:** ' + (applyResult.diagnosis || 'N/A'),
      '',
      '**Why:** 该指纹重复出现在 dashboard 失败列表，auto-fix L6 自动触发修复。',
      '**How to apply:** 如果此指纹再次出现（回归），检查上述 files 是否被其他改动覆盖。',
    ].join('\n');

    fs.writeFileSync(memPath, content);

    // Update MEMORY.md index
    if (fs.existsSync(MEMORY_INDEX)) {
      var idx = fs.readFileSync(MEMORY_INDEX, 'utf-8');
      var entry = '- [Auto-fix ' + id + '](' + memFile + ') — ' + date + ' 自动修复 ' + String(fingerprint).slice(0, 40);
      if (idx.indexOf(memFile) < 0) {
        fs.writeFileSync(MEMORY_INDEX, idx.trimEnd() + '\n' + entry + '\n');
      }
    }

    log('Memory written: ' + memFile);
  } catch(e) {
    log('autoLearn error: ' + e.message);
  }
}

// ─── L6 orchestrator: runAutoFixCycle ────────────────────────────────

/**
 * Main entry point — called by watchdog Phase 7.
 * @param {Array} topFailReasons — from metrics.getMetricsSummary().topFailReasons
 * @returns {{ attempted: number, applied: number, generated: number, skipped: number, details: string[] }}
 */
async function runAutoFixCycle(topFailReasons) {
  // Inflight guard — watchdog fires every 120s but recipe generation takes 2-4 min.
  // Without this, overlapping cycles would spawn duplicate sub-agents.
  if (_inflight) {
    log('Cycle skipped — previous cycle still in-flight');
    return { attempted: 0, applied: 0, generated: 0, skipped: 0, details: ['skipped: previous cycle in-flight'] };
  }
  _inflight = true;

  var state = loadState();
  var details = [];
  var stats = { attempted: 0, applied: 0, generated: 0, skipped: 0 };

  try {

  if (!topFailReasons || topFailReasons.length === 0) {
    details.push('No failure fingerprints');
    return stats;
  }

  for (var i = 0; i < topFailReasons.length && stats.attempted < MAX_PER_CYCLE; i++) {
    var fp = topFailReasons[i];
    var fingerprint = fp.fingerprint;

    // Skip if on cooldown
    if (isOnCooldown(state, fingerprint)) {
      stats.skipped++;
      continue;
    }

    // Skip old fingerprints (last seen > 24h ago)
    if (fp.lastSeen) {
      var age = Date.now() - new Date(fp.lastSeen).getTime();
      if (age > 24 * 60 * 60 * 1000) {
        stats.skipped++;
        continue;
      }
    }

    // Try to find existing recipe
    var recipe = findAutoFixRecipe(fingerprint);

    if (!recipe) {
      // L5: Generate recipe
      stats.attempted++;
      // Pre-set cooldown to prevent overlapping cycles from retrying same fingerprint
      setCooldown(state, fingerprint, 'generating');
      saveState(state);
      var genResult = await generateRecipe(fingerprint, {
        sampleReason: fp.sampleReason,
        stage: fp.failedAtStage,
        retries: fp.retries,
        uniqueTasks: fp.uniqueTasks,
      });
      setCooldown(state, fingerprint, genResult.ok ? 'recipe-generated' : 'gen-failed');

      if (genResult.ok) {
        stats.generated++;
        recipe = genResult.recipe;
        details.push('[L5] Generated recipe ' + recipe.id + ' (risk=' + recipe.risk + ')');
      } else {
        details.push('[L5] Recipe gen failed for ' + fingerprint.slice(0, 50) + ': ' + (genResult.error || '').slice(0, 100));
        continue;
      }
    }

    // L6: Auto-apply if allowed
    // 2026-04-17: per-recipe apply cap — if this recipe has been applied N times
    // without resolving the issue, stop wasting tokens and mark manual-only.
    // Root cause of old idle loop: different fingerprints (47min vs 51min) mapped
    // to the same recipe, bypassing per-fingerprint cooldown.
    if (recipe && recipe.autoApply !== false) {
      var recipeApplyCount = (state.history || []).filter(function(h) {
        return h.recipe === recipe.id;
      }).length;

      // Regression check: fingerprint was marked 'applied' previously but it's
      // back — the recipe is ineffective. Revert the previous apply (restore
      // from snapshot) and mark manual-only so humans can inspect.
      var prevCooldown = state.cooldowns && state.cooldowns[fingerprint];
      if (prevCooldown && prevCooldown.status === 'applied' && recipeApplyCount >= 1) {
        var revert = restoreBackupSnapshot(recipe.id);
        if (revert.ok) {
          log('Regression detected — reverted recipe ' + recipe.id + ' (files: ' + revert.files.join(', ') + ')');
          details.push('[L6] Regression revert ' + recipe.id + ' → manual-only (files restored: ' + revert.files.join(', ') + ')');
        } else {
          log('Regression detected but revert failed (' + revert.error + ') — marking manual-only anyway');
          details.push('[L6] Regression on ' + recipe.id + ' → manual-only (revert failed: ' + revert.error + ')');
        }
        setCooldown(state, fingerprint, 'reverted');
        // Persist a note so operators see which recipe is invalid.
        state.invalidRecipes = state.invalidRecipes || {};
        state.invalidRecipes[recipe.id] = { at: new Date().toISOString(), fingerprint: fingerprint.slice(0, 120), reverted: revert.ok };
        saveState(state);
        stats.skipped++;
        continue;
      }

      if (recipeApplyCount >= MAX_RECIPE_APPLIES) {
        log('Recipe ' + recipe.id + ' already applied ' + recipeApplyCount + ' times without resolving — marking manual-only');
        setCooldown(state, fingerprint, 'manual-only');
        details.push('[L6] Recipe ' + recipe.id + ' exhausted (' + recipeApplyCount + '/' + MAX_RECIPE_APPLIES + ' applies) — manual-only');
        stats.skipped++;
        saveState(state);
        continue;
      }

      stats.attempted++;
      setCooldown(state, fingerprint, 'applying');
      saveState(state);
      var applyResult = await applyRecipe(recipe.id);
      setCooldown(state, fingerprint, applyResult.ok ? 'applied' : 'apply-failed');

      if (applyResult.ok) {
        stats.applied++;
        details.push('[L6] Applied ' + recipe.id + ': ' + (applyResult.filesChanged || []).join(', '));

        // L7: Auto-learn
        autoLearn(fingerprint, recipe, applyResult);
        details.push('[L7] Memory written for ' + recipe.id);

        state.history.push({
          at: new Date().toISOString(),
          fingerprint: fingerprint.slice(0, 100),
          recipe: recipe.id,
          files: applyResult.filesChanged,
          archiveAttempt: applyResult.archive ? applyResult.archive.attemptHash : null,
          archivePath: applyResult.archive ? path.relative(REPO_ROOT, applyResult.archive.archivePath) : null,
        });
        // Keep history bounded
        if (state.history.length > 50) state.history = state.history.slice(-50);
      } else {
        details.push('[L6] Apply failed ' + (recipe.id || '') + ': ' + (applyResult.error || '').slice(0, 150));
      }
    } else if (recipe) {
      // Auto-promote medium-risk recipes after 3+ regression hits
      var regressionHits = (state.regressionHits || {})[recipe.id] || 0;
      regressionHits++;
      if (!state.regressionHits) state.regressionHits = {};
      state.regressionHits[recipe.id] = regressionHits;
      if (recipe.risk === 'medium' && regressionHits >= 3) {
        log('Auto-promoting medium-risk recipe ' + recipe.id + ' after ' + regressionHits + ' regression hits');
        recipe.autoApply = true;
        var recipes = JSON.parse(fs.readFileSync(RECIPES_FILE, 'utf8'));
        for (var ri = 0; ri < recipes.length; ri++) {
          if (recipes[ri].id === recipe.id) { recipes[ri].autoApply = true; break; }
        }
        fs.writeFileSync(RECIPES_FILE, JSON.stringify(recipes, null, 2));
        details.push('[L6] Auto-promoted ' + recipe.id + ' (medium→autoApply after ' + regressionHits + ' hits)');
      } else {
        details.push('[L6] Recipe ' + recipe.id + ' exists but autoApply=false (risk=' + recipe.risk + ', hits=' + regressionHits + '/3)');
        setCooldown(state, fingerprint, 'manual-only');
        stats.skipped++;
      }
    }
  }

  saveState(state);
  return { attempted: stats.attempted, applied: stats.applied, generated: stats.generated, skipped: stats.skipped, details: details };

  } finally {
    _inflight = false;
  }
}

function validatePath(rel, allowedFiles, repoRoot) {
  if (/\.\.[\\/]/.test(rel) || path.isAbsolute(rel)) return 'traversal';
  if (allowedFiles.length > 0 && allowedFiles.indexOf(rel) < 0) return 'not-allowed';
  var abs = path.resolve(repoRoot, rel);
  if (!abs.startsWith(repoRoot + path.sep) && abs !== repoRoot) return 'escape';
  return null;
}

module.exports = {
  applyRecipe: applyRecipe,
  generateRecipe: generateRecipe,
  autoLearn: autoLearn,
  runAutoFixCycle: runAutoFixCycle,
  validatePath: validatePath,
  // Exposed for API handler (dashboard manual trigger)
  findRecipe: function(id) {
    var recipes = loadRecipes();
    for (var i = 0; i < recipes.length; i++) {
      if (recipes[i].id === id) return recipes[i];
      try { if (new RegExp(recipes[i].fingerprintPattern, 'i').test(id)) return recipes[i]; }
      catch(e) {}
    }
    return null;
  },
};
