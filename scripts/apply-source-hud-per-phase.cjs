#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var visualAssets = require('../adapters/demo2spec/visual-assets.js');
var demo2specFidelity = require('../adapters/demo2spec/fidelity-contract.js');
var fidelity = require('../engine/fidelity-contract.cjs');

function usage() {
  console.error('Usage: node scripts/apply-source-hud-per-phase.cjs --contract <in.json> --source-html <source.html> --out <out.json> [--report <report.json>]');
  console.error('   or: node scripts/apply-source-hud-per-phase.cjs --contract <in.json> --asset-manifest <asset-manifest.json> --out <out.json> [--report <report.json>]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = { contractPath: null, sourceHtmlPath: null, assetManifestPath: null, outPath: null, reportPath: null };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--contract') opts.contractPath = argv[++i] || null;
    else if (arg === '--source-html') opts.sourceHtmlPath = argv[++i] || null;
    else if (arg === '--asset-manifest') opts.assetManifestPath = argv[++i] || null;
    else if (arg === '--out') opts.outPath = argv[++i] || null;
    else if (arg === '--report') opts.reportPath = argv[++i] || null;
    else if (arg === '--help' || arg === '-h') usage();
    else usage();
  }
  if (!opts.contractPath || !opts.outPath) usage();
  if (!opts.sourceHtmlPath && !opts.assetManifestPath) usage();
  if (opts.sourceHtmlPath && opts.assetManifestPath) usage();
  return opts;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function loadSource(opts) {
  if (opts.assetManifestPath) {
    return readJson(path.resolve(opts.assetManifestPath));
  }
  var sourceHtmlPath = path.resolve(opts.sourceHtmlPath);
  var html = fs.readFileSync(sourceHtmlPath, 'utf8');
  return visualAssets.extractVisualAssetManifest(html, { source: sourceHtmlPath });
}

function main() {
  var opts = parseArgs(process.argv);
  var source = loadSource(opts);
  var input = readJson(path.resolve(opts.contractPath));
  var result = demo2specFidelity.applySourceHudPerPhase(input, source, { includeSummary: true });
  var validation = fidelity.validateFidelityContract(result.contract);
  if (!validation.valid) {
    console.error('contract failed validation after hud perPhase extraction:');
    console.error(validation.errors.join('\n'));
    process.exit(3);
  }

  writeJson(path.resolve(opts.outPath), result.contract);

  var report = {
    kind: 'blueprint.fidelityContract.sourceHudPerPhaseReport',
    schemaVersion: fidelity.SCHEMA_VERSION,
    source: opts.sourceHtmlPath ? path.resolve(opts.sourceHtmlPath) : path.resolve(opts.assetManifestPath),
    contractIn: path.resolve(opts.contractPath),
    contractOut: path.resolve(opts.outPath),
    phaseCount: source && source.sourcePhaseContract && source.sourcePhaseContract.phaseCount || 0,
    updated: result.summary.updated,
  };
  if (opts.reportPath) writeJson(path.resolve(opts.reportPath), report);

  console.log('=== source HUD perPhase extraction ===');
  console.log(' input contract : ' + path.resolve(opts.contractPath));
  console.log(' source         : ' + report.source);
  console.log(' output contract: ' + path.resolve(opts.outPath));
  console.log(' phase count    : ' + report.phaseCount);
  console.log(' updated hud    : ' + result.summary.updated.map(function (item) {
    return item.id + '(' + item.phaseCount + ')';
  }).join(', '));
}

main();
