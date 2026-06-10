#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var parser = require('../adapters/storyboard-static-parser.cjs');
var planner = require('../engine/storyboard-ai-planner.cjs');
var storyboardAi = require('../engine/storyboard-ai.cjs');
var htmlBridge = require('../engine/storyboard-html-bridge.cjs');

var REPO_ROOT = path.resolve(__dirname, '..');

function usage() {
  console.error('Usage: node scripts/storyboard-html-package.cjs --out-dir <dir> [--project-name name] [--generation-mode codex|deterministic] [--model id] [--timeout-ms N] [--allow-empty-evidence] <file...>');
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
    files: [],
  };
  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--out-dir') opts.outDir = argv[++i] || '';
    else if (arg === '--project-name') opts.projectName = argv[++i] || '';
    else if (arg === '--generation-mode') opts.generationMode = argv[++i] || '';
    else if (arg === '--model') opts.model = argv[++i] || '';
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i] || 0) || 0;
    else if (arg === '--allow-empty-evidence') opts.allowEmptyEvidence = true;
    else opts.files.push(arg);
  }
  if (!opts.outDir || opts.files.length === 0) usage();
  return opts;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
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

async function buildPackage(files, outDir, options) {
  options = options || {};
  var absOut = path.resolve(outDir);
  fs.mkdirSync(absOut, { recursive: true });

  var evidence = parser.parseStaticSources(files, { projectName: options.projectName });
  writeJson(path.join(absOut, 'evidence-ir.json'), evidence);
  if (!options.allowEmptyEvidence && !hasAutomatableEvidence(evidence)) {
    var err = new Error('No automatable static storyboard evidence found. HTML/video-only references are manual_required in v1; provide PDF/Word/Excel/image input.');
    err.code = 'STORYBOARD_HTML_NO_AUTOMATABLE_EVIDENCE';
    err.manualRequiredCount = unsupportedSummary(evidence).length;
    throw err;
  }

  var storyboard = planner.planStoryboardAiFromEvidence(evidence, { projectName: options.projectName || evidence.project.name });
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
  });
  console.log('outDir=' + report.outDir);
  console.log('generatedHtml=' + report.artifacts.generatedHtml);
  console.log('phaseCount=' + report.phaseCount);
  console.log('manualRequiredCount=' + report.unsupportedOrManualSources.length);
  console.log('storyboardHash=' + report.storyboardHash);
}

if (require.main === module) {
  main().catch(function(err) {
    if (err && err.code === 'STORYBOARD_HTML_NO_AUTOMATABLE_EVIDENCE') {
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
  },
};
