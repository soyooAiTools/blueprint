'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;
var storyboard2html = require('../engine/storyboard2html-contract.cjs');
var hardgate = require('../engine/storyboard2html-hardgate.cjs');

var contract = storyboard2html.loadContract();
assert.strictEqual(storyboard2html.validateContract(contract), true);
assert.strictEqual(contract.schemaVersion, '1.0.0');
assert.strictEqual(contract.kind, 'blueprint.storyboard2html.htmlContract');
assert.ok(contract.htmlStaticEntry.requiredGlobals.some(function(entry) { return entry.name === 'PHASES'; }));
assert.ok(contract.htmlStaticEntry.requiredGlobals.some(function(entry) { return entry.name === 'setTip'; }));
assert.strictEqual(contract.runtimeStateContract.globalName, 'window.__gameState');
assert.ok(contract.runtimeStateContract.requiredTopLevelKeys.indexOf('phaseEvidence') >= 0);
assert.strictEqual(contract.phaseEvidenceEnvelope.requiredModuleMeta['_meta.schemaVersion'], '1.0.0');
assert.strictEqual(contract.phaseEvidenceEnvelope.requiredModuleMeta['_meta.sourcePlatform'], 'html');
assert.ok(contract.versionPolicy.schemaVersion);
assert.ok(contract.versionPolicy.contractVersion);
assert.strictEqual(contract.runtimeStateContract.aliases.policy.indexOf('snake_case keys are hard-required') >= 0, true);
assert.ok(contract.phaseEvidenceEnvelope.flatSignals.indexOf('guide_text_visible') >= 0);

var blueprint = {
  projectName: 'FarmStoryboard',
  storyboard: {
    frames: [
      { title: 'Collect corn', interaction: 'collect:Corn:1', ui: 'Collect corn', camera: 'follow player' },
      { title: 'Sell', interaction: 'click:CtaButton', ui: 'Sell crop' },
    ],
  },
  entities: [
    { name: 'Player', label: 'Player', template: 'PlayerController' },
    { name: 'Corn', label: 'Corn', template: 'Collectible' },
  ],
  resources: [
    { name: 'Corn', entity: 'Corn' },
  ],
  specs: [
    {
      phaseId: 'phase1',
      phaseName: 'Collect corn',
      requiredInteractions: ['collect:Corn:1'],
      playerInstruction: 'Collect corn',
      plannedModuleIds: ['guide_ui', 'collect_on_near', 'inventory_wallet'],
      trigger: { type: 'resource_collected', resource: 'Corn', amount: 1 },
      entitiesRequired: [{ name: 'Corn', resource: 'Corn' }],
      duration: { min: 10, max: 12 },
    },
    {
      phaseId: 'phase2',
      phaseName: 'Sell',
      requiredInteractions: ['click:CtaButton'],
      playerInstruction: 'Sell crop',
      plannedModuleIds: ['guide_ui', 'click_trigger', 'player_input_tap', 'cta_finish'],
      trigger: { type: 'click_entity', entity: 'CtaButton' },
      entitiesRequired: [],
    },
  ],
};

var bundle = storyboard2html.buildStoryboard2HtmlInput(blueprint, {
  htmlPath: '/tmp/generated.html',
  outDir: '/tmp/storyboard2html-out',
  steps: 12,
});
assert.strictEqual(bundle.kind, 'blueprint.storyboard2html.input');
assert.strictEqual(bundle.projectName, 'FarmStoryboard');
assert.strictEqual(bundle.themeHint, 'farming');
assert.strictEqual(bundle.specs.length, 2);
assert.strictEqual(bundle.storyboardFrames.length, 2);
assert.strictEqual(bundle.specs[0].phaseId, 'phase1');
assert.strictEqual(bundle.specs[0].requiredInteractions[0], 'collect:Corn:1');
assert.deepStrictEqual(bundle.specs[0].plannedModuleIds, ['guide_ui', 'collect_on_near', 'inventory_wallet']);
assert.strictEqual(bundle.specs[0].trigger.type, 'resource_collected');
assert.strictEqual(bundle.storyboardFrames[0].title, 'Collect corn');
assert.strictEqual(bundle.htmlContract.kind, contract.kind);
assert.ok(bundle.acceptancePlan.command.join(' ').indexOf('/root/.claude/skills/demo2spec/index.js') >= 0);
assert.ok(bundle.acceptancePlan.command.indexOf('--blueprint-smoke') >= 0);
assert.ok(bundle.acceptancePlan.command.indexOf('--verify') >= 0);
assert.ok(bundle.acceptancePlan.hardGates.some(function(gate) {
  return gate.indexOf('triggeredPresentFullRate') >= 0;
}));

assert.throws(function() {
  storyboard2html.buildStoryboard2HtmlInput({ projectName: 'NoSpecs' });
}, /requires ctx\.blueprint\.specs/);

var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard2html-contract-'));
var blueprintPath = path.join(tempDir, 'blueprint.json');
var bundlePath = path.join(tempDir, 'storyboard2html-input.json');
fs.writeFileSync(blueprintPath, JSON.stringify(blueprint, null, 2));
var inputResult = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-input.cjs'),
  blueprintPath,
  bundlePath,
  '--theme',
  'tower-defense',
  '--steps',
  '9',
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(inputResult.status, 0, inputResult.stderr || inputResult.stdout);
var cliBundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
assert.strictEqual(cliBundle.themeHint, 'tower-defense');
assert.strictEqual(cliBundle.acceptancePlan.command[cliBundle.acceptancePlan.command.length - 1], '9');

var smokeResult = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-smoke.cjs'),
  '/tmp/generated.html',
  '/tmp/storyboard2html-out',
  '--theme',
  'farming',
  '--steps',
  '7',
  '--dry-run',
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(smokeResult.status, 0, smokeResult.stderr || smokeResult.stdout);
assert.ok(smokeResult.stdout.indexOf('/root/.claude/skills/demo2spec/index.js') >= 0);
assert.ok(smokeResult.stdout.indexOf('--blueprint-smoke') >= 0);
assert.ok(smokeResult.stdout.indexOf('hardGates=') >= 0);

var snapshotDoc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'snapshot-schema.v1.json'), 'utf8'));
snapshotDoc = JSON.parse(JSON.stringify(snapshotDoc));
snapshotDoc.project = { phases: [{ phaseId: 'phase1' }, { phaseId: 'phase2' }] };
var verifyReport = {
  phaseCoverage: '2/2',
  phaseEvidenceSummary: {
    enabled: true,
    aggregate: {
      triggeredPresentFullRate: 1,
      triggeredAntiAutoplayHeldRate: 1,
    },
    validation: { passed: true, violations: [] },
  },
};
var snapshotPath = path.join(tempDir, 'snapshot-schema.json');
var reportPath = path.join(tempDir, 'verify-report.json');
fs.writeFileSync(snapshotPath, JSON.stringify(snapshotDoc, null, 2));
fs.writeFileSync(reportPath, JSON.stringify(verifyReport, null, 2));
var hardgateResult = hardgate.evaluateHardGates({
  snapshotSchemaPath: snapshotPath,
  verifyReportPath: reportPath,
});
assert.strictEqual(hardgateResult.passed, true);
assert.deepStrictEqual(hardgate.parseCoveragePair('10/10'), { covered: 10, total: 10 });

verifyReport.phaseEvidenceSummary.aggregate.triggeredPresentFullRate = 0.5;
fs.writeFileSync(reportPath, JSON.stringify(verifyReport, null, 2));
var failedHardgate = hardgate.evaluateHardGates({
  snapshotSchemaPath: snapshotPath,
  verifyReportPath: reportPath,
});
assert.strictEqual(failedHardgate.passed, false);
assert.ok(failedHardgate.gates[1].errors.some(function(error) {
  return error.indexOf('triggeredPresentFullRate') >= 0;
}));

console.log('storyboard2html contract tests passed');
