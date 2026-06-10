#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var planner = require('../engine/storyboard-ai-planner.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard-ai-plan.cjs <evidence-ir.json> <storyboard-ai.json> [--project-name name]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = { inputPath: '', outPath: '', projectName: '' };
  var positional = [];
  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--project-name') opts.projectName = argv[++i] || '';
    else positional.push(arg);
  }
  opts.inputPath = positional[0] || '';
  opts.outPath = positional[1] || '';
  if (!opts.inputPath || !opts.outPath) usage();
  return opts;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function main() {
  var opts = parseArgs(process.argv);
  var evidence = JSON.parse(fs.readFileSync(path.resolve(opts.inputPath), 'utf8'));
  var ai = planner.planStoryboardAiFromEvidence(evidence, { projectName: opts.projectName });
  writeJson(path.resolve(opts.outPath), ai);
  console.log('storyboardAi=' + path.resolve(opts.outPath));
  console.log('phaseCount=' + ai.phases.length);
  console.log('strategy=' + (ai.planning && ai.planning.strategy));
  console.log('semanticHash=' + ai.semanticHash);
}

main();
