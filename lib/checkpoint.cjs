/**
 * Checkpoint filesystem helpers.
 *
 * Checkpoint files live at server-data/checkpoints/<taskId>/checkpoint.json
 * (mirror of the path hardcoded in worker/linux-worker-client.js:CHECKPOINT_DIR).
 *
 * Written by worker on pipeline progress + graceful shutdown; read back by
 * worker.processTask() to resume completedStages. When a task is cancelled or
 * freshly re-submitted, the checkpoint must be cleared — otherwise resume
 * silently skips codegen and feeds stale csCode into downstream stages.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var CHECKPOINT_ROOT = path.join(__dirname, '..', 'server-data', 'checkpoints');
var REPO_ROOT = path.join(__dirname, '..');
var STAGE_ORDER = [
  'clone',
  'spec-extract',
  'spec-validate',
  'complexity-gate',
  'assembly-plan',
  'assembly-complexity-gate',
  'codegen',
  'method-check',
  'review',
  'compile',
  'visual-check',
  'runtime-contract',
  'cua-verify',
  'upload',
];

function checkpointDirFor(taskId) {
  return path.join(CHECKPOINT_ROOT, taskId);
}

function clearCheckpoint(taskId) {
  var dir = checkpointDirFor(taskId);
  if (!fs.existsSync(dir)) return { cleared: false, reason: 'not-exists' };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { cleared: true };
  } catch (e) {
    return { cleared: false, reason: e.message };
  }
}

function readCheckpoint(taskId) {
  var dir = checkpointDirFor(taskId);
  var fp = path.join(dir, 'checkpoint.json');
  if (!fs.existsSync(fp)) return null;
  try {
    var data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (data && data.hasHtmlOutput) {
      var htmlPath = path.join(dir, 'htmlOutput.bin');
      if (fs.existsSync(htmlPath)) {
        data.htmlOutput = fs.readFileSync(htmlPath, 'utf8');
      }
    }
    return data;
  } catch (_e) {
    return null;
  }
}

function inferResumeStage(checkpoint) {
  var completedStages = (checkpoint && checkpoint.completedStages) || [];
  var seen = {};
  for (var i = 0; i < completedStages.length; i++) {
    seen[completedStages[i]] = true;
  }
  for (var j = 0; j < STAGE_ORDER.length; j++) {
    if (!seen[STAGE_ORDER[j]]) return STAGE_ORDER[j];
  }
  return null;
}

// Files whose content determines what codegen / review / static-check will produce.
// Changes to any of these invalidate `codegen` and all downstream stages in a
// resumed checkpoint — stages upstream of codegen (clone / spec-extract /
// spec-validate / complexity-gate) are pure functions of blueprint input and
// remain safe to reuse.
var CODEGEN_FINGERPRINT_FILES = [
  'adapters/assembly-plan-pipeline.cjs',
  'adapters/skeleton-generator.cjs',
  'adapters/codegen-template-engine.cjs',
  'adapters/schema/load-assembly-registry.cjs',
  'adapters/schema/validate-assembly-plans.cjs',
  'adapters/schema/validate-assembly-registry.cjs',
  'adapters/schema/assembly-registry-v1/registry-pack.v1.json',
  'adapters/schema/assembly-registry-v1/storyboard-atoms.v1.json',
  'adapters/schema/assembly-registry-v1/runtime-modules.v1.json',
  'adapters/schema/assembly-registry-v1/atom-module-mapping.v1.json',
  'adapters/schema/assembly-registry-v1/cua-assertions.v1.json',
  'engine/static-check.cjs',
  'engine/stages/assembly-plan.cjs',
  'engine/stages/codegen-schema.cjs',
  'engine/stages/codegen-legacy.cjs',
  'engine/stages/review.cjs',
];

// Directories whose contents should be scanned recursively (every .cjs/.js file).
var CODEGEN_FINGERPRINT_DIRS = [
  'adapters/templates',
];

// Stages that are safe to reuse when the codegen fingerprint changes.
var UPSTREAM_STAGES = ['clone', 'spec-validate', 'complexity-gate', 'spec-extract'];

function _collectFileList() {
  var list = CODEGEN_FINGERPRINT_FILES.slice();
  CODEGEN_FINGERPRINT_DIRS.forEach(function(rel) {
    var abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) return;
    walkDir(abs, rel, list);
  });
  list.sort(); // deterministic order
  return list;
}

function walkDir(abs, relPrefix, out) {
  var entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (_e) { return; }
  entries.forEach(function(ent) {
    var entRel = path.join(relPrefix, ent.name);
    var entAbs = path.join(abs, ent.name);
    if (ent.isDirectory()) {
      walkDir(entAbs, entRel, out);
    } else if (/\.(cjs|js)$/.test(ent.name)) {
      out.push(entRel);
    }
  });
}

/**
 * Compute a stable SHA1 hex over the contents of all codegen-relevant files.
 * Missing files contribute an empty marker so deletions also shift the hash.
 * Returns a short 16-char prefix plus file count for debuggability.
 */
function computePipelineFingerprint() {
  var files = _collectFileList();
  var h = crypto.createHash('sha1');
  files.forEach(function(rel) {
    var abs = path.join(REPO_ROOT, rel);
    h.update(rel);
    h.update('\0');
    try {
      h.update(fs.readFileSync(abs));
    } catch (_e) {
      h.update('<missing>');
    }
    h.update('\0');
  });
  return { hash: h.digest('hex').slice(0, 16), fileCount: files.length };
}

/**
 * Decide how to treat a checkpoint given current pipeline fingerprint.
 * Returns:
 *   { action: 'resume',     completedStages }                   — fingerprint match, resume as-is
 *   { action: 'resume-legacy', completedStages, warn }          — no stored fingerprint (pre-D checkpoint)
 *   { action: 'invalidate', completedStages, droppedStages }    — fingerprint mismatch, drop codegen+downstream
 */
function reconcileCheckpoint(saved, current) {
  var savedStages = (saved && saved.completedStages) || [];
  if (!saved || !saved.pipelineVersion) {
    return { action: 'resume-legacy', completedStages: savedStages, warn: 'no pipelineVersion in checkpoint (pre-D write)' };
  }
  if (saved.pipelineVersion.hash === current.hash) {
    return { action: 'resume', completedStages: savedStages };
  }
  var kept = savedStages.filter(function(s) { return UPSTREAM_STAGES.indexOf(s) >= 0; });
  var dropped = savedStages.filter(function(s) { return UPSTREAM_STAGES.indexOf(s) < 0; });
  return {
    action: 'invalidate',
    completedStages: kept,
    droppedStages: dropped,
    savedHash: saved.pipelineVersion.hash,
    currentHash: current.hash,
  };
}

/**
 * Decide whether a worker shutdown is allowed to persist an in-memory checkpoint.
 * This guards against a stale worker overwriting a freshly scrubbed checkpoint
 * after the task has already been re-queued or moved to a different worker.
 */
function shouldSaveCheckpointOnShutdown(taskSnapshot, workerId) {
  if (!taskSnapshot || typeof taskSnapshot !== 'object') {
    return { ok: false, reason: 'missing-task-snapshot' };
  }
  var status = taskSnapshot.status || null;
  var assignedTo = taskSnapshot.assigned_to || taskSnapshot.assignedTo || null;
  if (!status) {
    return { ok: false, reason: 'missing-task-status' };
  }
  if (assignedTo !== workerId) {
    return {
      ok: false,
      reason: assignedTo ? ('owned-by-' + assignedTo) : 'unassigned',
    };
  }
  if (STAGE_ORDER.indexOf(status) >= 0) {
    // Defensive only; tasks should not use stage names as queue states.
    return { ok: false, reason: 'invalid-task-status-' + status };
  }
  if (['assigned', 'processing', 'building'].indexOf(status) === -1) {
    return { ok: false, reason: 'inactive-status-' + status };
  }
  return { ok: true, reason: 'owned-active' };
}

module.exports = {
  clearCheckpoint: clearCheckpoint,
  readCheckpoint: readCheckpoint,
  checkpointDirFor: checkpointDirFor,
  computePipelineFingerprint: computePipelineFingerprint,
  reconcileCheckpoint: reconcileCheckpoint,
  inferResumeStage: inferResumeStage,
  shouldSaveCheckpointOnShutdown: shouldSaveCheckpointOnShutdown,
  UPSTREAM_STAGES: UPSTREAM_STAGES,
  STAGE_ORDER: STAGE_ORDER,
};
