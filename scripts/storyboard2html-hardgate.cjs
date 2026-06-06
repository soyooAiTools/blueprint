#!/usr/bin/env node
'use strict';

var hardgate = require('../engine/storyboard2html-hardgate.cjs');
var playableFlowManifest = require('../engine/playable-flow-manifest.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard2html-hardgate.cjs --snapshot <snapshot-schema.json> --report <verify_report.json> --summary <unity-verify-summary.json> [--html <generated.html>] [--expected-phases N] [--manifest playable-flow-manifest.json]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = { snapshotSchemaPath: null, verifyReportPath: null, verifySummaryPath: null, htmlPath: null, expectedPhaseCount: null, manifestPath: null };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--snapshot') {
      opts.snapshotSchemaPath = argv[++i] || null;
    } else if (arg === '--report') {
      opts.verifyReportPath = argv[++i] || null;
    } else if (arg === '--summary') {
      opts.verifySummaryPath = argv[++i] || null;
    } else if (arg === '--html') {
      opts.htmlPath = argv[++i] || null;
    } else if (arg === '--expected-phases') {
      opts.expectedPhaseCount = Number(argv[++i] || 0) || null;
    } else if (arg === '--manifest') {
      opts.manifestPath = argv[++i] || null;
    } else {
      usage();
    }
  }
  if (!opts.snapshotSchemaPath || !opts.verifyReportPath || !opts.verifySummaryPath) usage();
  return opts;
}

try {
  var opts = parseArgs(process.argv);
  var result = hardgate.evaluateHardGates(opts);
  if (opts.manifestPath || process.env.PLAYABLE_FLOW_MANIFEST_PATH) {
    playableFlowManifest.recordStoryboard2HtmlSmoke({
      manifestPath: opts.manifestPath || process.env.PLAYABLE_FLOW_MANIFEST_PATH,
      outDir: opts.snapshotSchemaPath ? require('path').dirname(opts.snapshotSchemaPath) : process.cwd(),
      htmlPath: opts.htmlPath,
      snapshotSchemaPath: opts.snapshotSchemaPath,
      verifyReportPath: opts.verifyReportPath,
      verifySummaryPath: opts.verifySummaryPath,
      hardgateResult: result,
    });
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
