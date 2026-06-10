#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var customerPdf = require('../adapters/customer-storyboard-pdf.cjs');
var storyboardAi = require('../engine/storyboard-ai.cjs');

function usage() {
  console.error('Usage:');
  console.error('  node scripts/customer-storyboard-pdf.cjs --template <out.pdf> [--map <out.json>]');
  console.error('  node scripts/customer-storyboard-pdf.cjs <storyboard-ai.json> <out.pdf> [--map <out.json>]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = { template: false, inputPath: '', outPath: '', mapPath: '', projectName: '', coreLoop: '' };
  var positional = [];
  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--template') opts.template = true;
    else if (arg === '--map') opts.mapPath = argv[++i] || '';
    else if (arg === '--project-name') opts.projectName = argv[++i] || '';
    else if (arg === '--core-loop') opts.coreLoop = argv[++i] || '';
    else positional.push(arg);
  }
  if (opts.template) {
    opts.outPath = positional[0] || '';
  } else {
    opts.inputPath = positional[0] || '';
    opts.outPath = positional[1] || '';
  }
  if (!opts.outPath || !opts.template && !opts.inputPath) usage();
  return opts;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

async function main() {
  var opts = parseArgs(process.argv);
  var input;
  var baseDir = process.cwd();
  if (opts.template) {
    input = customerPdf.buildTemplateStoryboardAi({
      projectName: opts.projectName,
      coreLoop: opts.coreLoop,
    });
  } else {
    var inputPath = path.resolve(opts.inputPath);
    baseDir = path.dirname(inputPath);
    input = storyboardAi.normalizeStoryboardAi(JSON.parse(fs.readFileSync(inputPath, 'utf8')), {
      projectName: opts.projectName,
      coreLoop: opts.coreLoop,
    });
  }
  await customerPdf.generateCustomerStoryboardPDF(input, {
    outputPath: opts.outPath,
    baseDir: baseDir,
  });
  var mapPath = opts.mapPath || opts.outPath.replace(/\.pdf$/i, '') + '.map.json';
  writeJson(path.resolve(mapPath), customerPdf.buildPdfMap(input));
  console.log('customerStoryboardPdf=' + path.resolve(opts.outPath));
  console.log('customerStoryboardMap=' + path.resolve(mapPath));
  console.log('phaseCount=' + input.phases.length);
  console.log('semanticHash=' + input.semanticHash);
}

main().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
