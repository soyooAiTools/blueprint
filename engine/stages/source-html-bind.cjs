/**
 * Stage: source-html-bind (Layer 3)
 * v4 — fix auto-b4e82f17: confirmed & documented that resolveSourceHtmlPath()
 *   probes ctx.task.sourceHtmlPath / ctx.task.source_html_path (items 4 & 5
 *   below) so orchestrators that carry the path at the task level are honoured
 *   and the error message is consistent with the actual probe order.
 *   (Implementation first landed in v3 / auto-871ebc2b; this revision
 *   completes the recipe by verifying no residual gap remains.)
 *
 * v3 — fix auto-871ebc2b: backfill blueprint.sourceHtmlPath from top-level
 *   task fields in PipelineContext constructor so orchestrators that submit
 *   tasks with sourceHtmlPath outside blueprint_json are honoured before
 *   assertBefore runs. resolveSourceHtmlPath also probes ctx.task directly
 *   as a defence-in-depth fallback (items 4 & 5 below).
 *
 * v2 — incorporates Jonny review (msg a892d842):
 *   - canonical = blueprint.sourceHtmlPath + blueprint.sourceHtmlSha256
 *   - read SOURCE_HTML_BIND_HARD env per call (no module-load cache)
 *   - write-back to blueprint so checkpoint resume preserves binding
 *   - sha256 guard: missing hash = WARN, hash mismatch = HARD FAIL
 *
 * Purpose: shift-left pipeline-entry enforcement. Resolves and binds
 * ctx.sourceHtmlPath as the FIRST stage in the pipeline so every downstream
 * fidelity check has a canonical source of truth, and persists the binding to
 * the blueprint so checkpoint resume does not lose it.
 *
 * Placement: BEFORE `clone` in createLunaPipeline.
 *
 * Resolution order (first match wins):
 *   1. ctx.blueprint.sourceHtmlPath          (canonical, blueprint-embedded)
 *   2. ctx.blueprint.storyboard.htmlPath     (from storyboard2html adapter output)
 *   3. ctx.blueprint.visualAssets.source     (from project.visualAssets export — Jonny export-boundary patch)
 *   4. ctx.task.sourceHtmlPath / ctx.task.source_html_path  (top-level task fields set by orchestrators)
 *   5. process.env.SOURCE_HTML_PATH          (worker-level override)
 *
 * NOTE: PipelineContext constructor now backfills blueprint.sourceHtmlPath
 * from top-level task fields (items 4/5) before this stage runs, so item 1
 * will already be populated in most cases. Items 4 & 5 in resolveSourceHtmlPath
 * remain as defence-in-depth for any caller that constructs a bare context.
 *
 * Transition phases:
 *   Phase 1 (default): SOFT missing path → loud WARN; missing sha256 → WARN
 *   Phase 1 sha256 mismatch: HARD FAIL (tamper/wrong source, not a rollout
 *     compatibility issue per Jonny)
 *   Phase 2 (SOURCE_HTML_BIND_HARD=true): missing path OR sha256 → HARD FAIL
 *
 * Once bound:
 *   ctx.sourceHtmlPath              — absolute resolved path
 *   ctx.sourceHtmlSha256            — actual sha256 of file content
 *   ctx.blueprint.sourceHtmlPath    — write-back (survives checkpoint)
 *   ctx.blueprint.sourceHtmlSha256  — write-back
 */

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function isHardMode() {
  return process.env.SOURCE_HTML_BIND_HARD === 'true';
}

function resolveSourceHtmlPath(ctx) {
  var candidates = [];

  // 1. Canonical blueprint field
  if (ctx.blueprint && ctx.blueprint.sourceHtmlPath) {
    candidates.push({ from: 'blueprint.sourceHtmlPath', value: ctx.blueprint.sourceHtmlPath });
  }

  // 2. Storyboard adapter output
  if (ctx.blueprint && ctx.blueprint.storyboard && ctx.blueprint.storyboard.htmlPath) {
    candidates.push({ from: 'blueprint.storyboard.htmlPath', value: ctx.blueprint.storyboard.htmlPath });
  }

  // 3. Project visualAssets export (Jonny export-boundary patch)
  if (ctx.blueprint && ctx.blueprint.visualAssets && ctx.blueprint.visualAssets.source) {
    candidates.push({ from: 'blueprint.visualAssets.source', value: ctx.blueprint.visualAssets.source });
  }

  // 4. Top-level task fields set by orchestrators that submit outside blueprint_json.
  //    PipelineContext constructor backfills these into blueprint.sourceHtmlPath, so
  //    this branch acts as defence-in-depth for bare/test contexts.
  if (ctx.task) {
    var taskPath = ctx.task.sourceHtmlPath || ctx.task.source_html_path || null;
    if (taskPath) {
      candidates.push({ from: 'task.sourceHtmlPath', value: taskPath });
    }
  }

  // 5. Worker-level environment override
  if (process.env.SOURCE_HTML_PATH) {
    candidates.push({ from: 'env.SOURCE_HTML_PATH', value: process.env.SOURCE_HTML_PATH });
  }

  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c.value && fs.existsSync(c.value)) {
      return { path: path.resolve(c.value), from: c.from };
    }
  }
  return null;
}

function sha256OfFile(filePath) {
  var hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

module.exports = {
  name: 'source-html-bind',
  canRetry: false,

  assertBefore: function(ctx) {
    var hard = isHardMode();
    var resolved = resolveSourceHtmlPath(ctx);
    if (!resolved) {
      var missMsg = 'source-html-bind: no sourceHtmlPath resolvable from blueprint/task/env. ' +
        'A task MUST declare its canonical source HTML via blueprint.sourceHtmlPath, ' +
        'task.sourceHtmlPath, task.source_html_path, or env.SOURCE_HTML_PATH so visual ' +
        'fidelity can be enforced shift-left.';
      if (hard) {
        throw new Error(missMsg + ' (HARD mode — SOURCE_HTML_BIND_HARD=true.)');
      }
      ctx.addLog && ctx.addLog('source-html-bind', 'WARN — ' + missMsg + ' (transition phase; will be HARD soon.)');
      console.warn('[source-html-bind][WARN] ' + missMsg);
      return;
    }

    // File exists; compute actual sha256.
    var actualSha = sha256OfFile(resolved.path);
    var declaredSha = ctx.blueprint && ctx.blueprint.sourceHtmlSha256;

    if (declaredSha) {
      if (declaredSha !== actualSha) {
        // Hash mismatch is ALWAYS a hard fail (per Jonny): tamper / wrong source,
        // not a rollout compatibility issue.
        throw new Error(
          'source-html-bind: sourceHtmlSha256 mismatch — declared=' + declaredSha +
          ' actual=' + actualSha + ' path=' + resolved.path +
          ' (refusing to proceed; either the file was tampered with or the wrong ' +
          'source is declared in the blueprint).'
        );
      }
    } else {
      // No declared hash — soft warn (phase 1). Hard fail in phase 2.
      var hashMsg = 'source-html-bind: blueprint.sourceHtmlSha256 missing — cannot verify source integrity.';
      if (hard) {
        throw new Error(hashMsg + ' (HARD mode requires declared sha256.)');
      }
      ctx.addLog && ctx.addLog('source-html-bind', 'WARN — ' + hashMsg + ' (transition phase.)');
    }

    // Bind on ctx
    ctx.sourceHtmlPath = resolved.path;
    ctx.sourceHtmlSha256 = actualSha;
    ctx._sourceHtmlBindFrom = resolved.from;

    // Write-back so checkpoint resume (which skips completed stages) preserves it
    if (!ctx.blueprint) ctx.blueprint = {};
    ctx.blueprint.sourceHtmlPath = resolved.path;
    ctx.blueprint.sourceHtmlSha256 = actualSha;
  },

  canSkip: function() { return false; },

  execute: function(ctx) {
    if (ctx.sourceHtmlPath) {
      ctx.addLog && ctx.addLog(
        'source-html-bind',
        'BOUND sourceHtmlPath=' + ctx.sourceHtmlPath +
        ' sha256=' + (ctx.sourceHtmlSha256 || '<unverified>') +
        ' (from ' + ctx._sourceHtmlBindFrom + ')'
      );
    } else {
      ctx.addLog && ctx.addLog('source-html-bind', 'no-op (phase 1 transition — no sourceHtmlPath provided)');
    }
    return Promise.resolve({
      sourceHtmlPath: ctx.sourceHtmlPath || null,
      sourceHtmlSha256: ctx.sourceHtmlSha256 || null,
      from: ctx._sourceHtmlBindFrom || null,
    });
  },

  // Exported for tests
  _internals: {
    resolveSourceHtmlPath: resolveSourceHtmlPath,
    sha256OfFile: sha256OfFile,
    isHardMode: isHardMode,
  }
};