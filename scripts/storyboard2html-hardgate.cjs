#!/usr/bin/env node
'use strict';

var hardgate = require('../engine/storyboard2html-hardgate.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard2html-hardgate.cjs --snapshot <snapshot-schema.json> --report <verify_report.json> [--expected-phases N]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = { snapshotSchemaPath: null, verifyReportPath: null, expectedPhaseCount: null };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--snapshot') {
      opts.snapshotSchemaPath = argv[++i] || null;
    } else if (arg === '--report') {
      opts.verifyReportPath = argv[++i] || null;
    } else if (arg === '--expected-phases') {
      opts.expectedPhaseCount = Number(argv[++i] || 0) || null;
    } else {
      usage();
    }
  }
  if (!opts.snapshotSchemaPath || !opts.verifyReportPath) usage();
  return opts;
}

try {
  var result = hardgate.evaluateHardGates(parseArgs(process.argv));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
