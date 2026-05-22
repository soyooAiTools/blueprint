#!/usr/bin/env node
'use strict';

var path = require('path');
var spawnSync = require('child_process').spawnSync;
var contract = require('../engine/storyboard2html-contract.cjs');

function usage() {
  console.error('Usage: node scripts/storyboard2html-smoke.cjs <generated.html> <outdir> [--theme name] [--steps N] [--skill-root path] [--dry-run]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = { html: null, outDir: null, themeHint: 'default', steps: 40, skillRoot: null, dryRun: false };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--theme') {
      opts.themeHint = argv[++i] || opts.themeHint;
    } else if (arg === '--steps') {
      opts.steps = Number(argv[++i] || 0) || opts.steps;
    } else if (arg === '--skill-root') {
      opts.skillRoot = argv[++i] || opts.skillRoot;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (!opts.html) {
      opts.html = arg;
    } else if (!opts.outDir) {
      opts.outDir = arg;
    } else {
      usage();
    }
  }
  if (!opts.html || !opts.outDir) usage();
  return opts;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function main() {
  var opts = parseArgs(process.argv);
  var plan = contract.buildAcceptancePlan({
    demo2specSkillRoot: opts.skillRoot || process.env.DEMO2SPEC_SKILL_ROOT,
    htmlPath: path.resolve(opts.html),
    outDir: path.resolve(opts.outDir),
    themeHint: opts.themeHint,
    steps: opts.steps,
  });
  if (opts.dryRun) {
    console.log(plan.command.map(shellQuote).join(' '));
    console.log('hardGates=' + plan.hardGates.join('; '));
    return;
  }
  var result = spawnSync(plan.command[0], plan.command.slice(1), {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'inherit',
    env: Object.assign({}, process.env),
  });
  if (result.status !== 0) {
    throw new Error('storyboard2html smoke failed with exit ' + result.status);
  }
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
