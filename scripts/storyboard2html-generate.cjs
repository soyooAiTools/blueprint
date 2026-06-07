#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var contractMod = require('../engine/storyboard2html-contract.cjs');
var promptBuilder = require('../engine/storyboard2html-prompt.cjs');
var sourceIrPreviewRenderer = require('../engine/source-ir-preview-renderer.cjs');
var codexCoder = require('../worker/codex-coder.js');

function usage() {
  console.error('Usage: node scripts/storyboard2html-generate.cjs <blueprint.json|input-bundle.json> <out.html> [--theme name] [--steps N] [--dry-run] [--prompt-only out.txt] [--model id] [--timeout-ms N] [--source-ir-renderer]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    input: null, outHtml: null, themeHint: null, steps: null,
    dryRun: false, promptOnly: null, model: null, timeoutMs: null,
    sourceIrRenderer: false,
  };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--theme') {
      opts.themeHint = argv[++i] || null;
    } else if (arg === '--steps') {
      opts.steps = Number(argv[++i] || 0) || null;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--prompt-only') {
      opts.promptOnly = argv[++i] || null;
    } else if (arg === '--model') {
      opts.model = argv[++i] || null;
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = Number(argv[++i] || 0) || null;
    } else if (arg === '--source-ir-renderer' || arg === '--rewrite-source-ir-preview') {
      opts.sourceIrRenderer = true;
    } else if (!opts.input) {
      opts.input = arg;
    } else if (!opts.outHtml) {
      opts.outHtml = arg;
    } else {
      usage();
    }
  }
  if (!opts.input || !opts.outHtml) usage();
  return opts;
}

function loadBundle(inputPath, opts) {
  var raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (raw && raw.kind === 'blueprint.storyboard2html.input') return raw;
  return contractMod.buildStoryboard2HtmlInput(raw, {
    projectName: raw.projectName || raw.name || path.basename(inputPath, path.extname(inputPath)),
    themeHint: opts.themeHint,
    steps: opts.steps,
  });
}

function main() {
  var opts = parseArgs(process.argv);
  var inputPath = path.resolve(opts.input);
  var bundle = loadBundle(inputPath, opts);
  var built = promptBuilder.buildStoryboard2HtmlPrompt(bundle, {
    model: opts.model,
    timeoutMs: opts.timeoutMs,
  });

  if (opts.promptOnly) {
    var promptPath = path.resolve(opts.promptOnly);
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, '=== SYSTEM ===\n' + built.systemPrompt + '\n\n=== USER ===\n' + built.userPrompt);
    console.log('prompt dumped to ' + promptPath + ': systemPrompt=' + built.systemPrompt.length + 'c userPrompt=' + built.userPrompt.length + 'c');
    return;
  }

  if (opts.dryRun) {
    console.log('dry-run plan:');
    console.log('  input bundle: ' + inputPath);
    console.log('  output html:  ' + path.resolve(opts.outHtml));
    console.log('  projectName:  ' + built.metadata.projectName);
    console.log('  themeHint:    ' + built.metadata.themeHint);
    console.log('  phases:       ' + built.metadata.phases);
    console.log('  systemPrompt: ' + built.systemPrompt.length + ' chars');
    console.log('  userPrompt:   ' + built.userPrompt.length + ' chars');
    console.log('  model:        ' + built.model);
    console.log('  timeoutMs:    ' + built.timeoutMs);
    console.log('  sourceIR renderer rewrite: ' + (opts.sourceIrRenderer ? 'yes' : 'no'));
    return;
  }

  console.log('calling runCodexText (model=' + built.model + ', timeoutMs=' + built.timeoutMs + ')...');
  codexCoder.runCodexText({
    systemPrompt: built.systemPrompt,
    userPrompt: built.userPrompt,
    backend: 'codex-exec',
    model: built.model,
    timeoutMs: built.timeoutMs,
    minOutputLen: built.minOutputLen,
    taskId: 'storyboard2html-' + (built.metadata.projectName || 'job'),
    allowBackendFallback: false,
    log: function(line) { console.log(line); },
  }).then(function(result) {
    if (!result || !result.ok) {
      console.error('runCodexText failed: ' + (result && result.error || 'unknown error'));
      process.exit(1);
    }
    var html;
    try {
      html = promptBuilder.extractHtml(result.text);
    } catch (err) {
      console.error((err && err.code ? '[' + err.code + '] ' : '') + (err && err.message || err));
      console.error('--- first 400 chars of LLM output ---');
      console.error(String(result.text || '').slice(0, 400));
      process.exit(1);
    }
    if (!html || html.indexOf('<') !== 0) {
      console.error('extracted html looks empty/invalid (first 200 chars): ' + (html || '').slice(0, 200));
      process.exit(1);
    }
    if (opts.sourceIrRenderer) {
      try {
        html = sourceIrPreviewRenderer.rewriteHtmlWithSourceIrPreviewRenderer(html, {
          sourceHtmlPath: path.resolve(opts.outHtml),
        });
      } catch (err) {
        console.error('SourceIR renderer rewrite failed: ' + (err && err.message || err));
        process.exit(1);
      }
    }
    var outPath = path.resolve(opts.outHtml);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html);
    console.log('wrote ' + outPath + ' (' + html.length + ' bytes)');
    console.log('next: node scripts/storyboard2html-smoke.cjs ' + outPath + ' <outdir> --theme ' + built.metadata.themeHint);
  }, function(err) {
    console.error('runCodexText rejected: ' + (err && err.stack || err));
    process.exit(1);
  });
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
