#!/usr/bin/env node
'use strict';

// Layer 4 of task #27. Multi-fixture catalog runner.
// Iterates engine/fixture-catalog.cjs entries and runs the appropriate
// fidelity lane per fixture (unity: audit + writer/round-trip;
// html: source-html-bind + fidelity-source-diff). Emits aggregated
// fixtures-acceptance-summary.json + delegates per-fixture artifacts to
// the existing single-fixture machinery.

var fs = require('fs');
var os = require('os');
var path = require('path');

var fixtureCatalog = require('../engine/fixture-catalog.cjs');
var auditGate = require('../engine/fidelity-audit-gate.cjs');
var report = require('../engine/fidelity-report.cjs');
var unityWriter = require('../adapters/source-ir/fidelity-unity-writer.js');
var sourceIrFidelity = require('../adapters/source-ir/fidelity-contract.js');

var sourceHtmlBind = require('../engine/stages/source-html-bind.cjs');
var fidelitySourceDiff = require('../engine/stages/fidelity-source-diff.cjs');

function usage() {
  console.error('Usage: node scripts/run-fidelity-catalog.cjs [--catalog <path>] [--out-dir <path>] [--status <golden|candidate|advisory>] [--name <fixtureName>] [--allow-audit-fail] [--skip-html] [--skip-unity]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    catalogPath: null,
    outDir: null,
    statuses: null,
    names: null,
    allowAuditFail: false,
    skipHtml: false,
    skipUnity: false,
  };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--catalog') opts.catalogPath = argv[++i] || null;
    else if (arg === '--out-dir') opts.outDir = argv[++i] || null;
    else if (arg === '--status') (opts.statuses = opts.statuses || []).push(argv[++i]);
    else if (arg === '--name') (opts.names = opts.names || []).push(argv[++i]);
    else if (arg === '--allow-audit-fail') opts.allowAuditFail = true;
    else if (arg === '--skip-html') opts.skipHtml = true;
    else if (arg === '--skip-unity') opts.skipUnity = true;
    else if (arg === '--help' || arg === '-h') usage();
    else usage();
  }
  return opts;
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function runUnityLane(fixture, outDir, opts) {
  var contract = readJson(fixture.contractPath);
  var supportedCapabilities = sourceIrFidelity.supportedCapabilitiesFor(fixture.target || 'unity');
  var projectDir = fixture.projectDir || fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-catalog-' + fixture.name + '-'));

  var auditResult = null;
  var roundTrip = null;
  var roundTripError = null;

  if (!opts.allowAuditFail) {
    try {
      var rt = unityWriter.runUnityFidelityRoundTrip(contract, projectDir, {
        supportedCapabilities: supportedCapabilities,
        allowMissingUnityCoverage: true,
      });
      auditResult = rt.auditResult;
      roundTrip = rt.roundTrip;
    } catch (err) {
      auditResult = err && err.auditResult ? err.auditResult : null;
      roundTripError = err && err.message ? err.message : String(err);
    }
  } else {
    auditResult = auditGate.runAuditGate(contract, {
      target: fixture.target || 'unity',
      supportedCapabilities: supportedCapabilities,
      allowMissingUnityCoverage: true,
    });
    if (auditResult && auditResult.passed) {
      try {
        var rt2 = unityWriter.runUnityFidelityRoundTrip(contract, projectDir, {
          supportedCapabilities: supportedCapabilities,
          allowMissingUnityCoverage: true,
        });
        roundTrip = rt2.roundTrip;
      } catch (err) {
        roundTripError = err && err.message ? err.message : String(err);
      }
    }
  }

  var built = report.buildFidelityReport({
    contract: contract,
    auditResult: auditResult,
    roundTrip: roundTrip,
    visual: null,
    evidencePolicy: { visualRequired: false },
    fixture: fixture.name,
    advisoryNotes: roundTripError ? ['roundTrip skipped: ' + roundTripError] : [],
  });

  var fixtureOut = path.join(outDir, fixture.name);
  writeJson(path.join(fixtureOut, 'fidelity-e2e-report.json'), built.json);
  fs.writeFileSync(path.join(fixtureOut, 'fidelity-e2e-report.html'), built.html, 'utf8');

  return {
    fixture: fixture.name,
    lane: 'unity',
    status: fixture.status,
    target: fixture.target,
    passed: !!(built.json && built.json.summary && built.json.summary.passed),
    summary: built.json.summary,
    roundTripError: roundTripError,
    reportJson: path.join(fixtureOut, 'fidelity-e2e-report.json'),
    reportHtml: path.join(fixtureOut, 'fidelity-e2e-report.html'),
  };
}

function loadPhaseSpecsFromContract(contract) {
  var inner = (contract && contract.contract) || contract;
  return (inner.phases || []).map(function (p, i) {
    return { id: p.id, phaseIndex: i + 1 };
  });
}

async function runHtmlLane(fixture, outDir) {
  var indexPath = path.join(fixture.projectDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return {
      fixture: fixture.name,
      lane: 'html',
      status: fixture.status,
      target: fixture.target,
      passed: false,
      error: 'index.html not found at ' + indexPath,
    };
  }
  var contract = readJson(fixture.contractPath);
  var phaseSpecs = loadPhaseSpecsFromContract(contract);

  var ctx = {
    taskId: 'catalog-' + fixture.name,
    fidelityContractPath: fixture.contractPath,
    htmlOutput: fs.readFileSync(indexPath, 'utf8'),
    blueprint: {
      sourceHtmlPath: fixture.sourceHtmlPath,
      sourceHtmlSha256: fixture.sha256.sourceHtml,
      phaseSpecs: phaseSpecs,
    },
    logs: [],
    addLog: function (stage, msg) { this.logs.push('[' + stage + '] ' + msg); },
  };

  if (typeof sourceHtmlBind.assertBefore === 'function') sourceHtmlBind.assertBefore(ctx);
  await sourceHtmlBind.execute(ctx);

  if (typeof fidelitySourceDiff.assertBefore === 'function') fidelitySourceDiff.assertBefore(ctx);
  var diffError = null;
  try {
    await fidelitySourceDiff.execute(ctx);
  } catch (e) {
    diffError = e && e.message ? e.message : String(e);
  }

  var reportObj = ctx.fidelitySourceDiffReport;
  if (!reportObj) {
    return {
      fixture: fixture.name,
      lane: 'html',
      status: fixture.status,
      target: fixture.target,
      passed: false,
      error: diffError || 'fidelity-source-diff produced no report',
    };
  }

  var fixtureOut = path.join(outDir, fixture.name);
  writeJson(path.join(fixtureOut, 'fidelity-source-diff-report.json'), reportObj);

  var byCat = {};
  var totalFieldDiffs = 0;
  (reportObj.perPhase || []).forEach(function (p) {
    (p.fieldDiffs || []).forEach(function (d) { byCat[d.category] = (byCat[d.category] || 0) + 1; });
    totalFieldDiffs += (p.fieldDiffs || []).length;
  });

  return {
    fixture: fixture.name,
    lane: 'html',
    status: fixture.status,
    target: fixture.target,
    passed: !!reportObj.passed,
    phaseCount: (reportObj.perPhase || []).length,
    totalFieldDiffs: totalFieldDiffs,
    categories: byCat,
    diffError: diffError,
    reportJson: path.join(fixtureOut, 'fidelity-source-diff-report.json'),
  };
}

async function main() {
  var opts = parseArgs(process.argv);
  var outDir = path.resolve(opts.outDir || path.join(process.cwd(), 'fidelity-catalog-out'));
  ensureDir(outDir);

  var fixtures = fixtureCatalog.listFixtures({
    manifestPath: opts.catalogPath || undefined,
    status: opts.statuses,
    names: opts.names,
  });

  console.log('=== Fidelity acceptance catalog run ===');
  console.log('manifest    : ' + (opts.catalogPath || fixtureCatalog.DEFAULT_MANIFEST));
  console.log('out dir     : ' + outDir);
  console.log('fixtures    : ' + fixtures.length);
  fixtures.forEach(function (f) {
    console.log('  - ' + f.name + ' (status=' + f.status + ' target=' + f.target + ')');
  });
  console.log('');

  var results = [];
  for (var i = 0; i < fixtures.length; i++) {
    var fixture = fixtures[i];
    console.log('--- [' + (i + 1) + '/' + fixtures.length + '] ' + fixture.name + ' (' + fixture.target + ') ---');
    var t0 = Date.now();
    var result;
    try {
      if (fixture.target === 'html') {
        if (opts.skipHtml) { console.log('  skipped (--skip-html)'); continue; }
        result = await runHtmlLane(fixture, outDir);
      } else {
        if (opts.skipUnity) { console.log('  skipped (--skip-unity)'); continue; }
        result = runUnityLane(fixture, outDir, opts);
      }
    } catch (err) {
      result = {
        fixture: fixture.name,
        lane: fixture.target === 'html' ? 'html' : 'unity',
        status: fixture.status,
        target: fixture.target,
        passed: false,
        error: err && err.stack ? err.stack : String(err),
      };
    }
    result.durationMs = Date.now() - t0;
    results.push(result);
    console.log('  -> passed=' + result.passed + ' lane=' + result.lane + ' duration=' + result.durationMs + 'ms');
    if (result.error) console.log('     ERROR: ' + String(result.error).split('\n')[0]);
    if (result.categories) console.log('     cats=' + JSON.stringify(result.categories));
  }

  var allPassed = results.every(function (r) { return r.passed; });
  var summary = {
    kind: 'blueprint.fixtureAcceptanceCatalog.runSummary',
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    manifestPath: opts.catalogPath || fixtureCatalog.DEFAULT_MANIFEST,
    outDir: outDir,
    fixtureCount: results.length,
    passedCount: results.filter(function (r) { return r.passed; }).length,
    failedCount: results.filter(function (r) { return !r.passed; }).length,
    allPassed: allPassed,
    results: results,
  };

  writeJson(path.join(outDir, 'fixtures-acceptance-summary.json'), summary);
  console.log('\n=== Catalog summary ===');
  console.log(' fixtures   : ' + summary.fixtureCount + ' (passed=' + summary.passedCount + ' failed=' + summary.failedCount + ')');
  console.log(' allPassed  : ' + allPassed);
  console.log(' summary    : ' + path.join(outDir, 'fixtures-acceptance-summary.json'));

  process.exit(allPassed ? 0 : 1);
}

main().catch(function (err) {
  console.error('Fatal: ' + (err && err.stack ? err.stack : String(err)));
  process.exit(99);
});
