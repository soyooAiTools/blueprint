#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var {
  preflightSourceSceneIrHtml,
} = require('../engine/source-scene-ir.cjs');

function usage() {
  console.error('Usage: node scripts/source-scene-ir-preflight.cjs <generated.html> <out/report.json> [--require-renderer]');
}

function main(argv) {
  var htmlPath = argv[2];
  var reportPath = argv[3];
  if (!htmlPath || !reportPath) {
    usage();
    process.exit(2);
  }
  var absHtmlPath = path.resolve(htmlPath);
  var absReportPath = path.resolve(reportPath);
  var flags = argv.slice(4);
  var html = fs.readFileSync(absHtmlPath, 'utf8');
  var report = preflightSourceSceneIrHtml(html, {
    sourceHtmlPath: absHtmlPath,
    requireSourceIrRenderer: flags.indexOf('--require-renderer') >= 0 || flags.indexOf('--require-source-ir-renderer') >= 0,
  });
  fs.mkdirSync(path.dirname(absReportPath), { recursive: true });
  fs.writeFileSync(absReportPath, JSON.stringify(report, null, 2) + '\n');
  console.log((report.passed ? 'pass' : 'fail') + ' source-scene-ir preflight: ' + absReportPath);
  if (!report.passed) process.exit(1);
}

if (require.main === module) {
  main(process.argv);
}
