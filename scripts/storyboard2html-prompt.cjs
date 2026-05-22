#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var promptBuilder = require('../engine/storyboard2html-prompt.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard2html-prompt.cjs <input-bundle.json> [--out <file>] [--system-only] [--user-only]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = { input: null, out: null, mode: 'both' };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--out') {
      opts.out = argv[++i] || null;
    } else if (arg === '--system-only') {
      opts.mode = 'system';
    } else if (arg === '--user-only') {
      opts.mode = 'user';
    } else if (!opts.input) {
      opts.input = arg;
    } else {
      usage();
    }
  }
  if (!opts.input) usage();
  return opts;
}

function main() {
  var opts = parseArgs(process.argv);
  var bundlePath = path.resolve(opts.input);
  var bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  var built = promptBuilder.buildStoryboard2HtmlPrompt(bundle);
  var output;
  if (opts.mode === 'system') {
    output = built.systemPrompt;
  } else if (opts.mode === 'user') {
    output = built.userPrompt;
  } else {
    output = '=== SYSTEM PROMPT ===\n' + built.systemPrompt + '\n\n=== USER PROMPT ===\n' + built.userPrompt;
  }
  if (opts.out) {
    var outPath = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output);
    console.log('wrote ' + outPath + ': systemPrompt=' + built.systemPrompt.length + 'c userPrompt=' + built.userPrompt.length + 'c');
  } else {
    process.stdout.write(output + '\n');
  }
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
