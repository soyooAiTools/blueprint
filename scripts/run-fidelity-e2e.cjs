#!/usr/bin/env node
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');

var auditGate = require('../engine/fidelity-audit-gate.cjs');
var report = require('../engine/fidelity-report.cjs');
var unityWriter = require('../adapters/demo2spec/fidelity-unity-writer.js');
var demo2specFidelity = require('../adapters/demo2spec/fidelity-contract.js');

function usage() {
  console.error('Usage: node scripts/run-fidelity-e2e.cjs --contract <path> [--project-dir <path>] [--out-dir <path>] [--target unity|html] [--fixture <name>] [--visual-report <path>] [--require-visual] [--allow-missing-unity-coverage] [--allow-audit-fail]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    contractPath: null,
    projectDir: null,
    outDir: null,
    target: 'unity',
    fixture: null,
    visualPath: null,
    requireVisual: false,
    allowMissingUnityCoverage: false,
    allowAuditFail: false
  };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--contract') opts.contractPath = argv[++i] || null;
    else if (arg === '--project-dir') opts.projectDir = argv[++i] || null;
    else if (arg === '--out-dir') opts.outDir = argv[++i] || null;
    else if (arg === '--target') opts.target = argv[++i] || 'unity';
    else if (arg === '--fixture') opts.fixture = argv[++i] || null;
    else if (arg === '--visual-report') opts.visualPath = argv[++i] || null;
    else if (arg === '--require-visual') opts.requireVisual = true;
    else if (arg === '--allow-missing-unity-coverage') opts.allowMissingUnityCoverage = true;
    else if (arg === '--allow-audit-fail') opts.allowAuditFail = true;
    else usage();
  }
  if (!opts.contractPath) usage();
  return opts;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeArtifact(filePath, value) {
  ensureDir(path.dirname(filePath));
  if (typeof value === 'string') {
    fs.writeFileSync(filePath, value, 'utf8');
  } else {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
}

function main() {
  var opts = parseArgs(process.argv);
  var contract = JSON.parse(fs.readFileSync(path.resolve(opts.contractPath), 'utf8'));
  var supportedCapabilities = demo2specFidelity.supportedCapabilitiesFor(opts.target);
  var projectDir = opts.projectDir
    ? path.resolve(opts.projectDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-e2e-'));
  var outDir = path.resolve(opts.outDir || path.join(process.cwd(), 'fidelity-e2e-out'));
  var fixture = opts.fixture || (contract && contract.unityCoverage && contract.unityCoverage.source) || path.basename(opts.contractPath, '.json');

  var roundTrip = null;
  var auditResult = null;
  var roundTripError = null;
  var visualResult = opts.visualPath
    ? JSON.parse(fs.readFileSync(path.resolve(opts.visualPath), 'utf8'))
    : null;

  if (opts.target === 'unity' && !opts.allowAuditFail) {
    var rtResult = unityWriter.runUnityFidelityRoundTrip(contract, projectDir, {
      supportedCapabilities: supportedCapabilities,
      allowMissingUnityCoverage: opts.allowMissingUnityCoverage
    });
    auditResult = rtResult.auditResult;
    roundTrip = rtResult.roundTrip;
  } else if (opts.target === 'unity' && opts.allowAuditFail) {
    auditResult = auditGate.runAuditGate(contract, {
      target: opts.target,
      supportedCapabilities: supportedCapabilities,
      allowMissingUnityCoverage: opts.allowMissingUnityCoverage
    });
    if (auditResult.passed) {
      try {
        var rtResult2 = unityWriter.runUnityFidelityRoundTrip(contract, projectDir, {
          supportedCapabilities: supportedCapabilities,
          allowMissingUnityCoverage: opts.allowMissingUnityCoverage
        });
        roundTrip = rtResult2.roundTrip;
      } catch (err) {
        roundTripError = err && err.message ? err.message : String(err);
      }
    }
  } else {
    auditResult = auditGate.runAuditGate(contract, {
      target: opts.target,
      supportedCapabilities: supportedCapabilities,
      allowMissingUnityCoverage: opts.allowMissingUnityCoverage
    });
  }

  var built = report.buildFidelityReport({
    contract: contract,
    auditResult: auditResult,
    roundTrip: roundTrip,
    visual: visualResult,
    evidencePolicy: { visualRequired: opts.requireVisual },
    fixture: fixture,
    advisoryNotes: roundTripError ? ['roundTrip skipped: ' + roundTripError] : []
  });

  var jsonPath = path.join(outDir, 'fidelity-e2e-report.json');
  var htmlPath = path.join(outDir, 'fidelity-e2e-report.html');
  writeArtifact(jsonPath, built.json);
  writeArtifact(htmlPath, built.html);

  var summary = built.json.summary;
  console.log(JSON.stringify({
    fixture: fixture,
    target: opts.target,
    projectDir: projectDir,
    outDir: outDir,
    jsonReport: jsonPath,
    htmlReport: htmlPath,
    summary: summary
  }, null, 2));

  process.exit(summary.passed ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  if (err && err.auditResult) {
    console.error('audit gate errors:');
    (err.auditResult.errors || []).forEach(function(line) { console.error('  - ' + line); });
  }
  process.exit(1);
}
