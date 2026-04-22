#!/usr/bin/env node
/**
 * Restricted patch-run executor.
 *
 * It does not mutate code yet. Instead it verifies whether known high-value
 * families are already covered in the current codebase and writes execution
 * status back to patch-run records.
 */

var fs = require('fs');
var path = require('path');
var archivePatchRun = require('./archive-patch-run.cjs');

var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var RUN_ROOT = path.join(LEARNING_ROOT, 'drafts', 'patch-runs');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function writeText(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { return ''; }
}

function loadRuns() {
  var index = readJson(path.join(RUN_ROOT, 'index.json'), { items: [] });
  return (index.items || []).map(function(item) {
    var file = path.join(LEARNING_ROOT, item.file || '');
    var body = readJson(file, null);
    if (!body) return null;
    return { file: file, body: body };
  }).filter(Boolean);
}

function verifyMethodCheckPartialVisibility() {
  var text = readText('/opt/blueprint-editor/engine/stages/method-check.cjs');
  var checks = [
    { name: 'reads-extra-files', pass: /ctx\.extraFiles/.test(text) },
    { name: 'aggregates-extra-files', pass: /aggregateCode \+= '\\n' \+ String\(extraFiles\[efName\]/.test(text) },
    { name: 'ignores-comment-ghosts', pass: /Ignore comments/.test(text) && /false-positive/.test(text) },
  ];
  return checks;
}

function verifyReviewNonConvergingStructural() {
  var staticCheck = readText('/opt/blueprint-editor/engine/static-check.cjs');
  var review = readText('/opt/blueprint-editor/engine/stages/review.cjs');
  var checks = [
    { name: 'review-early-stop', pass: /Review fingerprint repeated/.test(review) },
    { name: 'review-round-cap', pass: /MAX_REVIEW_ROUNDS = 4/.test(review) },
    { name: 'main-file-reintroduced-guard', pass: /main-file-reintroduced-phase-logic/.test(staticCheck) },
    { name: 'invalid-pool-find-name-guard', pass: /invalid-pool-find-name/.test(staticCheck) },
    { name: 'updategamestate-preserve-guard', pass: /updategamestate-skeleton-preserve/.test(staticCheck) },
  ];
  return checks;
}

function verifyCodegenMarkerCoverage() {
  var text = readText('/opt/blueprint-editor/engine/stages/codegen-schema.cjs');
  var checks = [
    { name: 'combined-marker-coverage', pass: /combinedMissingMarkers/.test(text) },
    { name: 'flow-companion-fill', pass: /GameFlowManagerMain\.Flow\.cs/.test(text) },
    { name: 'filters-phase-init-markers', pass: /TODO_PHASE_\\d\+_INIT/.test(text) || /TODO_PHASE_\\d\+_INIT/.test(String(text)) },
    { name: 'writes-flow-extra-file', pass: /ctx\.extraFiles\['GameFlowManagerMain\.Flow\.cs'\]/.test(text) },
  ];
  return checks;
}

function verifyRun(run) {
  var family = run.body.family || 'unknown';
  if (family === 'method_check.partial_visibility') return verifyMethodCheckPartialVisibility();
  if (family === 'review.nonconverging_structural') return verifyReviewNonConvergingStructural();
  if (family === 'codegen.marker_coverage') return verifyCodegenMarkerCoverage();
  return null;
}

function applyMethodCheckPartialVisibilityPatch() {
  var file = '/opt/blueprint-editor/engine/stages/method-check.cjs';
  var text = readText(file);
  var changed = false;

  if (text.indexOf('missing = checkCompleteness(ctx.csCode, ctx.extraFiles);') < 0 &&
      text.indexOf('missing = checkCompleteness(ctx.csCode);') >= 0) {
    text = text.replace(
      'missing = checkCompleteness(ctx.csCode);',
      'missing = checkCompleteness(ctx.csCode, ctx.extraFiles);'
    );
    changed = true;
  }

  if (text.indexOf("aggregateCode += '\\n' + String(extraFiles[efName] || '');") < 0 &&
      text.indexOf("var aggregateCode = csCode || '';") >= 0) {
    text = text.replace(
      "var aggregateCode = csCode || '';",
      "var aggregateCode = csCode || '';\n  if (extraFiles) {\n    for (var efName in extraFiles) {\n      if (!extraFiles.hasOwnProperty(efName)) continue;\n      aggregateCode += '\\n' + String(extraFiles[efName] || '');\n    }\n  }"
    );
    changed = true;
  }

  if (text.indexOf('Ignore comments so method names mentioned in guidance text do not become') < 0 &&
      text.indexOf('var m;') >= 0 &&
      text.indexOf("extractMethodCalls(csCode, scopeMethods)") >= 0) {
    text = text.replace(
      '    var m;',
      "    // Ignore comments so method names mentioned in guidance text do not become\n    // false-positive \"missing calls\" (e.g. Phase_<id>_OnTap() in comments).\n    body = body\n      .replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')\n      .replace(/\\/\\/[^\\n\\r]*/g, ' ');\n    var m;"
    );
    changed = true;
  }

  if (!changed) return [];
  writeText(file, text);
  return [file];
}

function applyReviewNonConvergingStructuralPatch() {
  var file = '/opt/blueprint-editor/engine/stages/review.cjs';
  var text = readText(file);
  var changed = false;

  if (/var MAX_REVIEW_ROUNDS = \d+;/.test(text) && text.indexOf('var MAX_REVIEW_ROUNDS = 4;') < 0) {
    text = text.replace(/var MAX_REVIEW_ROUNDS = \d+;/, 'var MAX_REVIEW_ROUNDS = 4;');
    changed = true;
  }
  if (/var REVIEW_REPEAT_BLOCK_AT = \d+;/.test(text) && text.indexOf('var REVIEW_REPEAT_BLOCK_AT = 3;') < 0) {
    text = text.replace(/var REVIEW_REPEAT_BLOCK_AT = \d+;/, 'var REVIEW_REPEAT_BLOCK_AT = 3;');
    changed = true;
  }

  if (!changed) return [];
  writeText(file, text);
  return [file];
}

function tryAutoPatch(run) {
  var family = run.body.family || 'unknown';
  if (family === 'method_check.partial_visibility') return applyMethodCheckPartialVisibilityPatch();
  if (family === 'review.nonconverging_structural') return applyReviewNonConvergingStructuralPatch();
  return null;
}

function executePatchRuns() {
  var runs = loadRuns();
  var updated = 0;
  var results = [];

  runs.forEach(function(run) {
    var body = run.body;
    if (!body.executionReady) {
      body.lastExecution = {
        executedAt: new Date().toISOString(),
        result: 'skipped',
        reason: body.blockingReason || 'Execution not ready'
      };
      writeJson(run.file, body);
      archivePatchRun.archivePatchRun(body);
      results.push({ family: body.family, result: 'skipped' });
      updated += 1;
      return;
    }

    var checks = verifyRun(run);
    if (!checks) {
      body.status = 'verification-missing';
      body.lastExecution = {
        executedAt: new Date().toISOString(),
        result: 'verification-missing',
        checks: []
      };
      writeJson(run.file, body);
      archivePatchRun.archivePatchRun(body);
      results.push({ family: body.family, result: 'verification-missing' });
      updated += 1;
      return;
    }

    var passCount = checks.filter(function(c) { return c.pass; }).length;
    var ok = passCount === checks.length;
    if (ok) {
      body.status = 'verified-covered';
      body.lastExecution = {
        executedAt: new Date().toISOString(),
        result: body.status,
        checks: checks,
        passCount: passCount,
        totalChecks: checks.length
      };
      writeJson(run.file, body);
      archivePatchRun.archivePatchRun(body);
      results.push({ family: body.family, result: body.status });
      updated += 1;
      return;
    }

    var patchedFiles = tryAutoPatch(run);
    if (patchedFiles && patchedFiles.length > 0) {
      var rechecks = verifyRun(run) || [];
      var rePassCount = rechecks.filter(function(c) { return c.pass; }).length;
      var reOk = rePassCount === rechecks.length;
      body.status = reOk ? 'patched-and-verified' : 'patch-applied-needs-review';
      body.lastExecution = {
        executedAt: new Date().toISOString(),
        result: body.status,
        checks: rechecks,
        passCount: rePassCount,
        totalChecks: rechecks.length,
        patchedFiles: patchedFiles
      };
      writeJson(run.file, body);
      archivePatchRun.archivePatchRun(body);
      results.push({ family: body.family, result: body.status, patchedFiles: patchedFiles });
      updated += 1;
      return;
    }

    body.status = 'needs-patch';
    body.lastExecution = {
      executedAt: new Date().toISOString(),
      result: body.status,
      checks: checks,
      passCount: passCount,
      totalChecks: checks.length
    };
    writeJson(run.file, body);
    archivePatchRun.archivePatchRun(body);
    results.push({ family: body.family, result: body.status });
    updated += 1;
  });

  var indexFile = path.join(RUN_ROOT, 'index.json');
  var index = readJson(indexFile, { items: [] });
  index.updatedAt = new Date().toISOString();
  index.items = (index.items || []).map(function(item) {
    var file = path.join(LEARNING_ROOT, item.file || '');
    var body = readJson(file, null);
    return Object.assign({}, item, body ? {
      status: body.status,
      executionMode: body.executionMode,
      executionReady: body.executionReady
    } : {});
  });
  writeJson(indexFile, index);

  console.log(JSON.stringify({
    executedAt: new Date().toISOString(),
    updated: updated,
    results: results
  }, null, 2));
}

if (require.main === module) executePatchRuns();

module.exports = {
  executePatchRuns: executePatchRuns
};
