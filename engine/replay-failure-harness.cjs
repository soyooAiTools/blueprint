#!/usr/bin/env node
/**
 * Offline replay harness for failed/generated workdirs.
 *
 * Fast path for validating static-check / method-check / spec-conformance
 * against a historical reviewfix workspace without re-submitting the project.
 */

var fs = require('fs');
var path = require('path');
var { staticCheck } = require('./static-check.cjs');
var methodCheckStage = require('./stages/method-check.cjs');
var reviewStage = require('./stages/review.cjs');
var { checkConformance } = require('./spec-conformance.cjs');

function parseArgs(argv) {
  var out = { projectId: '', workdir: '', json: false, applyRepairs: false };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--project' && argv[i + 1]) out.projectId = argv[++i];
    else if (arg === '--workdir' && argv[i + 1]) out.workdir = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (arg === '--apply-repairs') out.applyRepairs = true;
  }
  return out;
}

function die(msg) {
  console.error('[replay] ' + msg);
  process.exit(1);
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function checkpointFileFor(projectId) {
  return path.join('/opt/blueprint-editor/server-data/checkpoints', projectId, 'checkpoint.json');
}

function hasCheckpoint(projectId) {
  return !!(projectId && fs.existsSync(checkpointFileFor(projectId)));
}

function findLatestReviewfixWorkdir(projectId) {
  var pipelineFile = path.join('/opt/blueprint-editor/server-data/task-logs', projectId, 'pipeline.jsonl');
  if (!fs.existsSync(pipelineFile)) return '';
  var lines = fs.readFileSync(pipelineFile, 'utf8').split(/\r?\n/);
  var candidates = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    try {
      var row = JSON.parse(line);
      var msg = String(row.message || '');
      var marker = 'Work dir prepared: ';
      var idx = msg.indexOf(marker);
      if (idx >= 0) candidates.push(msg.slice(idx + marker.length).trim());
    } catch (_e) {}
  }
  for (var ci = candidates.length - 1; ci >= 0; ci--) {
    if (fs.existsSync(candidates[ci])) return candidates[ci];
  }
  return '';
}

function fallbackTaskWorkdir(projectId) {
  var fp = '/tmp/linux-task-' + projectId;
  return fs.existsSync(fp) ? fp : '';
}

function loadManagerSources(workdir, projectId) {
  var managerDir = workdir
    ? path.join(workdir, 'Assets/Program/Script/Manager')
    : path.join('/opt/blueprint-editor/server-data/checkpoints', projectId || 'checkpoint-only', 'Manager');
  var files = workdir && fs.existsSync(managerDir) ? fs.readdirSync(managerDir).filter(function(name) {
    return /^GameFlowManagerMain.*\.cs$/.test(name);
  }).sort() : [];

  var mainName = 'GameFlowManagerMain.cs';
  var mainPath = path.join(managerDir, mainName);
  var mainCode = fs.existsSync(mainPath) ? fs.readFileSync(mainPath, 'utf8') : '';

  var extraFiles = {};
  for (var i = 0; i < files.length; i++) {
    var name = files[i];
    if (name === mainName) continue;
    extraFiles[name] = fs.readFileSync(path.join(managerDir, name), 'utf8');
  }

  if (projectId) {
    var checkpointFile = checkpointFileFor(projectId);
    if (fs.existsSync(checkpointFile)) {
      var checkpoint = readJson(checkpointFile);
      if (!mainCode && checkpoint.csCode) mainCode = String(checkpoint.csCode || '');
      var cpExtra = checkpoint.extraFiles || {};
      Object.keys(cpExtra).forEach(function(name) {
        if (!/^GameFlowManagerMain.*\.cs$/.test(name)) return;
        if (!extraFiles[name]) extraFiles[name] = String(cpExtra[name] || '');
      });
    }
  }

  if (!mainCode) die('Main C# file missing in workdir/checkpoint for ' + (projectId || workdir));

  return {
    managerDir: managerDir,
    mainName: mainName,
    mainCode: mainCode,
    extraFiles: extraFiles,
    aggregateCode: mainCode + '\n' + Object.keys(extraFiles).map(function(name) { return extraFiles[name]; }).join('\n'),
  };
}

function summarizeIssues(issues) {
  var counts = {};
  for (var i = 0; i < issues.length; i++) {
    var rule = issues[i].rule || 'unknown';
    counts[rule] = (counts[rule] || 0) + 1;
  }
  return Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; }).map(function(rule) {
    return { rule: rule, count: counts[rule] };
  });
}

function buildAggregateCode(mainCode, extraFiles) {
  return String(mainCode || '') + '\n' + Object.keys(extraFiles || {}).map(function(name) {
    return String(extraFiles[name] || '');
  }).join('\n');
}

function applyDeterministicRepairs(mainCode, extraFiles, blueprint) {
  var ctx = {
    csCode: String(mainCode || ''),
    extraFiles: Object.assign({}, extraFiles || {}),
    blueprint: blueprint || {},
  };
  var repairsApplied = [];

  function pushRepair(label, changed) {
    if (changed) repairsApplied.push(label);
  }

  pushRepair('method-check:forbidden-generic-api', methodCheckStage.autoRepairForbiddenGenericApis(ctx));
  pushRepair('method-check:duplicate-state-fields', methodCheckStage.autoRepairDuplicateStateFields(ctx));
  pushRepair('method-check:player-alias-drift', methodCheckStage.autoRepairPlayerAliasDrift(ctx));
  pushRepair('method-check:invalid-pool-literals', methodCheckStage.autoRepairInvalidPoolLiterals(ctx));
  pushRepair('method-check:partial-class-mismatch', methodCheckStage.autoRepairPartialClassMismatch(ctx));

  var phaseRepair = methodCheckStage.autoRepairPhaseGateViolations(ctx, 2);
  if (phaseRepair && phaseRepair.changed) {
    repairsApplied.push('method-check:phase-gate-violations');
  }

  var missing = methodCheckStage.checkCompleteness(ctx.csCode, ctx.extraFiles);
  if (methodCheckStage.injectMissingHelpers(ctx, missing)) {
    repairsApplied.push('method-check:inject-missing-helpers');
  }

  var reviewRepair = reviewStage.repairKnownStructuralDamage(ctx.csCode, ctx.extraFiles, blueprint || {});
  if (reviewRepair && reviewRepair.changed) {
    ctx.csCode = reviewRepair.code;
    ctx.extraFiles = reviewRepair.extraFiles;
    for (var i = 0; i < reviewRepair.fixes.length; i++) {
      repairsApplied.push('review:' + reviewRepair.fixes[i]);
    }
  }

  return {
    mainCode: ctx.csCode,
    extraFiles: ctx.extraFiles,
    aggregateCode: buildAggregateCode(ctx.csCode, ctx.extraFiles),
    repairsApplied: repairsApplied,
  };
}

function main() {
  var args = parseArgs(process.argv);
  if (!args.projectId && !args.workdir) {
    die('usage: node engine/replay-failure-harness.cjs --project <projectId> | --workdir <path> [--json] [--apply-repairs]');
  }

  var workdir = args.workdir;
  var projectId = args.projectId;
  if (!workdir && projectId) {
    workdir = findLatestReviewfixWorkdir(projectId);
    if (!workdir) workdir = fallbackTaskWorkdir(projectId);
    if (!workdir && !hasCheckpoint(projectId)) {
      die('No reviewfix workdir or checkpoint found for ' + projectId);
    }
  }
  if (!projectId && workdir) {
    var m = workdir.match(/proj_[^-/]+_[^-/]+_[^-/]+/);
    if (m) projectId = m[0];
  }
  if (workdir && !fs.existsSync(workdir)) die('workdir not found: ' + workdir);

  var project = null;
  if (projectId) {
    var projectFile = path.join('/opt/blueprint-editor/server-data/projects', projectId + '.json');
    if (fs.existsSync(projectFile)) project = readJson(projectFile);
  }

  var src = loadManagerSources(workdir, projectId);
  var effective = {
    mainCode: src.mainCode,
    extraFiles: src.extraFiles,
    aggregateCode: src.aggregateCode,
    repairsApplied: [],
  };
  if (args.applyRepairs) {
    effective = applyDeterministicRepairs(src.mainCode, src.extraFiles, project || {});
  }

  var files = [{ name: src.mainName, code: effective.mainCode }];
  Object.keys(effective.extraFiles).forEach(function(name) {
    files.push({ name: name, code: effective.extraFiles[name] });
  });

  var staticIssues = [];
  for (var i = 0; i < files.length; i++) {
    var fileExtra = {};
    Object.keys(effective.extraFiles).forEach(function(name) {
      if (name !== files[i].name) fileExtra[name] = effective.extraFiles[name];
    });
    var res = staticCheck(files[i].code, {
      filename: path.join(src.managerDir, files[i].name),
      blueprint: project || {},
      extraFiles: fileExtra,
    });
    for (var j = 0; j < res.issues.length; j++) {
      var issue = res.issues[j];
      issue.file = files[i].name;
      staticIssues.push(issue);
    }
  }
  var blocking = staticIssues.filter(function(i) { return !!i.blocking; });
  var warnings = staticIssues.filter(function(i) { return !i.blocking; });
  var missingMethods = methodCheckStage.checkCompleteness(effective.mainCode, effective.extraFiles);
  var conformance = checkConformance(effective.aggregateCode, project || {});

  var output = {
    projectId: projectId || null,
    workdir: workdir || null,
    applyRepairs: !!args.applyRepairs,
    deterministicRepairs: {
      appliedCount: effective.repairsApplied.length,
      applied: effective.repairsApplied,
    },
    files: files.map(function(f) { return f.name; }),
    staticCheck: {
      blockingCount: blocking.length,
      warningCount: warnings.length,
      topBlockingRules: summarizeIssues(blocking).slice(0, 10),
      topWarningRules: summarizeIssues(warnings).slice(0, 10),
      sampleBlocking: blocking.slice(0, 10),
    },
    methodCheck: {
      missingCount: missingMethods.length,
      missing: missingMethods,
    },
    specConformance: {
      passed: conformance.passed,
      criticalCount: conformance.criticalCount,
      warningCount: conformance.warningCount,
      sampleIssues: conformance.issues.slice(0, 10),
    },
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('[replay] project=' + (output.projectId || '-') + ' workdir=' + output.workdir);
  console.log('[replay] files=' + output.files.join(', '));
  if (output.applyRepairs) {
    console.log('[replay] deterministic repairs=' + output.deterministicRepairs.appliedCount + (output.deterministicRepairs.applied.length ? ' :: ' + output.deterministicRepairs.applied.join(', ') : ''));
  }
  console.log('[replay] static blocking=' + output.staticCheck.blockingCount + ' warnings=' + output.staticCheck.warningCount);
  output.staticCheck.topBlockingRules.forEach(function(item) {
    console.log('  [blocking] ' + item.rule + ' x' + item.count);
  });
  output.staticCheck.topWarningRules.forEach(function(item) {
    console.log('  [warning] ' + item.rule + ' x' + item.count);
  });
  console.log('[replay] method missing=' + output.methodCheck.missingCount + (output.methodCheck.missing.length ? ' :: ' + output.methodCheck.missing.join(', ') : ''));
  console.log('[replay] conformance passed=' + output.specConformance.passed + ' critical=' + output.specConformance.criticalCount + ' warnings=' + output.specConformance.warningCount);
}

main();
