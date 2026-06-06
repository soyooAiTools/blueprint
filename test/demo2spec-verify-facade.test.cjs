const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const facade = require('../adapters/demo2spec/verify-facade.cjs');

const paths = facade.resolveVerifyArtifactPaths('/tmp/demo2spec-verify-facade-out');
assert.strictEqual(paths.specsPath, '/tmp/demo2spec-verify-facade-out/blueprint-specs.json');
assert.strictEqual(paths.plansPath, '/tmp/demo2spec-verify-facade-out/blueprint-plans.json');
assert.strictEqual(paths.reportPath, '/tmp/demo2spec-verify-facade-out/unity-verify-report.json');
assert.strictEqual(paths.summaryPath, '/tmp/demo2spec-verify-facade-out/unity-verify-summary.json');

assert.deepStrictEqual(
  facade.buildObserveVerifyArgs({
    url: 'http://127.0.0.1:1234/index.html',
    outDir: '/tmp/demo2spec-verify-facade-out',
    steps: 7,
    verifyScript: '/tmp/blueprint_verify.py',
  }),
  [
    '/tmp/blueprint_verify.py',
    'http://127.0.0.1:1234/index.html',
    '--specs', '/tmp/demo2spec-verify-facade-out/blueprint-specs.json',
    '--plans', '/tmp/demo2spec-verify-facade-out/blueprint-plans.json',
    '--steps', '7',
    '--observe',
  ]
);
assert.strictEqual(
  facade.withAutoplayQuery('http://127.0.0.1:1234/index.html'),
  'http://127.0.0.1:1234/index.html?autoplay=1'
);
assert.strictEqual(
  facade.withAutoplayQuery('http://127.0.0.1:1234/index.html?foo=1'),
  'http://127.0.0.1:1234/index.html?foo=1&autoplay=1'
);
assert.strictEqual(
  facade.withAutoplayQuery('http://127.0.0.1:1234/index.html?autoplay=0'),
  'http://127.0.0.1:1234/index.html?autoplay=0'
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2spec-verify-facade-'));
const oldRun = path.join(tmp, 'old');
const newRun = path.join(tmp, 'new');
fs.mkdirSync(oldRun);
fs.mkdirSync(newRun);
const oldReport = path.join(oldRun, 'verify_report.json');
const newReport = path.join(newRun, 'verify_report.json');
fs.writeFileSync(oldReport, '{"passed":false}');
fs.writeFileSync(newReport, '{"passed":true}');
const now = Date.now();
fs.utimesSync(oldReport, new Date(now - 10000), new Date(now - 10000));
fs.utimesSync(newReport, new Date(now), new Date(now));
assert.strictEqual(facade.latestVerifyReport(now - 1000, tmp), newReport);

const summaryOut = path.join(tmp, 'out');
fs.mkdirSync(summaryOut);
fs.writeFileSync(newReport, JSON.stringify({
  passed: true,
  phaseCoverage: { covered: 1, total: 1 },
  signalCoverage: { covered: 2, total: 2 },
  phaseEvidenceSummary: {
    enabled: true,
    reason: null,
    aggregate: { presentFull: 1 },
    validation: { violations: [] },
  },
}, null, 2));
const written = facade.writeVerifySummary(summaryOut, newReport);
assert.strictEqual(written.reportPath, path.join(summaryOut, 'unity-verify-report.json'));
assert.strictEqual(written.summaryPath, path.join(summaryOut, 'unity-verify-summary.json'));
assert.ok(fs.existsSync(path.join(summaryOut, 'playable-flow-manifest.json')));
const summary = JSON.parse(fs.readFileSync(written.summaryPath, 'utf8'));
assert.deepStrictEqual(summary, {
  passed: true,
  phaseCoverage: { covered: 1, total: 1 },
  signalCoverage: { covered: 2, total: 2 },
  phaseEvidenceSummary: {
    enabled: true,
    reason: null,
    aggregate: { presentFull: 1 },
    validation: { violations: [] },
  },
});
const directManifest = JSON.parse(fs.readFileSync(path.join(summaryOut, 'playable-flow-manifest.json'), 'utf8'));
assert.strictEqual(directManifest.stages.demo2specVerify.runner, 'direct');
assert.strictEqual(directManifest.stages.demo2specVerify.passed, true);

assert.strictEqual(facade.normalizeVerifyRunner(), 'production');
assert.strictEqual(facade.normalizeVerifyRunner('production'), 'production');
assert.strictEqual(facade.normalizeVerifyRunner('direct'), 'direct');
assert.throws(
  () => facade.normalizeVerifyRunner('other'),
  /Unknown verify runner/
);

assert.doesNotThrow(() => facade.assertBlueprintShape({
  specs: [],
  plans: { cuaPlan: { steps: [] } },
  storyboardFrames: [],
  entities: [],
}));
assert.throws(
  () => facade.assertBlueprintShape({ specs: [], plans: { cuaPlan: { steps: [] } }, entities: [] }),
  /storyboardFrames/
);

const materializeSource = path.join(tmp, 'materialize-source');
const materializeTarget = path.join(tmp, 'materialize-target');
fs.mkdirSync(path.join(materializeSource, 'assets'), { recursive: true });
fs.writeFileSync(path.join(materializeSource, 'index.html'), '<html></html>');
fs.writeFileSync(path.join(materializeSource, 'blueprint-specs.json'), '[]');
fs.writeFileSync(path.join(materializeSource, 'blueprint-plans.json'), '{"cuaPlan":{"steps":[]}}');
fs.writeFileSync(path.join(materializeSource, 'assets', 'texture.txt'), 'texture');
const materializedCopy = facade.materializeVerifyBuildDir(materializeSource, materializeTarget, { forceCopy: true });
assert.strictEqual(materializedCopy.buildDirMaterialization, 'copy');
assert.strictEqual(fs.readFileSync(path.join(materializeTarget, 'assets', 'texture.txt'), 'utf8'), 'texture');

const prodOut = path.join(tmp, 'prod-out');
fs.mkdirSync(prodOut);
fs.writeFileSync(path.join(prodOut, 'index.html'), '<html></html>');
fs.writeFileSync(path.join(prodOut, 'blueprint-specs.json'), '[]');
fs.writeFileSync(path.join(prodOut, 'blueprint-plans.json'), '{"cuaPlan":{"steps":[]}}');
fs.writeFileSync(path.join(prodOut, 'blueprint-project.json'), '{"storyboardFrames":[],"entities":[]}');
fs.writeFileSync(path.join(prodOut, 'blueprint-gameschema.json'), '{"entities":[]}');
const prodReport = path.join(tmp, 'prod-report.json');
fs.writeFileSync(prodReport, JSON.stringify({
  passed: true,
  phaseCoverage: '1/1',
  signalCoverage: '2/2',
  phaseEvidenceSummary: {
    enabled: true,
    aggregate: { presentFull: 1 },
    validation: { passed: true },
  },
}, null, 2));

(async () => {
  const production = await facade.runProductionObserveVerify({
    outDir: prodOut,
    reportPath: prodReport,
    runCUAVerification: async function(buildDir) {
      assert.ok(fs.existsSync(path.join(buildDir, 'index.html')));
      return {
        passed: true,
        issues: [],
        planCoverage: '1/1',
        signalCoverage: '2/2',
        signalValidationPassed: true,
        missingSignals: [],
        unsupportedSignals: [],
        silentPassSignals: [],
        hardBlockingSilentSignals: [],
        visualFailReasons: [],
        telemetry: {
          schemaVersion: 'blueprint-cua-telemetry.v1',
          observeMs: 1200,
          manualFlowMs: 2300,
          totalMs: 3600,
        },
        report: { gameState: { currentPhase: 'phase1' } },
      };
    },
    summarizeRuntimeContractResult: function(result) {
      return {
        passed: result.passed === true,
        contractPassed: result.passed === true,
        needsEscalation: false,
        escalationReasons: [],
        planCoverage: result.planCoverage,
        signalCoverage: result.signalCoverage,
      };
    },
  });
  assert.strictEqual(production.runner, 'production');
  assert.ok(['symlink', 'copy'].includes(production.buildDirMaterialization));
  const productionSummary = JSON.parse(fs.readFileSync(production.verifySummary, 'utf8'));
  assert.strictEqual(productionSummary.runner, 'production');
  assert.strictEqual(productionSummary.passed, true);
  assert.strictEqual(productionSummary.runtimeContractSummary.contractPassed, true);
  assert.strictEqual(productionSummary.telemetry.schemaVersion, 'blueprint-cua-telemetry.v1');
  assert.strictEqual(productionSummary.telemetry.manualFlowMs, 2300);
  assert.ok(['symlink', 'copy'].includes(productionSummary.buildDirMaterialization));
  const productionManifest = JSON.parse(fs.readFileSync(path.join(prodOut, 'playable-flow-manifest.json'), 'utf8'));
  assert.strictEqual(productionManifest.stages.demo2specVerify.runner, 'production');
  assert.strictEqual(productionManifest.stages.demo2specVerify.runtimeContractSummary.contractPassed, true);

  console.log('demo2spec verify facade tests passed');
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
