#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var {
  preflightSourceSceneIrHtml,
} = require('../engine/source-scene-ir.cjs');

function usage() {
  console.error('Usage: node scripts/source-scene-ir-preflight.cjs <generated.html> <out/report.json>');
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
  var html = fs.readFileSync(absHtmlPath, 'utf8');
  var report = preflightSourceSceneIrHtml(html, {
    sourceHtmlPath: absHtmlPath,
  });
  fs.mkdirSync(path.dirname(absReportPath), { recursive: true });
  fs.writeFileSync(absReportPath, JSON.stringify(report, null, 2) + '\n');
  console.log((report.passed ? 'pass' : 'fail') + ' source-scene-ir preflight: ' + absReportPath);
  if (!report.passed) process.exit(1);
}

if (require.main === module) {
  main(process.argv);
}
