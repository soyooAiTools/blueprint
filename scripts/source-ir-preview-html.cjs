#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var {
  rewriteHtmlWithSourceIrPreviewRenderer,
} = require('../engine/source-ir-preview-renderer.cjs');

function usage() {
  console.error('Usage: node scripts/source-ir-preview-html.cjs <input.html> <out.html> [--allow-legacy]');
  process.exit(2);
}

function main(argv) {
  var inputPath = argv[2];
  var outPath = argv[3];
  if (!inputPath || !outPath) usage();
  var flags = argv.slice(4);
  var absInput = path.resolve(inputPath);
  var absOut = path.resolve(outPath);
  var html = fs.readFileSync(absInput, 'utf8');
  var rewritten = rewriteHtmlWithSourceIrPreviewRenderer(html, {
    sourceHtmlPath: absInput,
    requireEmbeddedSourceIr: flags.indexOf('--allow-legacy') < 0,
  });
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, rewritten);
  console.log('wrote SourceIR preview HTML ' + absOut + ' (' + rewritten.length + ' bytes)');
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  }
}
