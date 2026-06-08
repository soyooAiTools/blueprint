#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var {
  detectSourceIrPreviewRenderer,
  loadSourceSceneIr,
  preflightSourceSceneIrHtml,
} = require('../engine/source-scene-ir.cjs');
var {
  buildSourceIrArtifacts,
} = require('../adapters/source-ir/index.js');

function usage() {
  console.error([
    'Usage: node scripts/source-ir-build.cjs <source-ir.json|source-ir-renderer.html> <outdir>',
    '  [--project name] [--blueprint-smoke] [--verify] [--verify-runner direct|production]',
    '  [--steps N] [--visual-diff] [--visual-phases phase8|6-8|phase6,phase8]',
    '  [--allow-non-renderer-html] [--write-blueprint-artifacts] [--skip-source-liveness]',
    '  [--debug-fast] [--runtime-binding-smoke]',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    input: null,
    outDir: null,
    projectName: null,
    blueprintSmoke: false,
    verify: false,
    verifyRunner: null,
    steps: 30,
    visualDiff: false,
    visualPhases: null,
    allowNonRendererHtml: false,
    writeBlueprintArtifacts: false,
    skipSourceLiveness: false,
    debugFast: false,
    runtimeBindingSmoke: false,
  };
  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--project') {
      opts.projectName = argv[++i] || opts.projectName;
    } else if (arg === '--blueprint-smoke') {
      opts.blueprintSmoke = true;
    } else if (arg === '--verify') {
      opts.verify = true;
      opts.blueprintSmoke = true;
    } else if (arg === '--verify-runner') {
      opts.verifyRunner = argv[++i] || null;
      opts.verify = true;
      opts.blueprintSmoke = true;
    } else if (arg === '--steps') {
      opts.steps = Number(argv[++i] || 0) || opts.steps;
    } else if (arg === '--visual-diff') {
      opts.visualDiff = true;
      opts.blueprintSmoke = true;
    } else if (arg === '--visual-phases' || arg === '--visual-diff-phases') {
      opts.visualPhases = argv[++i] || null;
      if (!opts.visualPhases || /^--/.test(opts.visualPhases)) usage();
      opts.visualDiff = true;
      opts.blueprintSmoke = true;
    } else if (arg === '--allow-non-renderer-html') {
      opts.allowNonRendererHtml = true;
    } else if (arg === '--write-blueprint-artifacts') {
      opts.writeBlueprintArtifacts = true;
    } else if (arg === '--skip-source-liveness') {
      opts.skipSourceLiveness = true;
    } else if (arg === '--debug-fast') {
      opts.debugFast = true;
      opts.blueprintSmoke = true;
      opts.runtimeBindingSmoke = true;
    } else if (arg === '--runtime-binding-smoke') {
      opts.runtimeBindingSmoke = true;
      opts.blueprintSmoke = true;
    } else if (!opts.input) {
      opts.input = arg;
    } else if (!opts.outDir) {
      opts.outDir = arg;
    } else {
      usage();
    }
  }
  if (!opts.input || !opts.outDir) usage();
  return opts;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch(e) {
    return null;
  }
}

function createTiming(inputPath, outDir, opts) {
  return {
    schemaVersion: '1.0.0',
    kind: 'blueprint.sourceIrBuild.pipelineTiming',
    input: inputPath,
    outDir: outDir,
    mode: opts && opts.debugFast ? 'debug-fast' : 'standard',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    finishedAt: null,
    totalMs: null,
    status: 'running',
    stages: [],
  };
}

function runTimed(timing, id, fn) {
  var stage = {
    id: id,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    finishedAt: null,
    durationMs: null,
    status: 'running',
  };
  timing.stages.push(stage);
  try {
    var value = fn();
    stage.status = 'passed';
    return value;
  } catch (error) {
    stage.status = 'failed';
    stage.error = error && error.message || String(error);
    throw error;
  } finally {
    stage.finishedAt = new Date().toISOString();
    stage.durationMs = Date.now() - stage.startedAtMs;
  }
}

function finishTiming(timing, outDir, status, extra) {
  if (!timing) return null;
  timing.finishedAt = new Date().toISOString();
  timing.totalMs = Date.now() - timing.startedAtMs;
  timing.status = status || timing.status || 'unknown';
  if (extra) timing.extra = extra;
  var filePath = path.join(outDir, 'pipeline-timing.json');
  writeJson(filePath, timing);
  return filePath;
}

function inputKind(inputPath) {
  return /\.json$/i.test(inputPath) ? 'source-ir-json' : 'source-ir-html';
}

function hasEmbeddedSourceIr(html) {
  return /(?:window|globalThis)\.__BP_SOURCE_IR__\s*=/.test(String(html || '')) ||
    /\b(?:const|let|var)\s+__BP_SOURCE_IR__\s*=/.test(String(html || ''));
}

function firstViolationCodes(report) {
  return (report && report.violations || []).slice(0, 8).map(function(violation) {
    return violation.code || violation.message || JSON.stringify(violation);
  });
}

function preflightInput(inputPath, outDir, opts) {
  var kind = inputKind(inputPath);
  if (kind === 'source-ir-json') {
    var sourceIr = loadSourceSceneIr(inputPath);
    var report = {
      schemaVersion: '1.0.0',
      kind: 'blueprint.sourceIrBuild.preflightReport',
      inputKind: kind,
      inputPath: inputPath,
      passed: true,
      summary: {
        sourceSceneIrHash: sourceIr.semanticHash,
        phaseCount: (sourceIr.phases || []).length,
        entityCount: (sourceIr.entities || []).length,
        sourceIrRenderer: null,
      },
      warnings: [],
      violations: [],
    };
    writeJson(path.join(outDir, 'source-ir-report.json'), report);
    return report;
  }

  var html = fs.readFileSync(inputPath, 'utf8');
  if (!hasEmbeddedSourceIr(html)) {
    var missingReport = {
      schemaVersion: '1.0.0',
      kind: 'blueprint.sourceSceneIR.preflightReport',
      inputKind: kind,
      sourceHtmlPath: inputPath,
      passed: false,
      summary: {
        embeddedSourceIrPresent: false,
        legacyProjectionUsed: false,
        sourceSceneIrHash: null,
        sourceIrRenderer: detectSourceIrPreviewRenderer(html),
      },
      warnings: [],
      violations: [{
        code: 'source_ir_embedded_missing',
        message: 'window.__BP_SOURCE_IR__ is missing; SourceIR-only build does not run legacy JS inference',
      }],
    };
    writeJson(path.join(outDir, 'source-ir-report.json'), missingReport);
    return missingReport;
  }
  var report = preflightSourceSceneIrHtml(html, {
    sourceHtmlPath: inputPath,
    requireSourceIrRenderer: opts.allowNonRendererHtml !== true,
  });
  if (!report.summary) report.summary = {};
  report.inputKind = kind;
  report.summary.sourceIrRenderer = report.summary.sourceIrRenderer || detectSourceIrPreviewRenderer(html);
  writeJson(path.join(outDir, 'source-ir-report.json'), report);
  return report;
}

function writeSemanticSource(outDir, value) {
  writeJson(path.join(outDir, 'semantic-source.json'), Object.assign({
    semanticSource: 'source-scene-ir',
    legacyJsInferenceUsed: false,
  }, value || {}));
}

function assertIrOnlyArtifacts(outDir) {
  var specPath = path.join(outDir, 'spec.json');
  var spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (!spec.meta || spec.meta.semanticSource !== 'source-scene-ir') {
    throw new Error('IR-only build artifact violation: spec.meta.semanticSource must be source-scene-ir');
  }
  if (spec.meta.legacyJsInferenceUsed !== false) {
    throw new Error('IR-only build artifact violation: spec.meta.legacyJsInferenceUsed must be false');
  }
  if (!spec.meta.sourceVisualIrPath || !spec.meta.sourceVisualIrHash) {
    throw new Error('IR-only build artifact violation: spec.meta.sourceVisualIrPath/hash must be present');
  }
  var semanticSource = JSON.parse(fs.readFileSync(path.join(outDir, 'semantic-source.json'), 'utf8'));
  if (semanticSource.semanticSource !== 'source-scene-ir') {
    throw new Error('IR-only build artifact violation: semantic-source semanticSource must be source-scene-ir');
  }
  if (semanticSource.legacyJsInferenceUsed !== false) {
    throw new Error('IR-only build artifact violation: semantic-source legacyJsInferenceUsed must be false');
  }
}

function runSourcePhaseLiveness(inputPath, outDir, opts) {
  var reportPath = path.join(outDir, 'source-phase-liveness-report.json');
  if (opts.skipSourceLiveness) {
    writeJson(reportPath, {
      schemaVersion: '1.0.0',
      kind: 'blueprint.sourceSceneIR.phaseLivenessReport',
      inputPath: inputPath,
      passed: false,
      skipped: true,
      summary: {
        staticPassed: false,
        browserProbePassed: false,
        browserProbeSkipped: true,
      },
      violations: [{
        code: 'source_ir_phase_liveness_skipped',
        message: 'source phase liveness was explicitly skipped',
      }],
    });
    return reportPath;
  }
  var args = [inputPath, reportPath];
  if (inputKind(inputPath) === 'source-ir-json') args.push('--static-only');
  runNodeQuiet(path.join(__dirname, 'source-ir-phase-liveness.cjs'), args, path.join(__dirname, '..'));
  return reportPath;
}

function runNodeQuiet(script, args, cwd) {
  var result = spawnSync(process.execPath, [script].concat(args || []), {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
    env: Object.assign({}, process.env),
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(path.basename(script) + ' failed with exit ' + result.status);
  }
}

function runNode(script, args, cwd) {
  var result = spawnSync(process.execPath, [script].concat(args || []), {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    stdio: 'inherit',
    env: Object.assign({}, process.env),
  });
  if (result.status !== 0) {
    throw new Error(path.basename(script) + ' failed with exit ' + result.status);
  }
}

function resolveSourceHtmlForVisualDiff(inputPath, outDir) {
  if (inputKind(inputPath) === 'source-ir-html') return inputPath;
  var sourceIr = JSON.parse(fs.readFileSync(path.join(outDir, 'source-ir.json'), 'utf8'));
  var htmlPath = sourceIr.source && sourceIr.source.htmlPath || null;
  if (!htmlPath || !fs.existsSync(htmlPath)) {
    throw new Error('visual diff requires source HTML input or source-ir.source.htmlPath pointing to an existing HTML file');
  }
  return htmlPath;
}

function runSmokeAndVisual(inputPath, outDir, opts) {
  if (!opts.blueprintSmoke) return {};
  var smokeOut = path.join(outDir, 'blueprint-smoke');
  var smokeArgs = [outDir, smokeOut];
  if (opts.verify) smokeArgs.push('--verify', '--steps', String(opts.steps));
  if (opts.verifyRunner) smokeArgs.push('--verify-runner', opts.verifyRunner);
  runNode(path.join(__dirname, '..', 'adapters', 'source-ir', 'run-blueprint-smoke.js'), smokeArgs, path.join(__dirname, '..'));

  var visualReport = null;
  if (opts.visualDiff) {
    var sourceHtmlPath = resolveSourceHtmlForVisualDiff(inputPath, outDir);
    var visualDiffArgs = [
      '--source', sourceHtmlPath,
      '--webgl', smokeOut,
      '--out', path.join(outDir, 'storyboard-webgl-visual-diff'),
    ];
    if (opts.visualPhases) visualDiffArgs.push('--phases', opts.visualPhases);
    runNode(path.join(__dirname, 'storyboard-webgl-visual-diff.cjs'), visualDiffArgs, path.join(__dirname, '..'));
    visualReport = path.join(outDir, 'storyboard-webgl-visual-diff', 'report.json');
  }
  return {
    blueprintSmoke: smokeOut,
    verifySummary: opts.verify ? path.join(smokeOut, 'unity-verify-summary.json') : null,
    storyboardWebglVisualDiff: visualReport,
  };
}

function runRuntimeBindingSmoke(outDir, runtime, opts) {
  if (!opts.runtimeBindingSmoke) return null;
  var smokeOut = runtime && runtime.blueprintSmoke || path.join(outDir, 'blueprint-smoke');
  var reportPath = path.join(outDir, 'runtime-binding-smoke-report.json');
  runNode(path.join(__dirname, 'runtime-binding-smoke.cjs'), [
    smokeOut,
    '--out',
    reportPath,
    '--settle-ms',
    '5000',
  ], path.join(__dirname, '..'));
  return reportPath;
}

function phaseFromItems(items) {
  var list = Array.isArray(items) ? items : [];
  for (var i = 0; i < list.length; i += 1) {
    var item = list[i] || {};
    var phase = item.phaseId || item.phase || item.requestedPhase || item.id || '';
    if (/^phase\d+$/i.test(String(phase))) return String(phase);
  }
  return '';
}

function phaseFromText(value) {
  var match = String(value || '').match(/\bphase\d+\b/i);
  return match ? match[0] : '';
}

function phaseFromVisualDiff(report) {
  var phases = Array.isArray(report && report.phases) ? report.phases : [];
  for (var i = 0; i < phases.length; i += 1) {
    if (phases[i] && phases[i].passed === false && /^phase\d+$/i.test(String(phases[i].phase || ''))) {
      return String(phases[i].phase);
    }
  }
  return phaseFromItems(phases);
}

function phaseFromVerifyReport(report) {
  if (!report) return '';
  if (Array.isArray(report.missingPhases) && report.missingPhases.length > 0) {
    return phaseFromText(report.missingPhases[0]) || String(report.missingPhases[0]);
  }
  var manualFlow = report.manualJoystickFlowProbe ||
    report.runtimeContractSummary && report.runtimeContractSummary.manualJoystickFlowProbe ||
    report.diagnostics && report.diagnostics.manualJoystickFlowProbe ||
    null;
  if (manualFlow && Array.isArray(manualFlow.missingPhasePath) && manualFlow.missingPhasePath.length > 0) {
    return phaseFromText(manualFlow.missingPhasePath[0]) || String(manualFlow.missingPhasePath[0]);
  }
  var signals = Array.isArray(report.missingSignals) ? report.missingSignals : [];
  for (var i = 0; i < signals.length; i += 1) {
    var phase = phaseFromText(signals[i]);
    if (phase) return phase;
  }
  var issues = Array.isArray(report.issues) ? report.issues : [];
  for (var j = 0; j < issues.length; j += 1) {
    var issuePhase = phaseFromText(issues[j]);
    if (issuePhase) return issuePhase;
  }
  return '';
}

function firstAffectedPhaseFromReports(outDir, runtime) {
  var liveness = readJsonIfExists(path.join(outDir, 'source-phase-liveness-report.json'));
  var livenessPhase = phaseFromItems(liveness && liveness.violations);
  if (livenessPhase) return livenessPhase;
  var smokeOut = runtime && runtime.blueprintSmoke || path.join(outDir, 'blueprint-smoke');
  var proofDiff = readJsonIfExists(path.join(smokeOut, 'blueprint-proof-diff.json'));
  var proofPhase = phaseFromItems(proofDiff && proofDiff.blocking);
  if (proofPhase) return proofPhase;
  var visualDiff = readJsonIfExists(path.join(outDir, 'storyboard-webgl-visual-diff', 'report.json'));
  var visualPhase = phaseFromVisualDiff(visualDiff);
  if (visualPhase) return visualPhase;
  var verifyReport = readJsonIfExists(path.join(smokeOut, 'unity-verify-report.json'));
  var verifyPhase = phaseFromVerifyReport(verifyReport);
  if (verifyPhase) return verifyPhase;
  var verifySummary = readJsonIfExists(path.join(smokeOut, 'unity-verify-summary.json'));
  var summaryPhase = phaseFromVerifyReport(verifySummary);
  if (summaryPhase) return summaryPhase;
  var runtimeBinding = readJsonIfExists(path.join(outDir, 'runtime-binding-smoke-report.json'));
  var runtimePhase = phaseFromItems(runtimeBinding && runtimeBinding.violations);
  if (runtimePhase) return runtimePhase;
  return '';
}

function gateStatusFromReport(report, passKey) {
  if (!report) return 'not_run';
  return report[passKey || 'passed'] === true || report.ok === true ? 'passed' : 'failed';
}

function buildDebugPlan(inputPath, outDir, opts, runtime, timing, failure) {
  var smokeOut = runtime && runtime.blueprintSmoke || path.join(outDir, 'blueprint-smoke');
  var preflight = readJsonIfExists(path.join(outDir, 'source-ir-report.json'));
  var liveness = readJsonIfExists(path.join(outDir, 'source-phase-liveness-report.json'));
  var proofDiff = readJsonIfExists(path.join(smokeOut, 'blueprint-proof-diff.json'));
  var binding = readJsonIfExists(path.join(outDir, 'runtime-binding-smoke-report.json'));
  var affectedPhase = firstAffectedPhaseFromReports(outDir, runtime) || (opts.visualPhases ? String(opts.visualPhases).split(',')[0] : '');
  var commands = [];
  commands.push({
    id: 'source-ir:debug-fast',
    gate: 'iteration',
    ready: true,
    command: ['node', 'scripts/source-ir-build.cjs', inputPath, outDir, '--debug-fast'],
    purpose: 'Run SourceIR preflight, liveness, WebGL build, proof diff, and runtime binding smoke without production CUA.',
  });
  if (fs.existsSync(smokeOut)) {
    commands.push({
      id: 'runtime:binding-smoke',
      gate: 'iteration',
      ready: true,
      command: ['node', 'scripts/runtime-binding-smoke.cjs', smokeOut, '--out', path.join(outDir, 'runtime-binding-smoke-report.json')],
      purpose: 'Load the WebGL build briefly and fail on missing Player/runtime entity bindings.',
    });
  }
  commands.push({
    id: 'checkpoint-cua:affected-phase',
    gate: 'iteration',
    ready: !!(fs.existsSync(smokeOut) && affectedPhase),
    command: ['node', 'scripts/cua-checkpoint-probe.cjs', fs.existsSync(smokeOut) ? smokeOut : '<webgl-build-dir>', '--phase', affectedPhase || '<phaseId>', '--max-phases', '1'],
    purpose: 'Run debug-only joystick checkpoint for the affected phase before any full CUA rerun.',
    missingInputs: fs.existsSync(smokeOut) && affectedPhase ? undefined : ['webglBuildDir', 'affectedPhase'].filter(function(name) {
      return name === 'webglBuildDir' ? !fs.existsSync(smokeOut) : !affectedPhase;
    }),
  });
  commands.push({
    id: 'final:strict-cua-one-project',
    gate: 'final',
    ready: fs.existsSync(smokeOut),
    command: ['node', 'scripts/strict-cua-runner.cjs', fs.existsSync(smokeOut) ? smokeOut : '<webgl-build-dir>'],
    purpose: 'Final hardgate only after debug-fast and affected checkpoint gates are green.',
    missingInputs: fs.existsSync(smokeOut) ? undefined : ['webglBuildDir'],
  });
  var plan = {
    schemaVersion: '1.0.0',
    kind: 'blueprint.sourceIrBuild.debugPlan',
    generatedAt: new Date().toISOString(),
    input: inputPath,
    outDir: outDir,
    mode: opts.debugFast ? 'debug-fast' : 'standard',
    status: failure ? 'failed' : 'planned',
    failure: failure ? {
      message: failure.message || String(failure),
      name: failure.name || 'Error',
    } : null,
    affectedPhase: affectedPhase || null,
    gates: [
      {
        id: 'source-ir-preflight',
        status: gateStatusFromReport(preflight, 'passed'),
        report: path.join(outDir, 'source-ir-report.json'),
      },
      {
        id: 'source-phase-liveness',
        status: gateStatusFromReport(liveness, 'passed'),
        report: path.join(outDir, 'source-phase-liveness-report.json'),
      },
      {
        id: 'blueprint-proof-contract',
        status: proofDiff ? (proofDiff.passed === true ? 'passed' : 'failed') : 'not_run',
        blocking: proofDiff && proofDiff.summary && proofDiff.summary.blocking || 0,
        report: path.join(smokeOut, 'blueprint-proof-diff.json'),
      },
      {
        id: 'runtime-binding-smoke',
        status: gateStatusFromReport(binding, 'passed'),
        report: path.join(outDir, 'runtime-binding-smoke-report.json'),
      },
      {
        id: 'production-verify',
        status: gateStatusFromReport(readJsonIfExists(path.join(smokeOut, 'unity-verify-summary.json')), 'passed'),
        report: path.join(smokeOut, 'unity-verify-summary.json'),
      },
    ],
    commands: commands,
    timing: timing ? {
      report: path.join(outDir, 'pipeline-timing.json'),
      totalMs: timing.totalMs,
      stages: timing.stages.map(function(stage) {
        return {
          id: stage.id,
          status: stage.status,
          durationMs: stage.durationMs,
        };
      }),
    } : null,
  };
  var filePath = path.join(outDir, 'source-ir-debug-plan.json');
  writeJson(filePath, plan);
  return filePath;
}

function main() {
  var opts = parseArgs(process.argv);
  var inputPath = path.resolve(opts.input);
  var outDir = path.resolve(opts.outDir);
  if (!fs.existsSync(inputPath)) throw new Error('input not found: ' + inputPath);
  fs.mkdirSync(outDir, { recursive: true });
  var timing = createTiming(inputPath, outDir, opts);
  var runtime = {};

  try {
    var report = runTimed(timing, 'source-ir-preflight', function() {
      return preflightInput(inputPath, outDir, opts);
    });
    if (!report.passed) {
      writeSemanticSource(outDir, {
        semanticSource: 'source-scene-ir-required',
        sourceIrBuildPassed: false,
        sourceIrPreflightPassed: false,
        sourceIrPresent: false,
        inputKind: inputKind(inputPath),
        failure: firstViolationCodes(report).join('; ') || 'source-ir preflight failed',
      });
      throw new Error('SourceIR-only preflight failed: ' + firstViolationCodes(report).join('; '));
    }

    var sourcePhaseLivenessReport;
    try {
      sourcePhaseLivenessReport = runTimed(timing, 'source-phase-liveness', function() {
        return runSourcePhaseLiveness(inputPath, outDir, opts);
      });
    } catch (error) {
      var failedLivenessPath = path.join(outDir, 'source-phase-liveness-report.json');
      var failedLiveness = fs.existsSync(failedLivenessPath) ? JSON.parse(fs.readFileSync(failedLivenessPath, 'utf8')) : null;
      writeSemanticSource(outDir, {
        semanticSource: 'source-scene-ir-required',
        sourceIrBuildPassed: false,
        sourceIrPreflightPassed: true,
        sourceIrPresent: true,
        sourcePhaseLivenessPassed: false,
        inputKind: inputKind(inputPath),
        sourceSceneIrHash: report.summary && report.summary.sourceSceneIrHash || null,
        failure: firstViolationCodes(failedLiveness).join('; ') || 'source phase liveness failed',
      });
      throw new Error('SourceIR phase liveness failed: ' + (firstViolationCodes(failedLiveness).join('; ') || error.message));
    }
    var sourcePhaseLiveness = JSON.parse(fs.readFileSync(sourcePhaseLivenessReport, 'utf8'));
    var artifacts = runTimed(timing, 'source-ir-artifacts', function() {
      return buildSourceIrArtifacts(inputPath, outDir, {
        projectName: opts.projectName || path.basename(outDir),
        noBlueprint: opts.writeBlueprintArtifacts !== true,
      });
    });
    writeSemanticSource(outDir, {
      sourceIrBuildPassed: true,
      sourceIrPreflightPassed: true,
      sourceIrPresent: true,
      sourcePhaseLivenessPassed: sourcePhaseLiveness.passed === true,
      inputKind: inputKind(inputPath),
      sourceSceneIrHash: artifacts.sourceIr.semanticHash,
      playableSceneIrHash: artifacts.playableSceneIr.semanticHash,
      sourceVisualIrHash: artifacts.sourceVisualIr.semanticHash,
      sourceIrRenderer: report.summary && report.summary.sourceIrRenderer || null,
    });
    runTimed(timing, 'source-ir-artifact-contract', function() {
      assertIrOnlyArtifacts(outDir);
      return true;
    });
    runtime = runTimed(timing, 'blueprint-smoke-and-visual', function() {
      return runSmokeAndVisual(inputPath, outDir, opts);
    });
    var runtimeBindingSmokeReport = null;
    if (opts.runtimeBindingSmoke) {
      runtimeBindingSmokeReport = runTimed(timing, 'runtime-binding-smoke', function() {
        return runRuntimeBindingSmoke(outDir, runtime, opts);
      });
    }
    var summary = {
      ok: true,
      outDir: outDir,
      input: inputPath,
      inputKind: inputKind(inputPath),
      semanticSource: 'source-scene-ir',
      legacyJsInferenceUsed: false,
      mode: opts.debugFast ? 'debug-fast' : 'standard',
      sourceIrBuildPassed: true,
      sourceIrPreflightPassed: true,
      sourceIrPresent: true,
      sourcePhaseLivenessPassed: sourcePhaseLiveness.passed === true,
      sourceSceneIrHash: artifacts.sourceIr.semanticHash,
      playableSceneIrHash: artifacts.playableSceneIr.semanticHash,
      sourceVisualIrHash: artifacts.sourceVisualIr.semanticHash,
      sourceIrRenderer: report.summary && report.summary.sourceIrRenderer || null,
      paths: Object.assign({}, artifacts.paths, {
        sourceIrReport: path.join(outDir, 'source-ir-report.json'),
        sourcePhaseLivenessReport: sourcePhaseLivenessReport,
        semanticSource: path.join(outDir, 'semantic-source.json'),
        sourceIrBuildSummary: path.join(outDir, 'source-ir-build-summary.json'),
        pipelineTiming: path.join(outDir, 'pipeline-timing.json'),
        sourceIrDebugPlan: path.join(outDir, 'source-ir-debug-plan.json'),
        runtimeBindingSmoke: runtimeBindingSmokeReport,
      }, runtime),
    };
    writeJson(path.join(outDir, 'source-ir-build-summary.json'), summary);
    finishTiming(timing, outDir, 'passed');
    buildDebugPlan(inputPath, outDir, opts, runtime, timing, null);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    finishTiming(timing, outDir, 'failed', {
      failure: error && error.message || String(error),
    });
    buildDebugPlan(inputPath, outDir, opts, runtime, timing, error);
    throw error;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack || error);
    process.exit(1);
  }
}
