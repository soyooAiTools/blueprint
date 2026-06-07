#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  normalizeSourceSceneIr,
  sha256OfString,
} = require('../engine/source-scene-ir.cjs');
var schemaValidator = require('../adapters/schema/validate-schema.cjs');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2spec-source-ir-'));
var htmlPath = path.join(tmp, 'source.html');

function buildHtml() {
  var ir = normalizeSourceSceneIr({
    schemaVersion: 'source-scene-ir.v1',
    project: { name: 'demo2spec-source-ir-fixture', theme: 'default' },
    scene: {
      backgroundColor: '#101820',
      camera: { position: [0, 8, 12], lookAt: [0, 0, 0], fov: 55 },
      ground: { kind: 'plane', size: [20, 20], color: '#203040' },
    },
    entities: [
      { id: 'Player', label: '玩家', kind: 'player', position: [0, 0, 0], visual: { color: '#66ccff' } },
      { id: 'Gem', label: '宝石', kind: 'resource', position: [3, 0, 0], visual: { color: '#33aaff' } },
      { id: 'CtaButton', label: '下载', kind: 'cta', position: [6, 0, 0], visual: { color: '#22cc88' } },
    ],
    resources: [{ id: 'Gem', label: '宝石', carrierEntity: 'Gem', kind: 'resource', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: '收集宝石',
        guideText: '拖摇杆收集宝石',
        showEntities: ['Player', 'Gem'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'collect_on_near', 'inventory_wallet'],
        steps: [
          { kind: 'move_to', target: 'Gem', radius: 1.2 },
          { kind: 'collect', resource: 'Gem', amount: 1, from: 'Gem' },
        ],
        gate: { kind: 'resource', resource: 'Gem', threshold: 1 },
      },
      {
        id: 'phase2',
        title: '下载',
        guideText: '到达按钮下载',
        showEntities: ['Player', 'CtaButton'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'cta_finish'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton' },
      },
    ],
    hud: { tip: { source: 'phase.guideText' }, resourceBar: ['Gem'], cta: { entity: 'CtaButton', arrivalGated: true } },
    runtimeContract: { requiresJoystick: true, requiresArrivalGate: true, forbidAutoplayProgress: true },
  }, {
    html: '<div id="joystick"></div>',
    sourceHtmlPath: htmlPath,
    sourceHtmlSha256: '0'.repeat(64),
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
  return [
    '<!doctype html><html><body><div id="joystick"></div><script>',
    'window.__BP_SOURCE_IR__ = ' + JSON.stringify(ir) + ';',
    'window.__BP_SOURCE_IR_HASH__ = "' + ir.semanticHash + '";',
    '</script></body></html>',
  ].join('\n');
}

var html = buildHtml();
fs.writeFileSync(htmlPath, html);

var outDir = path.join(tmp, 'out');
var stdout = childProcess.execFileSync(process.execPath, [
  path.join(__dirname, '..', 'adapters', 'demo2spec', 'index.js'),
  htmlPath,
  outDir,
], { encoding: 'utf8' });
var summary = JSON.parse(stdout);
assert.strictEqual(summary.semanticSource, 'source-scene-ir');
assert.strictEqual(summary.legacyJsInferenceUsed, false);

var semanticSource = JSON.parse(fs.readFileSync(path.join(outDir, 'semantic-source.json'), 'utf8'));
assert.strictEqual(semanticSource.semanticSource, 'source-scene-ir');
assert.strictEqual(semanticSource.legacyJsInferenceUsed, false);
assert.strictEqual(semanticSource.sourceIrPreflightPassed, true);

var sourceIrReport = JSON.parse(fs.readFileSync(path.join(outDir, 'source-ir-report.json'), 'utf8'));
assert.strictEqual(sourceIrReport.passed, true);
assert.strictEqual(sourceIrReport.summary.embeddedSourceIrPresent, true);
assert.strictEqual(sourceIrReport.summary.legacyProjectionUsed, false);

var spec = JSON.parse(fs.readFileSync(path.join(outDir, 'spec.json'), 'utf8'));
assert.strictEqual(spec.meta.semanticSource, 'source-scene-ir');
assert.strictEqual(spec.meta.legacyJsInferenceUsed, false);
assert.strictEqual(spec.meta.sourceHtmlSha256, sha256OfString(html));

var playableSceneIr = JSON.parse(fs.readFileSync(path.join(outDir, 'playable-scene-ir.json'), 'utf8'));
assert.strictEqual(semanticSource.sourceSceneIrHash, spec.meta.sourceSceneIrHash);
assert.strictEqual(semanticSource.playableSceneIrHash, playableSceneIr.semanticHash);
assert.strictEqual(summary.sourceSceneIrHash, semanticSource.sourceSceneIrHash);
assert.strictEqual(summary.playableSceneIrHash, playableSceneIr.semanticHash);
assert.strictEqual(spec.meta.playableSceneIrHash, playableSceneIr.semanticHash);

var gameSchema = JSON.parse(fs.readFileSync(path.join(outDir, 'gameschema.json'), 'utf8'));
assert.deepStrictEqual(schemaValidator.validateGameSchema(gameSchema), []);
assert.deepStrictEqual(schemaValidator.validateSemantics(gameSchema), []);
assert.strictEqual(gameSchema.phases[0].trigger.type, 'resource_collected');
assert.strictEqual(gameSchema.phases[1].trigger.type, 'near_entity');

[
  'source-ir.json',
  'asset-manifest.json',
  'visual-runtime-contract.json',
  'playable-scene-ir.json',
  'snapshot-schema.json',
  'html-phase-slices.json',
  'unity-asset-plan.json',
  'Demo2SpecVisualAssetBaker.cs',
].forEach(function(fileName) {
  assert.ok(fs.existsSync(path.join(outDir, fileName)), fileName + ' should exist');
});

var legacyHtmlPath = path.join(tmp, 'legacy.html');
var legacyOutDir = path.join(tmp, 'legacy-out');
fs.writeFileSync(legacyHtmlPath, '<!doctype html><html><body><script>window.PHASES=[];</script></body></html>');
var legacyRun = childProcess.spawnSync(process.execPath, [
  path.join(__dirname, '..', 'adapters', 'demo2spec', 'index.js'),
  legacyHtmlPath,
  legacyOutDir,
], { encoding: 'utf8' });
assert.notStrictEqual(legacyRun.status, 0);
assert.ok(/SourceSceneIR required/.test(legacyRun.stderr), legacyRun.stderr);
var legacySemanticSource = JSON.parse(fs.readFileSync(path.join(legacyOutDir, 'semantic-source.json'), 'utf8'));
assert.strictEqual(legacySemanticSource.semanticSource, 'source-scene-ir-required');
assert.strictEqual(legacySemanticSource.legacyJsInferenceUsed, false);
assert.strictEqual(legacySemanticSource.sourceIrPresent, false);
assert.strictEqual(fs.existsSync(path.join(legacyOutDir, 'spec.json')), false);
assert.strictEqual(fs.existsSync(path.join(legacyOutDir, 'gameschema.json')), false);

console.log('demo2spec source-ir bridge tests passed');
