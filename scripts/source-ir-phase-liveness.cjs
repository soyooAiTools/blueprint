#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var {
  evaluateSourceIrPhaseLiveness,
} = require('../engine/source-ir-phase-liveness.cjs');

function usage() {
  console.error([
    'Usage: node scripts/source-ir-phase-liveness.cjs <source-ir-renderer.html|source-ir.json> <report.json>',
    '  [--static-only] [--max-ticks N] [--settle-ms N]',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    input: null,
    report: null,
    staticOnly: false,
    maxTicks: null,
    settleMs: null,
  };
  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--static-only') {
      opts.staticOnly = true;
    } else if (arg === '--max-ticks') {
      opts.maxTicks = Number(argv[++i] || 0) || null;
    } else if (arg === '--settle-ms') {
      opts.settleMs = Number(argv[++i] || 0) || null;
    } else if (!opts.input) {
      opts.input = arg;
    } else if (!opts.report) {
      opts.report = arg;
    } else {
      usage();
    }
  }
  if (!opts.input || !opts.report) usage();
  return opts;
}

async function main() {
  var opts = parseArgs(process.argv);
  var report = await evaluateSourceIrPhaseLiveness(path.resolve(opts.input), {
    staticOnly: opts.staticOnly,
    maxTicks: opts.maxTicks,
    settleMs: opts.settleMs,
  });
  fs.mkdirSync(path.dirname(path.resolve(opts.report)), { recursive: true });
  fs.writeFileSync(path.resolve(opts.report), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    passed: report.passed,
    report: path.resolve(opts.report),
    staticPassed: report.summary.staticPassed,
    browserProbePassed: report.summary.browserProbePassed,
    violations: (report.violations || []).map(function(violation) { return violation.code; }).slice(0, 12),
  }, null, 2));
  if (!report.passed) process.exit(1);
  process.exit(0);
}

main().catch(function(error) {
  console.error(error && error.stack || error);
  process.exit(1);
});
