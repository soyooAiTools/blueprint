/**
 * Stage: source-html-bind (Layer 3)
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
 *   Phase 2 (SOURCE_HTML_BIND_HARD=true, or storyboard2html/source-ir flow):
 *     missing path OR sha256 → HARD FAIL
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

var sourceSceneIr;
var sourceIrBlueprintContext;

function flagEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function hasToken(value, patterns) {
  var text = String(value || '').toLowerCase();
  if (!text) return false;
  for (var i = 0; i < patterns.length; i++) {
    if (text.indexOf(patterns[i]) >= 0) return true;
  }
  return false;
}

function isStoryboard2HtmlFlow(ctx) {
  ctx = ctx || {};
  var bp = ctx.blueprint || {};
  var task = ctx.task || {};
  var patterns = ['storyboard2html', 'storyboard-html', 'source-ir', 'source-scene-ir'];

  if (flagEnabled(bp.storyboard2html) || flagEnabled(task.storyboard2html)) return true;
  if (bp.schemaSource === 'source-scene-ir' || bp.prebuiltGameSchema === true || bp.prebuiltGameSchemaUsed === true) return true;
  if (hasToken(bp.sourcePipeline, patterns) || hasToken(bp.pipeline, patterns) || hasToken(bp.origin, patterns)) return true;
  if (hasToken(task.sourcePipeline, patterns) || hasToken(task.pipeline, patterns) || hasToken(task.origin, patterns)) return true;
  if (hasToken(task.kind, patterns) || hasToken(task.type, patterns) || hasToken(task.adapter, patterns)) return true;
  if (bp.storyboard && bp.storyboard.htmlPath && hasToken(bp.storyboard.sourcePipeline || bp.storyboard.origin, patterns)) return true;
  return false;
}

function isHardMode(ctx) {
  return flagEnabled(process.env.SOURCE_HTML_BIND_HARD) || isStoryboard2HtmlFlow(ctx);
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
  // Top-level task fields set by orchestrators that submit outside blueprint_json.
  // PipelineContext constructor backfills these into blueprint.sourceHtmlPath, so
  // this branch acts as defence-in-depth for bare/test contexts.
  if (ctx.task) {
    var taskPath = ctx.task.sourceHtmlPath || ctx.task.source_html_path || null;
    if (taskPath) {
      candidates.push({ from: 'task.sourceHtmlPath', value: taskPath });
    }
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

function sourceIrAutoPrebuildEnabled() {
  return !/^(0|false|off|disabled)$/i.test(String(process.env.BLUEPRINT_SOURCE_IR_AUTOPREBUILD || '1').trim());
}

function hasEmbeddedSourceIr(html) {
  return /(?:window|globalThis)\.__BP_SOURCE_IR__\s*=/.test(String(html || '')) ||
    /\b(?:const|let|var)\s+__BP_SOURCE_IR__\s*=/.test(String(html || ''));
}

function loadSourceIrDeps() {
  if (!sourceSceneIr) sourceSceneIr = require('../source-scene-ir.cjs');
  if (!sourceIrBlueprintContext) sourceIrBlueprintContext = require('../../adapters/source-ir/compile-blueprint-context.js');
  return {
    sourceSceneIr: sourceSceneIr,
    sourceIrBlueprintContext: sourceIrBlueprintContext,
  };
}

function shouldAutoPrebuildSourceIr(ctx) {
  if (!sourceIrAutoPrebuildEnabled()) return false;
  var bp = ctx && ctx.blueprint || {};
  if (!ctx || !ctx.sourceHtmlPath) return false;
  if (bp.prebuiltGameSchema === true && bp.gameSchema) return false;
  if (bp.skipSchemaGeneration === true && bp.gameSchema) return false;
  if (bp.schemaSource === 'source-scene-ir' && bp.gameSchema) return false;
  return true;
}

function autoPrebuildSourceIrGameSchema(ctx) {
  if (!shouldAutoPrebuildSourceIr(ctx)) return { applied: false, reason: 'disabled-or-not-needed' };
  var html = fs.readFileSync(ctx.sourceHtmlPath, 'utf8');
  if (!hasEmbeddedSourceIr(html)) return { applied: false, reason: 'no-embedded-source-ir' };

  var deps = loadSourceIrDeps();
  var ir = deps.sourceSceneIr.extractSourceSceneIrFromHtml(html, ctx.sourceHtmlPath, {
    project: ctx.blueprint && (ctx.blueprint.projectName || ctx.blueprint.name) || ctx.taskId || 'source-ir',
  });
  var built = deps.sourceIrBlueprintContext.buildSourceIrBlueprintContext(ir, {
    projectName: ctx.blueprint && (ctx.blueprint.projectName || ctx.blueprint.name) || ctx.taskId || 'source-ir',
    source: ctx.sourceHtmlPath,
    blueprintRoot: path.join(__dirname, '..', '..'),
  });

  var previous = ctx.blueprint || {};
  ctx.blueprint = Object.assign({}, previous, built.blueprint, {
    sourceHtmlPath: ctx.sourceHtmlPath,
    sourceHtmlSha256: ctx.sourceHtmlSha256,
    sourceIrAutoPrebuilt: true,
    sourceIrAutoPrebuiltAt: new Date().toISOString(),
    sourceIrAutoPrebuiltHash: ir.semanticHash,
    sourceIrAutoPrebuiltCarrier: ir.extraction && ir.extraction.carrier || 'window.__BP_SOURCE_IR__',
    schemaSource: 'source-scene-ir',
    semanticSource: 'source-scene-ir',
    prebuiltGameSchema: true,
    skipSchemaGeneration: true,
  });
  if (previous.feedbackHistory && !ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = previous.feedbackHistory;
  if (previous.metadata && !ctx.blueprint.metadata) ctx.blueprint.metadata = previous.metadata;
  return {
    applied: true,
    sourceSceneIrHash: ir.semanticHash,
    phaseCount: ir.phases.length,
    entityCount: ir.entities.length,
  };
}

module.exports = {
  name: 'source-html-bind',
  canRetry: false,

  assertBefore: function(ctx) {
    var hard = isHardMode(ctx);
    var hardReason = flagEnabled(process.env.SOURCE_HTML_BIND_HARD)
      ? 'SOURCE_HTML_BIND_HARD=true'
      : (isStoryboard2HtmlFlow(ctx) ? 'storyboard2html/source-ir flow' : null);
    var resolved = resolveSourceHtmlPath(ctx);
    if (!resolved) {
      var missMsg = 'source-html-bind: no sourceHtmlPath resolvable from blueprint/task/env. ' +
        'A task MUST declare its canonical source HTML (blueprint.sourceHtmlPath) so visual ' +
        'fidelity can be enforced shift-left.';
      if (hard) {
        throw new Error(missMsg + ' (HARD mode — ' + hardReason + '.)');
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
        throw new Error(hashMsg + ' (HARD mode — ' + hardReason + ' requires declared sha256.)');
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
      try {
        var prebuilt = autoPrebuildSourceIrGameSchema(ctx);
        if (prebuilt.applied) {
          ctx.addLog && ctx.addLog(
            'source-html-bind',
            'SourceIR auto-prebuilt gameSchema: phases=' + prebuilt.phaseCount +
            ' entities=' + prebuilt.entityCount +
            ' sourceSceneIrHash=' + prebuilt.sourceSceneIrHash
          );
        } else if (prebuilt.reason && prebuilt.reason !== 'disabled-or-not-needed') {
          ctx.addLog && ctx.addLog('source-html-bind', 'SourceIR auto-prebuild skipped: ' + prebuilt.reason);
        }
      } catch (err) {
        var message = 'SourceIR auto-prebuild failed: ' + (err && err.message || err);
        ctx.addLog && ctx.addLog('source-html-bind', message);
        if (!/^(1|true|yes|on)$/i.test(String(process.env.BLUEPRINT_SOURCE_IR_AUTOPREBUILD_SOFT || '').trim())) {
          throw new Error(message);
        }
      }
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
    isStoryboard2HtmlFlow: isStoryboard2HtmlFlow,
    isHardMode: isHardMode,
    hasEmbeddedSourceIr: hasEmbeddedSourceIr,
    autoPrebuildSourceIrGameSchema: autoPrebuildSourceIrGameSchema,
  }
};
