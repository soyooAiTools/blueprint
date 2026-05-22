#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var contract = require('../engine/storyboard2html-contract.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard2html-input.cjs <blueprint.json> [out.json] [--theme name] [--steps N]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = { input: null, out: null, themeHint: null, steps: null };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--theme') {
      opts.themeHint = argv[++i] || null;
    } else if (arg === '--steps') {
      opts.steps = Number(argv[++i] || 0) || null;
    } else if (!opts.input) {
      opts.input = arg;
    } else if (!opts.out) {
      opts.out = arg;
    } else {
      usage();
    }
  }
  if (!opts.input) usage();
  return opts;
}

function main() {
  var opts = parseArgs(process.argv);
  var inputPath = path.resolve(opts.input);
  var raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  var bundle = contract.buildStoryboard2HtmlInput(raw, {
    projectName: raw.projectName || raw.name || path.basename(inputPath, path.extname(inputPath)),
    themeHint: opts.themeHint,
    steps: opts.steps,
  });
  var text = JSON.stringify(bundle, null, 2);
  if (opts.out) {
    var outPath = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text);
    console.log('wrote ' + outPath + ': specs=' + bundle.specs.length + ', frames=' + bundle.storyboardFrames.length + ', theme=' + bundle.themeHint);
  } else {
    process.stdout.write(text + '\n');
  }
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
