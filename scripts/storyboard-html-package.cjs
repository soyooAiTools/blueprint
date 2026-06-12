#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var parser = require('../adapters/storyboard-static-parser.cjs');
var planner = require('../engine/storyboard-ai-planner.cjs');
var storyboardAi = require('../engine/storyboard-ai.cjs');
var htmlBridge = require('../engine/storyboard-html-bridge.cjs');
var {
  FLOW_CONTRACT_PATH,
  buildSourceSceneIrFromStoryboardFlow,
  loadStoryboardFlow,
  preflightStoryboardFlow,
} = require('../engine/storyboard-flow-source-ir.cjs');
var {
  buildSourceIrPreviewHtml,
} = require('../engine/source-ir-preview-renderer.cjs');
var {
  preflightSourceSceneIrHtml,
} = require('../engine/source-scene-ir.cjs');

var REPO_ROOT = path.resolve(__dirname, '..');

function usage() {
  console.error('Usage: node scripts/storyboard-html-package.cjs --out-dir <dir> [--project-name name] [--generation-mode codex|deterministic] [--model id] [--timeout-ms N] [--flow-json flow.json] [--allow-empty-evidence] [--allow-template-expansion] <file...>');
  console.error('V1 supports png/jpg/jpeg/pdf/csv/xlsx/xls/docx/doc. HTML and video are manual_required.');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    outDir: '',
    projectName: '',
    generationMode: 'codex',
    model: '',
    timeoutMs: 0,
    allowEmptyEvidence: false,
    allowTemplateExpansion: false,
    flowPath: '',
    files: [],
  };
  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--out-dir') opts.outDir = argv[++i] || '';
    else if (arg === '--project-name') opts.projectName = argv[++i] || '';
    else if (arg === '--generation-mode') opts.generationMode = argv[++i] || '';
    else if (arg === '--model') opts.model = argv[++i] || '';
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i] || 0) || 0;
    else if (arg === '--flow-json') opts.flowPath = argv[++i] || '';
    else if (arg === '--allow-empty-evidence') opts.allowEmptyEvidence = true;
    else if (arg === '--allow-template-expansion') opts.allowTemplateExpansion = true;
    else opts.files.push(arg);
  }
  if (!opts.outDir || opts.files.length === 0) usage();
  return opts;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value || ''));
}

function unsupportedSummary(evidence) {
  return (evidence.diagnostics || []).filter(function(item) {
    return item && (item.code === 'manual_required_source' || item.code === 'unsupported_source_type');
  }).map(function(item) {
    return {
      sourceId: item.sourceId,
      extension: item.extension || null,
      reason: item.message || '',
    };
  });
}

function hasAutomatableEvidence(evidence) {
  return (evidence.facts || []).some(function(item) {
    if (!item || item.factType === 'manual_required') return false;
    if (item.sourceType === 'manual_required' || item.sourceType === 'unsupported') return false;
    return !!(item.text || item.metadata && item.metadata.imagePath);
  });
}

function normalizeGenerationMode(value) {
  var mode = String(value || 'codex').trim().toLowerCase();
  if (mode === 'source-ir' || mode === 'deterministic-source-ir') return 'deterministic';
  if (mode === 'dry-run' || mode === 'codex-dry-run') return 'deterministic';
  return mode === 'deterministic' ? 'deterministic' : 'codex';
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function flowCoreLoop(flow) {
  return safeArray(flow && flow.phases).map(function(phase) {
    return phase && phase.title || '';
  }).filter(Boolean).slice(0, 8).join(' -> ');
}

function storyboardAiFromFlow(flow, options) {
  options = options || {};
  var phases = safeArray(flow && flow.phases).map(function(phase, index) {
    var required = safeArray(phase.requiredInteractions).map(function(item) { return String(item || '').trim(); }).filter(Boolean);
    return {
      phaseId: phase.id || ('phase' + (index + 1)),
      title: phase.title || ('Phase ' + (index + 1)),
      sceneText: phase.visualNotes || phase.notes || phase.guideText || '',
      playerAction: phase.guideText || '',
      feedback: phase.completeCondition || '',
      uiText: phase.guideText || '',
      primaryTarget: phase.target || '',
      canonicalInteraction: required[0] || phase.action || '',
      requiredInteractions: required,
      visualPrompt: phase.title || '',
      sourceEvidence: [options.flowPath || 'storyboard-flow'],
      confidence: 1,
    };
  });
  var ai = storyboardAi.normalizeStoryboardAi({
    projectName: flow.projectName || flow.project && flow.project.name || options.projectName,
    coreLoop: flowCoreLoop(flow),
    phases: phases,
  }, {
    projectName: flow.projectName || flow.project && flow.project.name || options.projectName,
    coreLoop: flowCoreLoop(flow),
  });
  ai.planning = {
    schemaVersion: 'storyboard-ai-planning.v1',
    source: 'storyboard-flow',
    flowPath: options.flowPath || '',
    rawBeatCount: phases.length,
    phaseCount: ai.phases.length,
    phaseCountPolicy: { min: 10, max: 13, default: phases.length },
    strategy: 'flow_source',
  };
  ai.semanticHash = storyboardAi._internals.semanticHash({
    schemaVersion: ai.schemaVersion,
    project: ai.project,
    phases: ai.phases,
    planning: ai.planning,
  });
  return ai;
}

function riskyTemplateExpansion(storyboard) {
  var planning = storyboard && storyboard.planning || {};
  if (planning.strategy !== 'expand_to_12') return null;
  var phases = safeArray(storyboard && storyboard.phases);
  var defaultExpanded = phases.filter(function(phase) {
    return safeArray(phase && phase.sourceEvidence).length === 0 &&
      Number(phase && phase.confidence || 0) > 0 &&
      Number(phase && phase.confidence || 0) <= 0.36;
  });
  if (defaultExpanded.length < 3) return null;
  return {
    code: 'storyboard_ai_unsafe_template_expansion',
    severity: 'error',
    message: 'StoryboardAI fell back to low-confidence generic template phases. Provide a storyboard Flow source or improve PDF phase extraction before generating source HTML.',
    strategy: planning.strategy,
    rawBeatCount: planning.rawBeatCount,
    phaseCount: planning.phaseCount || phases.length,
    defaultExpandedPhaseCount: defaultExpanded.length,
    defaultExpandedPhaseTitles: defaultExpanded.map(function(phase) { return phase.title; }),
  };
}

function assertNoUnsafeTemplateExpansion(storyboard, options) {
  options = options || {};
  if (options.allowTemplateExpansion) return null;
  var risk = riskyTemplateExpansion(storyboard);
  if (!risk) return null;
  var err = new Error(risk.message);
  err.code = 'STORYBOARD_HTML_UNSAFE_TEMPLATE_EXPANSION';
  err.diagnostic = risk;
  throw err;
}

function runNode(args, options) {
  options = options || {};
  return new Promise(function(resolve, reject) {
    var child = childProcess.spawn(process.execPath, args, {
      cwd: options.cwd || REPO_ROOT,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    var stdout = '';
    var stderr = '';
    var timedOut = false;
    child.stdout.on('data', function(data) {
      stdout += data.toString();
      if (options.onStdout) options.onStdout(data.toString());
    });
    child.stderr.on('data', function(data) {
      stderr += data.toString();
      if (options.onStderr) options.onStderr(data.toString());
    });
    var timer = null;
    if (options.timeoutMs) {
      timer = setTimeout(function() {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(function() { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
      }, options.timeoutMs);
    }
    child.on('error', function(err) {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', function(code) {
      if (timer) clearTimeout(timer);
      var result = { code: code, stdout: stdout, stderr: stderr, timedOut: timedOut };
      if (code === 0) return resolve(result);
      var tail = (stderr || stdout || '').split(/\r?\n/).slice(-10).join('\n');
      var err = new Error((timedOut ? 'Timed out. ' : '') + 'Command failed: node ' + args.join(' ') + '\n' + tail);
      err.result = result;
      reject(err);
    });
  });
}

async function generateHtml(bundlePath, htmlPath, outDir, options) {
  options = options || {};
  var mode = normalizeGenerationMode(options.generationMode);
  var logPath = path.join(outDir, 'storyboard2html-generate.log');
  var logStream = fs.createWriteStream(logPath, { flags: 'a' });
  var args = [
    path.join('scripts', 'storyboard2html-generate.cjs'),
    bundlePath,
    htmlPath,
  ];
  if (mode === 'deterministic') {
    args.push('--deterministic-source-ir');
  } else {
    args.push('--source-ir-renderer');
    if (options.model) args.push('--model', options.model);
    if (options.timeoutMs) args.push('--timeout-ms', String(options.timeoutMs));
  }
  try {
    var result = await runNode(args, {
      cwd: REPO_ROOT,
      timeoutMs: options.timeoutMs || (mode === 'deterministic' ? 120000 : 900000),
      onStdout: function(text) { logStream.write(text); },
      onStderr: function(text) { logStream.write(text); },
    });
    logStream.end();
    return {
      mode: mode,
      status: 'done',
      logPath: logPath,
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
    };
  } catch (err) {
    logStream.write('\n[storyboard-html-package] ERROR\n' + (err && err.stack || err) + '\n');
    logStream.end();
    err.logPath = logPath;
    throw err;
  }
}

async function runSourceIrPreflight(htmlPath, outDir) {
  var reportPath = path.join(outDir, 'source-ir-preflight.json');
  await runNode([
    path.join('scripts', 'source-scene-ir-preflight.cjs'),
    htmlPath,
    reportPath,
    '--require-renderer',
  ], {
    cwd: REPO_ROOT,
    timeoutMs: 120000,
  });
  return {
    reportPath: reportPath,
    report: JSON.parse(fs.readFileSync(reportPath, 'utf8')),
  };
}

function buildFlowInputBundle(flow, sourceIr, options) {
  options = options || {};
  return {
    kind: 'blueprint.storyboard2html.flowSourceInput',
    schemaVersion: '1.0.0',
    projectName: flow.projectName || flow.project && flow.project.name || options.projectName || '',
    source: 'storyboard-flow',
    flowPath: options.flowPath || '',
    sourceSceneIrPath: path.join(options.outDir || '', 'source-scene-ir.json'),
    generatedHtmlPath: options.htmlPath || '',
    phaseCount: safeArray(sourceIr && sourceIr.phases).length,
    entityCount: safeArray(sourceIr && sourceIr.entities).length,
    resourceCount: safeArray(sourceIr && sourceIr.resources).length,
    contract: FLOW_CONTRACT_PATH,
    semanticHash: sourceIr && sourceIr.semanticHash || '',
  };
}

async function buildPackageFromFlow(files, outDir, options, evidence) {
  options = options || {};
  var absOut = path.resolve(outDir);
  var flowPath = path.resolve(options.flowPath);
  var htmlPath = path.join(absOut, 'generated.html');
  var sourceSceneIrPath = path.join(absOut, 'source-scene-ir.json');
  var flowCopyPath = path.join(absOut, 'storyboard-flow.json');
  var authoringPreflightPath = path.join(absOut, 'storyboard-flow-authoring-report.json');
  var flowSourceIrReportPath = path.join(absOut, 'storyboard-flow-source-ir-report.json');
  var inputBundlePath = path.join(absOut, 'storyboard2html-input.json');
  var storyboardAiPath = path.join(absOut, 'storyboard-ai.json');

  var flow = loadStoryboardFlow(flowPath);
  writeJson(flowCopyPath, flow);
  var storyboard = storyboardAiFromFlow(flow, {
    projectName: options.projectName,
    flowPath: flowPath,
  });
  writeJson(storyboardAiPath, storyboard);

  var authoringPreflight = preflightStoryboardFlow(flow, {
    generatedAt: options.generatedAt,
  });
  writeJson(authoringPreflightPath, authoringPreflight);
  if (authoringPreflight.passed !== true) {
    var authoringErr = new Error('Storyboard Flow authoring preflight failed; fix blocker issues before generating source HTML.');
    authoringErr.code = 'STORYBOARD_HTML_FLOW_PREFLIGHT_FAILED';
    authoringErr.authoringPreflightPath = authoringPreflightPath;
    authoringErr.issueCounts = authoringPreflight.issueCounts;
    throw authoringErr;
  }

  var sourceIr = buildSourceSceneIrFromStoryboardFlow(flow, {
    sourceHtmlPath: htmlPath,
    generatedAt: options.generatedAt,
  });
  writeJson(sourceSceneIrPath, sourceIr);
  writeJson(inputBundlePath, buildFlowInputBundle(flow, sourceIr, {
    projectName: options.projectName,
    flowPath: flowPath,
    outDir: absOut,
    htmlPath: htmlPath,
  }));
  writeText(htmlPath, buildSourceIrPreviewHtml(sourceIr, {
    generatedAt: options.generatedAt,
  }));
  var preflight = preflightSourceSceneIrHtml(fs.readFileSync(htmlPath, 'utf8'), {
    sourceHtmlPath: htmlPath,
    requireSourceIrRenderer: true,
  });
  var preflightPath = path.join(absOut, 'source-ir-preflight.json');
  writeJson(preflightPath, preflight);

  var flowSourceReport = {
    schemaVersion: 'storyboard-flow-source-ir-report.v1',
    inputPath: flowPath,
    outDir: absOut,
    sourceSceneIrPath: sourceSceneIrPath,
    sourceIrPreviewHtmlPath: htmlPath,
    authoringPreflightPath: authoringPreflightPath,
    preflightPath: preflightPath,
    contract: FLOW_CONTRACT_PATH,
    phaseCount: sourceIr.phases.length,
    entityCount: sourceIr.entities.length,
    resourceCount: sourceIr.resources.length,
    authoringIssueCounts: authoringPreflight.issueCounts,
    resourceSnapshots: authoringPreflight.resourceSnapshots,
    semanticHash: sourceIr.semanticHash,
    passed: preflight.passed === true,
  };
  writeJson(flowSourceIrReportPath, flowSourceReport);
  if (preflight.passed !== true) {
    var preflightErr = new Error('Flow source HTML preflight failed.');
    preflightErr.code = 'STORYBOARD_HTML_FLOW_SOURCE_PREFLIGHT_FAILED';
    preflightErr.preflightPath = preflightPath;
    throw preflightErr;
  }

  var report = {
    schemaVersion: 'storyboard-html-package-report.v1',
    sourcePipeline: 'storyboard-flow',
    project: storyboard.project,
    outDir: absOut,
    inputs: files.map(function(file) { return path.resolve(file); }),
    evidenceHash: evidence && evidence.semanticHash || '',
    storyboardHash: storyboard.semanticHash,
    phaseCount: sourceIr.phases.length,
    planning: storyboard.planning,
    generation: {
      mode: 'flow-source-ir',
      status: 'done',
      logPath: '',
      stdoutChars: 0,
      stderrChars: 0,
    },
    unsupportedOrManualSources: evidence ? unsupportedSummary(evidence) : [],
    artifacts: {
      evidenceIr: path.join(absOut, 'evidence-ir.json'),
      storyboardAi: storyboardAiPath,
      storyboard2htmlInput: inputBundlePath,
      generatedHtml: htmlPath,
      sourceIrPreflight: preflightPath,
      generateLog: '',
      storyboardFlow: flowCopyPath,
      storyboardFlowAuthoringReport: authoringPreflightPath,
      storyboardFlowSourceIrReport: flowSourceIrReportPath,
      sourceSceneIr: sourceSceneIrPath,
    },
    diagnostics: (evidence && evidence.diagnostics || []).concat(authoringPreflight.issues || []).concat(preflight.violations || []),
  };
  writeJson(path.join(absOut, 'audit-report.json'), report);
  return report;
}

async function buildPackage(files, outDir, options) {
  options = options || {};
  var absOut = path.resolve(outDir);
  fs.mkdirSync(absOut, { recursive: true });

  var evidence = parser.parseStaticSources(files, { projectName: options.projectName });
  writeJson(path.join(absOut, 'evidence-ir.json'), evidence);
  if (options.flowPath) {
    return buildPackageFromFlow(files, absOut, options, evidence);
  }
  if (!options.allowEmptyEvidence && !hasAutomatableEvidence(evidence)) {
    var err = new Error('No automatable static storyboard evidence found. HTML/video-only references are manual_required in v1; provide PDF/Word/Excel/image input.');
    err.code = 'STORYBOARD_HTML_NO_AUTOMATABLE_EVIDENCE';
    err.manualRequiredCount = unsupportedSummary(evidence).length;
    throw err;
  }

  var storyboard = planner.planStoryboardAiFromEvidence(evidence, { projectName: options.projectName || evidence.project.name });
  assertNoUnsafeTemplateExpansion(storyboard, {
    allowTemplateExpansion: options.allowTemplateExpansion,
  });
  storyboard.semanticHash = storyboardAi._internals.semanticHash({
    schemaVersion: storyboard.schemaVersion,
    project: storyboard.project,
    phases: storyboard.phases,
    planning: storyboard.planning,
  });
  writeJson(path.join(absOut, 'storyboard-ai.json'), storyboard);

  var htmlPath = path.join(absOut, 'generated.html');
  var inputBundle = htmlBridge.buildStoryboard2HtmlInputFromStoryboardAi(storyboard, {
    projectName: options.projectName || storyboard.project.name,
    htmlPath: htmlPath,
    outDir: absOut,
    steps: options.steps,
    requireSourceIrRenderer: true,
  });
  writeJson(path.join(absOut, 'storyboard2html-input.json'), inputBundle);

  var generation = await generateHtml(path.join(absOut, 'storyboard2html-input.json'), htmlPath, absOut, {
    generationMode: options.generationMode,
    model: options.model,
    timeoutMs: options.timeoutMs,
  });
  var preflight = await runSourceIrPreflight(htmlPath, absOut);

  var report = {
    schemaVersion: 'storyboard-html-package-report.v1',
    project: storyboard.project,
    outDir: absOut,
    inputs: files.map(function(file) { return path.resolve(file); }),
    evidenceHash: evidence.semanticHash,
    storyboardHash: storyboard.semanticHash,
    phaseCount: storyboard.phases.length,
    planning: storyboard.planning,
    generation: generation,
    unsupportedOrManualSources: unsupportedSummary(evidence),
    artifacts: {
      evidenceIr: path.join(absOut, 'evidence-ir.json'),
      storyboardAi: path.join(absOut, 'storyboard-ai.json'),
      storyboard2htmlInput: path.join(absOut, 'storyboard2html-input.json'),
      generatedHtml: htmlPath,
      sourceIrPreflight: preflight.reportPath,
      generateLog: generation.logPath,
    },
    diagnostics: (evidence.diagnostics || []).concat(storyboard.diagnostics || []).concat(preflight.report.violations || []),
  };
  writeJson(path.join(absOut, 'audit-report.json'), report);
  return report;
}

async function main() {
  var opts = parseArgs(process.argv);
  var report = await buildPackage(opts.files, opts.outDir, {
    projectName: opts.projectName,
    generationMode: opts.generationMode,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    allowEmptyEvidence: opts.allowEmptyEvidence,
    allowTemplateExpansion: opts.allowTemplateExpansion,
    flowPath: opts.flowPath,
  });
  console.log('outDir=' + report.outDir);
  console.log('generatedHtml=' + report.artifacts.generatedHtml);
  console.log('phaseCount=' + report.phaseCount);
  console.log('manualRequiredCount=' + report.unsupportedOrManualSources.length);
  console.log('generationMode=' + (report.generation && report.generation.mode || ''));
  console.log('storyboardHash=' + report.storyboardHash);
}

if (require.main === module) {
  main().catch(function(err) {
    if (err && (err.code === 'STORYBOARD_HTML_NO_AUTOMATABLE_EVIDENCE' || err.code === 'STORYBOARD_HTML_UNSAFE_TEMPLATE_EXPANSION')) {
      console.error('ERROR: ' + err.message);
    } else {
      console.error(err && err.stack || err);
    }
    process.exit(1);
  });
}

module.exports = {
  buildPackage: buildPackage,
  _internals: {
    normalizeGenerationMode: normalizeGenerationMode,
    hasAutomatableEvidence: hasAutomatableEvidence,
    unsupportedSummary: unsupportedSummary,
    riskyTemplateExpansion: riskyTemplateExpansion,
  },
};
