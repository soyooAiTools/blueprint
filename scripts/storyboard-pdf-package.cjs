#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var parser = require('../adapters/storyboard-static-parser.cjs');
var planner = require('../engine/storyboard-ai-planner.cjs');
var storyboardAi = require('../engine/storyboard-ai.cjs');
var customerPdf = require('../adapters/customer-storyboard-pdf.cjs');
var visualProducer = require('../lib/storyboard-visual-producer.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard-pdf-package.cjs --out-dir <dir> [--project-name name] [--visual-mode brief-card|external] [--visual-command cmd] [--camera-mode perspective|orthographic] [--strict-visual] [--allow-empty-evidence] <file...>');
  console.error('V1 supports png/jpg/jpeg/pdf/csv/xlsx/xls/docx/doc. HTML and video are marked manual_required.');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    outDir: '',
    projectName: '',
    visualMode: '',
    visualCommand: '',
    cameraMode: '',
    strictVisual: false,
    allowEmptyEvidence: false,
    files: [],
  };
  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--out-dir') opts.outDir = argv[++i] || '';
    else if (arg === '--project-name') opts.projectName = argv[++i] || '';
    else if (arg === '--visual-mode') opts.visualMode = argv[++i] || '';
    else if (arg === '--visual-command') opts.visualCommand = argv[++i] || '';
    else if (arg === '--camera-mode') opts.cameraMode = argv[++i] || '';
    else if (arg === '--strict-visual') opts.strictVisual = true;
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

async function buildPackage(files, outDir, options) {
  options = options || {};
  var absOut = path.resolve(outDir);
  fs.mkdirSync(absOut, { recursive: true });
  var evidence = parser.parseStaticSources(files, { projectName: options.projectName });
  writeJson(path.join(absOut, 'evidence-ir.json'), evidence);
  if (!options.allowEmptyEvidence && !hasAutomatableEvidence(evidence)) {
    var manualCount = unsupportedSummary(evidence).length;
    var err = new Error('No automatable static storyboard evidence found. HTML/video-only references are manual_required in v1; provide PDF/Word/Excel/image input or pass --allow-empty-evidence to create a blank planning template.');
    err.code = 'STORYBOARD_PDF_NO_AUTOMATABLE_EVIDENCE';
    err.manualRequiredCount = manualCount;
    throw err;
  }

  var storyboard = planner.planStoryboardAiFromEvidence(evidence, { projectName: options.projectName || evidence.project.name });
  var visualReport = await visualProducer.produceStoryboardVisuals(storyboard, path.join(absOut, 'assets'), {
    baseDir: absOut,
    visualMode: options.visualMode,
    visualCommand: options.visualCommand,
    cameraMode: options.cameraMode,
    strictVisual: options.strictVisual,
    timeoutMs: options.visualTimeoutMs,
    onPhaseStart: options.onVisualPhaseStart,
    onPhaseComplete: options.onVisualPhaseComplete,
  });
  storyboard.semanticHash = storyboardAi._internals.semanticHash({
    schemaVersion: storyboard.schemaVersion,
    project: storyboard.project,
    phases: storyboard.phases,
    planning: storyboard.planning,
  });
  writeJson(path.join(absOut, 'storyboard-ai.json'), storyboard);

  var pdfPath = path.join(absOut, 'customer-storyboard.pdf');
  await customerPdf.generateCustomerStoryboardPDF(storyboard, {
    outputPath: pdfPath,
    baseDir: absOut,
  });
  var map = customerPdf.buildPdfMap(storyboard);
  writeJson(path.join(absOut, 'customer-storyboard.map.json'), map);

  var report = {
    schemaVersion: 'storyboard-pdf-package-report.v1',
    project: storyboard.project,
    outDir: absOut,
    inputs: files.map(function(file) { return path.resolve(file); }),
    evidenceHash: evidence.semanticHash,
    storyboardHash: storyboard.semanticHash,
    phaseCount: storyboard.phases.length,
    planning: storyboard.planning,
    imageGeneration: visualReport,
    unsupportedOrManualSources: unsupportedSummary(evidence),
    artifacts: {
      evidenceIr: path.join(absOut, 'evidence-ir.json'),
      storyboardAi: path.join(absOut, 'storyboard-ai.json'),
      customerPdf: pdfPath,
      customerPdfMap: path.join(absOut, 'customer-storyboard.map.json'),
      assetsDir: path.join(absOut, 'assets'),
      visualPromptsDir: path.join(absOut, 'visual-prompts'),
    },
    diagnostics: (evidence.diagnostics || []).concat(storyboard.diagnostics || []).concat(visualReport.diagnostics || []),
  };
  writeJson(path.join(absOut, 'audit-report.json'), report);
  return report;
}

async function main() {
  var opts = parseArgs(process.argv);
  var report = await buildPackage(opts.files, opts.outDir, {
    projectName: opts.projectName,
    visualMode: opts.visualMode,
    visualCommand: opts.visualCommand,
    cameraMode: opts.cameraMode,
    strictVisual: opts.strictVisual,
    allowEmptyEvidence: opts.allowEmptyEvidence,
  });
  console.log('outDir=' + report.outDir);
  console.log('customerStoryboardPdf=' + report.artifacts.customerPdf);
  console.log('phaseCount=' + report.phaseCount);
  console.log('manualRequiredCount=' + report.unsupportedOrManualSources.length);
  console.log('storyboardHash=' + report.storyboardHash);
}

if (require.main === module) {
  main().catch(function(err) {
    if (err && err.code === 'STORYBOARD_PDF_NO_AUTOMATABLE_EVIDENCE') {
      console.error('ERROR: ' + err.message);
    } else {
      console.error(err && err.stack || err);
    }
    process.exit(1);
  });
}

module.exports = {
  buildPackage: buildPackage,
};
