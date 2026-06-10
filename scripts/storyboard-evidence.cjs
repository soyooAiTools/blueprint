#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var parser = require('../adapters/storyboard-static-parser.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard-evidence.cjs --out <evidence-ir.json> [--project-name name] <file...>');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = { outPath: '', projectName: '', files: [] };
  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--out') opts.outPath = argv[++i] || '';
    else if (arg === '--project-name') opts.projectName = argv[++i] || '';
    else opts.files.push(arg);
  }
  if (!opts.outPath || opts.files.length === 0) usage();
  return opts;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function main() {
  var opts = parseArgs(process.argv);
  var ir = parser.parseStaticSources(opts.files, { projectName: opts.projectName });
  writeJson(path.resolve(opts.outPath), ir);
  console.log('evidenceIr=' + path.resolve(opts.outPath));
  console.log('sourceCount=' + ir.sources.length);
  console.log('factCount=' + ir.facts.length);
  console.log('diagnosticCount=' + ir.diagnostics.length);
  console.log('semanticHash=' + ir.semanticHash);
}

main();
