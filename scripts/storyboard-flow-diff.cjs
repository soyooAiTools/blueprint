#!/usr/bin/env node
'use strict';

var path = require('path');

var {
  buildStoryboardFlowDiffReportFromFiles,
  writeDiffReport,
} = require('../engine/storyboard-flow-diff.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard-flow-diff.cjs <flow.json> <source-html> <out-dir> [--generated-at ISO]');
  process.exit(2);
}

function parseArgs(argv) {
  var flowPath = argv[2];
  var sourceHtmlPath = argv[3];
  var outDir = argv[4];
  if (!flowPath || !sourceHtmlPath || !outDir) usage();
  var options = { generatedAt: null };
  for (var i = 5; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--generated-at') {
      options.generatedAt = argv[++i] || null;
    } else {
      usage();
    }
  }
  return {
    flowPath: path.resolve(flowPath),
    sourceHtmlPath: path.resolve(sourceHtmlPath),
    outDir: path.resolve(outDir),
    options: options,
  };
}

function main(argv) {
  var parsed = parseArgs(argv);
  var report = buildStoryboardFlowDiffReportFromFiles(parsed.flowPath, parsed.sourceHtmlPath, parsed.options);
  var reportPath = writeDiffReport(report, parsed.outDir);
  console.log('wrote storyboard flow diff report: ' + reportPath);
  console.log('diffCounts: blocker=' + report.diffCounts.blocker + ' warn=' + report.diffCounts.warn + ' info=' + report.diffCounts.info);
  if (!report.passed) process.exit(1);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  }
}
