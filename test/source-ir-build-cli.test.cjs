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
var sourceIrBuild = require('../scripts/source-ir-build.cjs');
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
      { id: 'JoystickUI', label: 'Joystick', kind: 'ui_marker', position: [-4, 0, 5.4], visual: { primitive: 'box', color: '#ffffff' } },
    ],
    resources: [{ id: 'Gem', label: 'Gem', carrierEntity: 'Gem', kind: 'resource', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: 'Collect gem',
        guideText: 'Collect gem',
        showEntities: ['Player', 'Gem', 'JoystickUI'],
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
var parityOut = path.join(tmp, 'guide-parity-out');
fs.mkdirSync(path.join(parityOut, 'blueprint-smoke'), { recursive: true });
fs.writeFileSync(path.join(parityOut, 'source-ir.json'), JSON.stringify(sourceIr, null, 2));
fs.writeFileSync(path.join(parityOut, 'playable-scene-ir.json'), JSON.stringify({ phases: sourceIr.phases }, null, 2));
fs.writeFileSync(path.join(parityOut, 'index.html'), [
  '<!doctype html><html><body><script>',
  'window.__BLUEPRINT_PLAYABLE_SCENE_IR__ = ' + JSON.stringify({ phases: sourceIr.phases }) + ';',
  '</script></body></html>',
].join('\n'));
fs.writeFileSync(path.join(parityOut, 'blueprint-smoke', 'index.html'), [
  '<!doctype html><html><body><script>',
  'window.__BLUEPRINT_PLAYABLE_SCENE_IR__ = ' + JSON.stringify({ phases: sourceIr.phases }) + ';',
  '</script></body></html>',
].join('\n'));
assert.strictEqual(sourceIrBuild.assertSourceGuideTextParity(sourceIr, parityOut, { blueprintSmoke: path.join(parityOut, 'blueprint-smoke') }).passed, true);
var parityMismatchOut = path.join(tmp, 'guide-parity-mismatch-out');
fs.mkdirSync(path.join(parityMismatchOut, 'blueprint-smoke'), { recursive: true });
fs.writeFileSync(path.join(parityMismatchOut, 'source-ir.json'), JSON.stringify(sourceIr, null, 2));
fs.writeFileSync(path.join(parityMismatchOut, 'playable-scene-ir.json'), JSON.stringify({ phases: sourceIr.phases }, null, 2));
var driftedPhases = JSON.parse(JSON.stringify(sourceIr.phases));
driftedPhases[0].guideText = 'Wrong WebGL guide';
fs.writeFileSync(path.join(parityMismatchOut, 'index.html'), [
  '<!doctype html><html><body><script>',
  'window.__BLUEPRINT_PLAYABLE_SCENE_IR__ = ' + JSON.stringify({ phases: driftedPhases }) + ';',
  '</script></body></html>',
].join('\n'));
fs.writeFileSync(path.join(parityMismatchOut, 'blueprint-smoke', 'index.html'), [
  '<!doctype html><html><body><script>',
  'window.__BLUEPRINT_PLAYABLE_SCENE_IR__ = ' + JSON.stringify({ phases: driftedPhases }) + ';',
  '</script></body></html>',
].join('\n'));
assert.throws(function() {
  sourceIrBuild.assertSourceGuideTextParity(sourceIr, parityMismatchOut, { blueprintSmoke: path.join(parityMismatchOut, 'blueprint-smoke') });
}, /Source\/WebGL guideText parity failed/);
var mismatchReport = JSON.parse(fs.readFileSync(path.join(parityMismatchOut, 'source-guide-text-parity-report.json'), 'utf8'));
assert.strictEqual(mismatchReport.passed, false);
assert.ok(mismatchReport.violations.some(function(violation) {
  return violation.code === 'source_webgl_guide_text_mismatch' &&
    violation.carrier === 'webgl.index.__BLUEPRINT_PLAYABLE_SCENE_IR__' &&
    violation.expected === 'Collect gem' &&
    violation.actual === 'Wrong WebGL guide';
}));
var rendererHtmlPath = path.join(tmp, 'renderer.html');
fs.writeFileSync(rendererHtmlPath, buildSourceIrPreviewHtml(sourceIr, {
  html: '<div id="joystick"></div>',
  includeThree: false,
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
assert.strictEqual(rendererSummary.sourcePhaseLivenessPassed, true);
assert.ok(rendererSummary.sourceVisualIrHash);
assert.ok(fs.existsSync(path.join(rendererOut, 'source-ir-build-summary.json')));
assert.ok(fs.existsSync(path.join(rendererOut, 'pipeline-timing.json')));
assert.ok(fs.existsSync(path.join(rendererOut, 'source-ir-debug-plan.json')));
assert.ok(fs.existsSync(path.join(rendererOut, 'source-phase-liveness-report.json')));
assert.ok(fs.existsSync(path.join(rendererOut, 'spec.json')));
assert.ok(fs.existsSync(path.join(rendererOut, 'gameschema.json')));
assert.ok(fs.existsSync(path.join(rendererOut, 'source-visual-ir.json')));
var rendererSemanticSource = JSON.parse(fs.readFileSync(path.join(rendererOut, 'semantic-source.json'), 'utf8'));
assert.strictEqual(rendererSemanticSource.legacyJsInferenceUsed, false);
assert.strictEqual(rendererSemanticSource.sourceIrBuildPassed, true);
assert.strictEqual(rendererSemanticSource.sourceIrPresent, true);
assert.strictEqual(rendererSemanticSource.sourcePhaseLivenessPassed, true);
assert.strictEqual(rendererSemanticSource.sourceVisualIrHash, rendererSummary.sourceVisualIrHash);
var rendererLiveness = JSON.parse(fs.readFileSync(path.join(rendererOut, 'source-phase-liveness-report.json'), 'utf8'));
assert.strictEqual(rendererLiveness.passed, true);
assert.strictEqual(rendererLiveness.summary.staticPassed, true);
assert.strictEqual(rendererLiveness.summary.browserProbePassed, true);
assert.deepStrictEqual(rendererLiveness.summary.completedPhases, ['phase1', 'phase2']);
var rendererTiming = JSON.parse(fs.readFileSync(path.join(rendererOut, 'pipeline-timing.json'), 'utf8'));
assert.strictEqual(rendererTiming.status, 'passed');
assert.ok(rendererTiming.totalMs >= 0);
assert.ok(rendererTiming.stages.some(function(stage) { return stage.id === 'source-ir-preflight'; }));
var rendererDebugPlan = JSON.parse(fs.readFileSync(path.join(rendererOut, 'source-ir-debug-plan.json'), 'utf8'));
assert.strictEqual(rendererDebugPlan.kind, 'blueprint.sourceIrBuild.debugPlan');
assert.strictEqual(rendererDebugPlan.status, 'planned');
assert.ok(rendererDebugPlan.commands.some(function(command) { return command.id === 'source-ir:debug-fast'; }));
var rendererSpec = JSON.parse(fs.readFileSync(path.join(rendererOut, 'spec.json'), 'utf8'));
assert.strictEqual(rendererSpec.meta.semanticSource, 'source-scene-ir');
assert.strictEqual(rendererSpec.meta.legacyJsInferenceUsed, false);
assert.strictEqual(rendererSpec.meta.sourceVisualIrPath, 'source-visual-ir.json');
assert.strictEqual(rendererSpec.meta.sourceVisualIrHash, rendererSummary.sourceVisualIrHash);
var rendererManifest = JSON.parse(fs.readFileSync(path.join(rendererOut, 'asset-manifest.json'), 'utf8'));
assert.strictEqual(rendererManifest.assets.length, 2);
assert.strictEqual(rendererManifest.sourceEntityContract.sourceEntityCount, 3);
assert.strictEqual(rendererManifest.sourceEntityContract.renderableEntityCount, 2);
assert.deepStrictEqual(rendererManifest.sourceEntityContract.hudOnlyEntities, ['JoystickUI']);
assert.deepStrictEqual(rendererManifest.sourceEntityContract.entities, ['Player', 'Gem']);
assert.strictEqual(Object.keys(rendererManifest.sourceEntityContract.entityComposites).length, 2);
assert.strictEqual(rendererManifest.sourceEntityContract.entityComposites.Player.primitiveCount, 1);
assert.ok(rendererManifest.sourceEntityContract.entityComposites.Player.primitives[0].geometry.type);
assert.strictEqual(rendererManifest.sourceEntityContract.worldLabelContract.present, true);
assert.strictEqual(rendererManifest.sourceEntityContract.worldLabelContract.source, 'source-scene-ir');
assert.strictEqual(rendererManifest.sourceEntityContract.worldLabelContract.labels.length, 2);
assert.strictEqual(rendererManifest.sourceEntityContract.worldLabelContract.labels[0].label, 'Player');
assert.strictEqual(rendererManifest.sourceEntityContract.worldLabelContract.labels.some(function(item) { return item.id === 'JoystickUI'; }), false);
assert.strictEqual(rendererManifest.sourceEntityContract.worldLabelContract.labels.some(function(item) { return item.id === 'CtaButton'; }), false);
assert.strictEqual(rendererManifest.entityBindings.Player.visualFallback, 'source-scene-ir-procedural');
assert.strictEqual(Object.keys(rendererManifest.sourceMeshOps).length, 2);
assert.strictEqual(rendererManifest.extractionSummary.entityBindingRate, 1);

var sourceIrJsonPath = path.join(tmp, 'source-ir.json');
writeSourceSceneIr(sourceIrJsonPath, sourceIr);
var jsonOut = path.join(tmp, 'json-out');
var jsonRun = runBuild(sourceIrJsonPath, jsonOut, []);
assert.strictEqual(jsonRun.status, 0, jsonRun.stderr || jsonRun.stdout);
var jsonSummary = JSON.parse(jsonRun.stdout);
assert.strictEqual(jsonSummary.inputKind, 'source-ir-json');
assert.strictEqual(jsonSummary.sourceIrRenderer, null);
assert.strictEqual(jsonSummary.legacyJsInferenceUsed, false);
assert.strictEqual(jsonSummary.sourcePhaseLivenessPassed, true);
assert.ok(fs.existsSync(path.join(jsonOut, 'playable-scene-ir.json')));
assert.ok(fs.existsSync(path.join(jsonOut, 'source-visual-ir.json')));
var jsonLiveness = JSON.parse(fs.readFileSync(path.join(jsonOut, 'source-phase-liveness-report.json'), 'utf8'));
assert.strictEqual(jsonLiveness.passed, true);
assert.strictEqual(jsonLiveness.summary.staticPassed, true);
assert.strictEqual(jsonLiveness.summary.browserProbeSkipped, true);

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
assert.notStrictEqual(allowedRun.status, 0);
assert.ok(/source_ir_liveness_probe_api_missing/.test(allowedRun.stderr), allowedRun.stderr);
assert.strictEqual(fs.existsSync(path.join(allowedOut, 'spec.json')), false);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(allowedOut, 'semantic-source.json'), 'utf8')).sourcePhaseLivenessPassed, false);

var skippedOut = path.join(tmp, 'non-renderer-skipped-out');
var skippedRun = runBuild(nonRendererHtmlPath, skippedOut, ['--allow-non-renderer-html', '--skip-source-liveness']);
assert.strictEqual(skippedRun.status, 0, skippedRun.stderr || skippedRun.stdout);
var skippedSummary = JSON.parse(skippedRun.stdout);
assert.strictEqual(skippedSummary.legacyJsInferenceUsed, false);
assert.strictEqual(skippedSummary.sourcePhaseLivenessPassed, false);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(skippedOut, 'semantic-source.json'), 'utf8')).sourcePhaseLivenessPassed, false);

var legacyHtmlPath = path.join(tmp, 'legacy.html');
fs.writeFileSync(legacyHtmlPath, '<!doctype html><html><body><script>window.PHASES=[];</script></body></html>');
var legacyOut = path.join(tmp, 'legacy-out');
var legacyRun = runBuild(legacyHtmlPath, legacyOut, []);
assert.notStrictEqual(legacyRun.status, 0);
assert.ok(/source_ir_embedded_missing/.test(legacyRun.stderr), legacyRun.stderr);
assert.strictEqual(fs.existsSync(path.join(legacyOut, 'spec.json')), false);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(legacyOut, 'semantic-source.json'), 'utf8')).legacyJsInferenceUsed, false);
var legacyTiming = JSON.parse(fs.readFileSync(path.join(legacyOut, 'pipeline-timing.json'), 'utf8'));
assert.strictEqual(legacyTiming.status, 'failed');
var legacyDebugPlan = JSON.parse(fs.readFileSync(path.join(legacyOut, 'source-ir-debug-plan.json'), 'utf8'));
assert.strictEqual(legacyDebugPlan.status, 'failed');
assert.ok(legacyDebugPlan.gates.some(function(gate) {
  return gate.id === 'source-ir-preflight' && gate.status === 'failed';
}));

console.log('source-ir build CLI tests passed');
