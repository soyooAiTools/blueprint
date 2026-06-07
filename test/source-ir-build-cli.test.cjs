#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  buildSourceIrPreviewHtml,
} = require('../engine/source-ir-preview-renderer.cjs');
var {
  SOURCE_SCENE_IR_SCHEMA_VERSION,
  normalizeSourceSceneIr,
  writeSourceSceneIr,
} = require('../engine/source-scene-ir.cjs');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ir-build-cli-'));

function fixtureSourceIr() {
  return normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: 'blueprint.sourceSceneIR',
    project: { name: 'source-ir-build-fixture', theme: 'default' },
    scene: {
      backgroundColor: '#101820',
      camera: { fov: 55, position: [0, 8, 12], lookAt: [0, 0, 0] },
      ground: { kind: 'plane', size: [20, 20], color: '#203040' },
    },
    entities: [
      { id: 'Player', label: 'Player', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } },
      { id: 'Gem', label: 'Gem', kind: 'resource', position: [3, 0, 0], visual: { primitive: 'sphere', color: '#33aaff' } },
      { id: 'CtaButton', label: 'Install', kind: 'cta', position: [6, 0, 0], visual: { primitive: 'box', color: '#22cc88' } },
    ],
    resources: [{ id: 'Gem', label: 'Gem', carrierEntity: 'Gem', kind: 'resource', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: 'Collect gem',
        guideText: 'Collect gem',
        showEntities: ['Player', 'Gem'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'collect_on_near'],
        steps: [
          { kind: 'move_to', target: 'Gem', radius: 1.2 },
          { kind: 'collect', resource: 'Gem', amount: 1, from: 'Gem' },
        ],
        gate: { kind: 'resource', resource: 'Gem', threshold: 1 },
      },
      {
        id: 'phase2',
        title: 'Install',
        guideText: 'Go to install',
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
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
}

function runBuild(inputPath, outDir, extraArgs) {
  return childProcess.spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'source-ir-build.cjs'),
    inputPath,
    outDir,
  ].concat(extraArgs || []), { encoding: 'utf8' });
}

var sourceIr = fixtureSourceIr();
var rendererHtmlPath = path.join(tmp, 'renderer.html');
fs.writeFileSync(rendererHtmlPath, buildSourceIrPreviewHtml(sourceIr, {
  html: '<div id="joystick"></div>',
  generatedAt: '2026-06-07T00:00:00.000Z',
}));

var rendererOut = path.join(tmp, 'renderer-out');
var rendererRun = runBuild(rendererHtmlPath, rendererOut, ['--project', 'source-ir-build-cli-renderer']);
assert.strictEqual(rendererRun.status, 0, rendererRun.stderr || rendererRun.stdout);
var rendererSummary = JSON.parse(rendererRun.stdout);
assert.strictEqual(rendererSummary.semanticSource, 'source-scene-ir');
assert.strictEqual(rendererSummary.legacyJsInferenceUsed, false);
assert.strictEqual(rendererSummary.sourceIrRenderer.ownsVisuals, true);
assert.strictEqual(rendererSummary.sourceIrRenderer.ownsPhaseDriver, true);
assert.ok(rendererSummary.sourceVisualIrHash);
assert.ok(fs.existsSync(path.join(rendererOut, 'source-ir-build-summary.json')));
assert.ok(fs.existsSync(path.join(rendererOut, 'spec.json')));
assert.ok(fs.existsSync(path.join(rendererOut, 'gameschema.json')));
assert.ok(fs.existsSync(path.join(rendererOut, 'source-visual-ir.json')));
var rendererSemanticSource = JSON.parse(fs.readFileSync(path.join(rendererOut, 'semantic-source.json'), 'utf8'));
assert.strictEqual(rendererSemanticSource.legacyJsInferenceUsed, false);
assert.strictEqual(rendererSemanticSource.sourceIrBuildPassed, true);
assert.strictEqual(rendererSemanticSource.sourceVisualIrHash, rendererSummary.sourceVisualIrHash);
var rendererSpec = JSON.parse(fs.readFileSync(path.join(rendererOut, 'spec.json'), 'utf8'));
assert.strictEqual(rendererSpec.meta.semanticSource, 'source-scene-ir');
assert.strictEqual(rendererSpec.meta.legacyJsInferenceUsed, false);
assert.strictEqual(rendererSpec.meta.sourceVisualIrPath, 'source-visual-ir.json');
assert.strictEqual(rendererSpec.meta.sourceVisualIrHash, rendererSummary.sourceVisualIrHash);

var sourceIrJsonPath = path.join(tmp, 'source-ir.json');
writeSourceSceneIr(sourceIrJsonPath, sourceIr);
var jsonOut = path.join(tmp, 'json-out');
var jsonRun = runBuild(sourceIrJsonPath, jsonOut, []);
assert.strictEqual(jsonRun.status, 0, jsonRun.stderr || jsonRun.stdout);
var jsonSummary = JSON.parse(jsonRun.stdout);
assert.strictEqual(jsonSummary.inputKind, 'source-ir-json');
assert.strictEqual(jsonSummary.sourceIrRenderer, null);
assert.strictEqual(jsonSummary.legacyJsInferenceUsed, false);
assert.ok(fs.existsSync(path.join(jsonOut, 'playable-scene-ir.json')));
assert.ok(fs.existsSync(path.join(jsonOut, 'source-visual-ir.json')));

var nonRendererHtmlPath = path.join(tmp, 'non-renderer.html');
fs.writeFileSync(nonRendererHtmlPath, [
  '<!doctype html><html><body><div id="joystick"></div><script>',
  'window.__BP_SOURCE_IR__ = ' + JSON.stringify(sourceIr) + ';',
  'window.__BP_SOURCE_IR_HASH__ = "' + sourceIr.semanticHash + '";',
  '</script></body></html>',
].join('\n'));
var nonRendererOut = path.join(tmp, 'non-renderer-out');
var nonRendererRun = runBuild(nonRendererHtmlPath, nonRendererOut, []);
assert.notStrictEqual(nonRendererRun.status, 0);
assert.ok(/source_ir_renderer_missing/.test(nonRendererRun.stderr), nonRendererRun.stderr);
var nonRendererSemanticSource = JSON.parse(fs.readFileSync(path.join(nonRendererOut, 'semantic-source.json'), 'utf8'));
assert.strictEqual(nonRendererSemanticSource.semanticSource, 'source-scene-ir-required');
assert.strictEqual(nonRendererSemanticSource.legacyJsInferenceUsed, false);
assert.strictEqual(nonRendererSemanticSource.sourceIrPreflightPassed, false);
assert.strictEqual(fs.existsSync(path.join(nonRendererOut, 'spec.json')), false);

var allowedOut = path.join(tmp, 'non-renderer-allowed-out');
var allowedRun = runBuild(nonRendererHtmlPath, allowedOut, ['--allow-non-renderer-html']);
assert.strictEqual(allowedRun.status, 0, allowedRun.stderr || allowedRun.stdout);
assert.strictEqual(JSON.parse(allowedRun.stdout).legacyJsInferenceUsed, false);

var legacyHtmlPath = path.join(tmp, 'legacy.html');
fs.writeFileSync(legacyHtmlPath, '<!doctype html><html><body><script>window.PHASES=[];</script></body></html>');
var legacyOut = path.join(tmp, 'legacy-out');
var legacyRun = runBuild(legacyHtmlPath, legacyOut, []);
assert.notStrictEqual(legacyRun.status, 0);
assert.ok(/source_ir_embedded_missing/.test(legacyRun.stderr), legacyRun.stderr);
assert.strictEqual(fs.existsSync(path.join(legacyOut, 'spec.json')), false);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(legacyOut, 'semantic-source.json'), 'utf8')).legacyJsInferenceUsed, false);

console.log('source-ir build CLI tests passed');
