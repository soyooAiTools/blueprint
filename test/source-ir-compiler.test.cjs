#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  normalizeSourceSceneIr,
} = require('../engine/source-scene-ir.cjs');
var {
  assertPlayableSceneIrExecutionAlignment,
} = require('../engine/playable-scene-ir.cjs');
var schemaValidator = require('../adapters/schema/validate-schema.cjs');
var specValidateStage = require('../engine/stages/spec-validate.cjs');
var {
  buildSourceIrArtifacts,
  compileToGameSchema,
  compileVisualAssetManifest,
  compileSourceVisualIr,
  compilePlayableSceneIr,
  buildSourceIrBlueprintContext,
} = require('../adapters/source-ir/index.js');

function fixturePlans() {
  return {
    validation: { ok: true, errors: [] },
    assemblyPlan: { phaseBindings: [], moduleInstances: [] },
    cuaPlan: { steps: [] },
  };
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ir-compiler-'));
var htmlPath = path.join(tmp, 'source.html');
var sourceIr = normalizeSourceSceneIr({
  schemaVersion: 'source-scene-ir.v1',
  project: { name: 'source-ir-compiler-fixture', theme: 'farming' },
  scene: {
    backgroundColor: '#101820',
    camera: { position: [0, 8, 12], lookAt: [0, 0, 0], fov: 55 },
    ground: { kind: 'plane', size: [20, 20], color: '#203040' },
  },
  entities: [
    { id: 'Player', label: '玩家', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } },
    { id: 'WaterDrop', label: '水滴', kind: 'resource', position: [3, 0, 0], visual: { primitive: 'sphere', color: '#33aaff' } },
    { id: 'CtaButton', label: '下载', kind: 'cta', position: [6, 0, 0], visual: { primitive: 'box', color: '#22cc88' } },
  ],
  resources: [{ id: 'Water', label: '水', carrierEntity: 'WaterDrop', kind: 'resource', initial: 0 }],
  phases: [
    {
      id: 'phase1',
      title: '收集水滴',
      guideText: '拖摇杆收集水滴',
      showEntities: ['Player', 'WaterDrop'],
      plannedModuleIds: ['player_input_joystick', 'move_to_target', 'collect_on_near', 'inventory_wallet'],
      steps: [
        { kind: 'move_to', target: 'WaterDrop', radius: 1.2 },
        { kind: 'collect', resource: 'Water', amount: 2, from: 'WaterDrop' },
      ],
      gate: { kind: 'resource', resource: 'Water', threshold: 2 },
    },
    {
      id: 'phase2',
      title: '下载',
      guideText: '到达按钮完成下载',
      showEntities: ['Player', 'CtaButton'],
      plannedModuleIds: ['player_input_joystick', 'move_to_target', 'cta_finish'],
      steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
      gate: { kind: 'cta_arrival', entity: 'CtaButton' },
    },
  ],
  hud: { tip: { source: 'phase.guideText' }, resourceBar: ['Water'], cta: { entity: 'CtaButton', arrivalGated: true } },
  runtimeContract: { requiresJoystick: true, requiresArrivalGate: true, forbidAutoplayProgress: true },
}, {
  sourceHtmlPath: htmlPath,
  sourceHtmlSha256: 'a'.repeat(64),
  html: '<div id="joystick"></div>',
  generatedAt: '2026-06-07T00:00:00.000Z',
});

var html = [
  '<!doctype html><html><body><div id="joystick"></div><script>',
  'window.__BP_SOURCE_IR__ = ' + JSON.stringify(sourceIr) + ';',
  'window.__BP_SOURCE_IR_HASH__ = "' + sourceIr.semanticHash + '";',
  '</script></body></html>',
].join('\n');
fs.writeFileSync(htmlPath, html);

sourceIr = normalizeSourceSceneIr(sourceIr, {
  sourceHtmlPath: htmlPath,
  sourceHtmlSha256: require('../engine/source-scene-ir.cjs').sha256OfString(html),
  html: html,
});
assert.deepStrictEqual(sourceIr.entities.map(function(entity) { return entity.id; }), ['Player', 'WaterDrop']);
assert.strictEqual(sourceIr.hud.cta.ctaId, 'CtaButton');
assert.strictEqual(sourceIr.hud.cta.entity, undefined);

var gameSchema = compileToGameSchema(sourceIr);
assert.deepStrictEqual(schemaValidator.validateGameSchema(gameSchema), []);
assert.deepStrictEqual(schemaValidator.validateSemantics(gameSchema), []);
assert.strictEqual(gameSchema.phases[0].trigger.type, 'resource_collected');
assert.strictEqual(gameSchema.phases[0].steps[1].gain, 'Water');
assert.strictEqual(gameSchema.phases[1].trigger.type, 'cta_arrival');
assert.strictEqual(gameSchema.phases[1].trigger.ctaId, 'CtaButton');
assert.strictEqual(gameSchema.phases[1].trigger.entity, undefined);
assert.deepStrictEqual(gameSchema.entities.map(function(entity) { return entity.name; }), ['Player', 'WaterDrop']);
assert.deepStrictEqual(gameSchema.phases[1].showEntities, ['Player']);
assert.deepStrictEqual(gameSchema.phases[1].steps.map(function(step) { return step.target; }).filter(Boolean), []);

var playableSceneIr = compilePlayableSceneIr(sourceIr);
assert.strictEqual(playableSceneIr.kind, 'blueprint.playableSceneIR');
assert.strictEqual(playableSceneIr.phases.length, 2);
assert.deepStrictEqual(playableSceneIr.entities.map(function(entity) { return entity.name; }), ['Player', 'WaterDrop']);
assert.strictEqual(assertPlayableSceneIrExecutionAlignment(playableSceneIr, { gameSchema: gameSchema }).passed, true);

var sourceVisualIr = compileSourceVisualIr(sourceIr);
assert.strictEqual(sourceVisualIr.kind, 'blueprint.sourceVisualIR');
assert.strictEqual(sourceVisualIr.source.sourceSceneIrHash, sourceIr.semanticHash);
assert.strictEqual(sourceVisualIr.visual.scene.backgroundColor, '#101820');
assert.strictEqual(sourceVisualIr.visual.entities.length, 2);
assert.strictEqual(sourceVisualIr.visual.entities[1].meshOps[0].kind, 'primitive');
assert.strictEqual(sourceVisualIr.visual.hud.resourceBar[0], 'Water');
assert.strictEqual(sourceVisualIr.visual.phaseStates.length, 2);
assert.strictEqual(sourceVisualIr.visual.phaseStates[0].guidance.primaryTarget, 'WaterDrop');
assert.strictEqual(sourceVisualIr.visual.cta.ctaId, 'CtaButton');
assert.strictEqual(sourceVisualIr.visual.cta.entity, undefined);

var assetManifest = compileVisualAssetManifest(sourceIr, {
  playableSceneIrHash: playableSceneIr.semanticHash,
  sourceVisualIrHash: sourceVisualIr.semanticHash,
});
assert.strictEqual(assetManifest.kind, 'blueprint.sourceIr.visualAssetManifest');
assert.strictEqual(assetManifest.sourceVisualIrHash, sourceVisualIr.semanticHash);
assert.strictEqual(assetManifest.visualRuntimeContract.kind, 'blueprint.sourceIr.visualRuntimeContract');
assert.strictEqual(assetManifest.visualRuntimeContract.summary.phaseCount, 2);
assert.strictEqual(assetManifest.visualRuntimeContract.phaseDriver.sourceFunction, '__driveToSourcePhase');

var built = buildSourceIrBlueprintContext(sourceIr, {
  projectName: 'source-ir-compiler-fixture',
  gameSchema: gameSchema,
  playableSceneIr: playableSceneIr,
  assetManifest: assetManifest,
  buildProjectPlans: fixturePlans,
});
assert.strictEqual(built.blueprint.schemaSource, 'source-scene-ir');
assert.strictEqual(built.blueprint.legacyJsInferenceUsed, false);
assert.strictEqual(built.project.semanticSource, 'source-scene-ir');
assert.strictEqual(built.project.playableSceneIrHash, playableSceneIr.semanticHash);
assert.deepStrictEqual(built.project.specs[1].requiredInteractions, []);
assert.strictEqual(built.project.specs[1].playerMustAct, false);
assert.ok(built.project.specs[0].triggerNext, 'non-final SourceIR specs should include triggerNext');
assert.strictEqual(built.project.specs[0].triggerNext.condition, 'WaterDropCollected >= 2');
assert.strictEqual(built.project.specs[0].nextPhase, 'phase2');
specValidateStage.execute({
  blueprint: JSON.parse(JSON.stringify(built.blueprint)),
  completedStages: [],
  addLog: function() {},
});
assert.strictEqual(/move_to:CtaButton/.test(JSON.stringify(built.blueprint.plans)), false);

var outDir = path.join(tmp, 'out');
var previousProofGate = process.env.BLUEPRINT_PROOF_CONTRACT_GATE;
process.env.BLUEPRINT_PROOF_CONTRACT_GATE = '0';
var artifacts = buildSourceIrArtifacts(htmlPath, outDir, {
  projectName: 'source-ir-compiler-fixture',
  buildProjectPlans: fixturePlans,
});
if (previousProofGate == null) delete process.env.BLUEPRINT_PROOF_CONTRACT_GATE;
else process.env.BLUEPRINT_PROOF_CONTRACT_GATE = previousProofGate;
assert.ok(fs.existsSync(path.join(outDir, 'source-ir.json')));
assert.ok(fs.existsSync(path.join(outDir, 'gameschema.json')));
assert.ok(fs.existsSync(path.join(outDir, 'asset-manifest.json')));
assert.ok(fs.existsSync(path.join(outDir, 'source-visual-ir.json')));
assert.ok(fs.existsSync(path.join(outDir, 'visual-runtime-contract.json')));
assert.ok(fs.existsSync(path.join(outDir, 'playable-scene-ir.json')));
assert.strictEqual(artifacts.sourceIr.semanticHash, sourceIr.semanticHash);
assert.strictEqual(artifacts.sourceVisualIr.source.sourceSceneIrHash, sourceIr.semanticHash);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'spec.json'), 'utf8')).meta.sourceVisualIrHash, artifacts.sourceVisualIr.semanticHash);

var cliOut = path.join(tmp, 'cli-out');
var cli = childProcess.execFileSync(process.execPath, [
  path.join(__dirname, '..', 'adapters', 'source-ir', 'index.js'),
  htmlPath,
  cliOut,
  '--project',
  'source-ir-cli-fixture',
  '--no-blueprint',
], { encoding: 'utf8' });
var cliSummary = JSON.parse(cli);
assert.strictEqual(cliSummary.semanticSource, 'source-scene-ir');
assert.strictEqual(cliSummary.legacyJsInferenceUsed, false);
assert.ok(cliSummary.sourceVisualIrHash);
assert.ok(fs.existsSync(path.join(cliOut, 'gameschema.json')));
assert.ok(fs.existsSync(path.join(cliOut, 'spec.json')));
assert.ok(fs.existsSync(path.join(cliOut, 'source-visual-ir.json')));

console.log('source-ir compiler tests passed');
