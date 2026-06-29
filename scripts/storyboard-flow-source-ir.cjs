#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var {
  buildSourceSceneIrFromStoryboardFlow,
  FLOW_CONTRACT_PATH,
  loadStoryboardFlow,
  preflightStoryboardFlow,
} = require('../engine/storyboard-flow-source-ir.cjs');
var {
  buildSourceIrPreviewHtml,
} = require('../engine/source-ir-preview-renderer.cjs');
var {
  preflightSourceSceneIrHtml,
} = require('../engine/source-scene-ir.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard-flow-source-ir.cjs <flow.json> <out-dir> [--no-three] [--validate-only] [--generated-at ISO]');
  process.exit(2);
}

function parseArgs(argv) {
  var inputPath = argv[2];
  var outDir = argv[3];
  if (!inputPath || !outDir) usage();
  var options = { includeThree: true, generatedAt: null, validateOnly: false };
  for (var i = 4; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--no-three') {
      options.includeThree = false;
    } else if (arg === '--validate-only') {
      options.validateOnly = true;
    } else if (arg === '--generated-at') {
      options.generatedAt = argv[++i] || null;
    } else {
      usage();
    }
  }
  return {
    inputPath: path.resolve(inputPath),
    outDir: path.resolve(outDir),
    options: options,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function authoringBlockerSummary(authoringPreflight) {
  return authoringPreflight.issues.filter(function(issue) {
    return issue.severity === 'blocker';
  }).slice(0, 5).map(function(issue) {
    return issue.code + (issue.phaseId ? ': ' + issue.phaseId : '') + ' ' + issue.message;
  }).join('; ');
}

function main(argv) {
  var parsed = parseArgs(argv);
  fs.mkdirSync(parsed.outDir, { recursive: true });
  var sourceIrPath = path.join(parsed.outDir, 'source-scene-ir.json');
  var htmlPath = path.join(parsed.outDir, 'source-ir-preview.html');
  var preflightPath = path.join(parsed.outDir, 'source-ir-preflight.json');
  var authoringPreflightPath = path.join(parsed.outDir, 'storyboard-flow-authoring-report.json');
  var reportPath = path.join(parsed.outDir, 'storyboard-flow-source-ir-report.json');
  var flow = loadStoryboardFlow(parsed.inputPath);
  var authoringPreflight = preflightStoryboardFlow(flow, {
    generatedAt: parsed.options.generatedAt,
  });
  writeJson(authoringPreflightPath, authoringPreflight);
  if (parsed.options.validateOnly) {
    writeJson(reportPath, {
      schemaVersion: 'storyboard-flow-source-ir-report.v1',
      mode: 'validate-only',
      inputPath: parsed.inputPath,
      outDir: parsed.outDir,
      contract: FLOW_CONTRACT_PATH,
      sourceSceneIrPath: null,
      sourceIrPreviewHtmlPath: null,
      authoringPreflightPath: authoringPreflightPath,
      preflightPath: null,
      phaseCount: authoringPreflight.phaseCount,
      authoringIssueCounts: authoringPreflight.issueCounts,
      resourceSnapshots: authoringPreflight.resourceSnapshots,
      passed: authoringPreflight.passed === true,
    });
    if (authoringPreflight.passed !== true) {
      console.error('storyboard flow authoring preflight failed: ' + authoringBlockerSummary(authoringPreflight));
      process.exit(1);
    }
    console.log('validated storyboard flow authoring input: ' + parsed.inputPath);
    console.log('authoring-report: ' + authoringPreflightPath);
    return;
  }
  if (authoringPreflight.passed !== true) {
    writeJson(reportPath, {
      schemaVersion: 'storyboard-flow-source-ir-report.v1',
      mode: 'convert',
      inputPath: parsed.inputPath,
      outDir: parsed.outDir,
      contract: FLOW_CONTRACT_PATH,
      sourceSceneIrPath: null,
      sourceIrPreviewHtmlPath: null,
      authoringPreflightPath: authoringPreflightPath,
      preflightPath: null,
      phaseCount: authoringPreflight.phaseCount,
      authoringIssueCounts: authoringPreflight.issueCounts,
      resourceSnapshots: authoringPreflight.resourceSnapshots,
      passed: false,
    });
    console.error('storyboard flow authoring preflight failed: ' + authoringBlockerSummary(authoringPreflight));
    process.exit(1);
  }
  var sourceIr = buildSourceSceneIrFromStoryboardFlow(flow, {
    sourceHtmlPath: htmlPath,
    generatedAt: parsed.options.generatedAt,
  });
  writeJson(sourceIrPath, sourceIr);
  var html = buildSourceIrPreviewHtml(sourceIr, {
    includeThree: parsed.options.includeThree,
    generatedAt: parsed.options.generatedAt,
  });
  fs.writeFileSync(htmlPath, html);
  var preflight = preflightSourceSceneIrHtml(html, {
    sourceHtmlPath: htmlPath,
    requireSourceIrRenderer: true,
  });
  writeJson(preflightPath, preflight);
  var report = {
    schemaVersion: 'storyboard-flow-source-ir-report.v1',
    inputPath: parsed.inputPath,
    outDir: parsed.outDir,
    sourceSceneIrPath: sourceIrPath,
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
  writeJson(reportPath, report);
  if (!preflight.passed) {
    console.error('storyboard flow SourceIR preflight failed: ' + preflight.violations.slice(0, 5).map(function(item) {
      return item.code + ': ' + item.message;
    }).join('; '));
    process.exit(1);
  }
  console.log('wrote storyboard flow SourceIR artifacts to ' + parsed.outDir);
  console.log('source-ir-preview: ' + htmlPath);
  console.log('semanticHash: ' + sourceIr.semanticHash);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  }
}
