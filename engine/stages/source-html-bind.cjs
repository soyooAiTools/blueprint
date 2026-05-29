/**
 * Stage: source-html-bind (Layer 3)
 * v2 — incorporates Jonny review (msg a892d842):
 *   - canonical = blueprint.sourceHtmlPath + blueprint.sourceHtmlSha256
 *   - drop task.source_html_path (no DB column today)
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
 *   4. process.env.SOURCE_HTML_PATH          (worker-level override)
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
  if (ctx.blueprint && ctx.blueprint.sourceHtmlPath) {
    candidates.push({ from: 'blueprint.sourceHtmlPath', value: ctx.blueprint.sourceHtmlPath });
  }
  if (ctx.blueprint && ctx.blueprint.storyboard && ctx.blueprint.storyboard.htmlPath) {
    candidates.push({ from: 'blueprint.storyboard.htmlPath', value: ctx.blueprint.storyboard.htmlPath });
  }
  if (ctx.blueprint && ctx.blueprint.visualAssets && ctx.blueprint.visualAssets.source) {
    candidates.push({ from: 'blueprint.visualAssets.source', value: ctx.blueprint.visualAssets.source });
  }
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
      var missMsg = 'source-html-bind: no sourceHtmlPath resolvable from blueprint/env. ' +
        'A task MUST declare its canonical source HTML (blueprint.sourceHtmlPath) so visual ' +
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
