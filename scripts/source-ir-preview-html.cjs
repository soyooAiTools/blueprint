#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var {
  buildSourceIrPreviewHtml,
  rewriteHtmlWithSourceIrPreviewRenderer,
} = require('../engine/source-ir-preview-renderer.cjs');
var {
  loadSourceSceneIr,
  normalizeSourceSceneIr,
} = require('../engine/source-scene-ir.cjs');

function usage() {
  console.error('Usage: node scripts/source-ir-preview-html.cjs <input.html|source-ir.json> <out.html> [--allow-legacy] [--no-three]');
  process.exit(2);
}

function main(argv) {
  var inputPath = argv[2];
  var outPath = argv[3];
  if (!inputPath || !outPath) usage();
  var flags = argv.slice(4);
  var absInput = path.resolve(inputPath);
  var absOut = path.resolve(outPath);
  var rewritten;
  if (/\.json$/i.test(absInput)) {
    var sourceIr = normalizeSourceSceneIr(loadSourceSceneIr(absInput), {
      sourceHtmlPath: absInput,
      generatedAt: '2026-06-07T00:00:00.000Z',
    });
    rewritten = buildSourceIrPreviewHtml(sourceIr, {
      includeThree: flags.indexOf('--no-three') < 0,
      generatedAt: '2026-06-07T00:00:00.000Z',
    });
  } else {
    var html = fs.readFileSync(absInput, 'utf8');
    rewritten = rewriteHtmlWithSourceIrPreviewRenderer(html, {
      sourceHtmlPath: absInput,
      requireEmbeddedSourceIr: flags.indexOf('--allow-legacy') < 0,
      includeThree: flags.indexOf('--no-three') < 0,
    });
  }
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
