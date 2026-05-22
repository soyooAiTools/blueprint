#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var contractMod = require('../engine/storyboard2html-contract.cjs');
var promptBuilder = require('../engine/storyboard2html-prompt.cjs');
var codexCoder = require('../worker/codex-coder.js');

function usage() {
  console.error('Usage: node scripts/storyboard2html-generate.cjs <blueprint.json|input-bundle.json> <out.html> [--theme name] [--steps N] [--dry-run] [--prompt-only out.txt] [--model id] [--timeout-ms N]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    input: null, outHtml: null, themeHint: null, steps: null,
    dryRun: false, promptOnly: null, model: null, timeoutMs: null,
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

function stripCodeFence(text) {
  text = String(text || '').trim();
  if (text.indexOf('```') === 0) {
    var lines = text.split('\n');
    lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].indexOf('```') === 0) lines.pop();
    text = lines.join('\n').trim();
  }
  return text;
}

function extractHtml(text) {
  var trimmed = stripCodeFence(text);
  var lower = trimmed.toLowerCase();
  var start = lower.indexOf('<!doctype html>');
  if (start < 0) start = lower.indexOf('<html');
  if (start < 0) return trimmed;
  var end = lower.lastIndexOf('</html>');
  if (end >= 0) end += '</html>'.length;
  if (end < 0) end = trimmed.length;
  return trimmed.slice(start, end).trim();
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
    return;
  }

  console.log('calling runCodexText (model=' + built.model + ', timeoutMs=' + built.timeoutMs + ')...');
  codexCoder.runCodexText({
    systemPrompt: built.systemPrompt,
    userPrompt: built.userPrompt,
    model: built.model,
    timeoutMs: built.timeoutMs,
    minOutputLen: built.minOutputLen,
    taskId: 'storyboard2html-' + (built.metadata.projectName || 'job'),
    log: function(line) { console.log(line); },
  }).then(function(result) {
    if (!result || !result.ok) {
      console.error('runCodexText failed: ' + (result && result.error || 'unknown error'));
      process.exit(1);
    }
    var html = extractHtml(result.text);
    if (!html || html.indexOf('<') !== 0) {
      console.error('extracted html looks empty/invalid (first 200 chars): ' + (html || '').slice(0, 200));
      process.exit(1);
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
