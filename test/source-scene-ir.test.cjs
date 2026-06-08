#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  SOURCE_SCENE_IR_SCHEMA_VERSION,
  assertSourceSceneIrBinding,
  computeSourceSceneIrHash,
  extractSourceSceneIrFromHtml,
  loadSourceSceneIr,
  normalizeSourceSceneIr,
  preflightSourceSceneIrHtml,
  projectSourceSceneIrToLegacy,
  sha256OfString,
  validateSourceSceneIr,
  writeSourceSceneIr,
} = require('../engine/source-scene-ir.cjs');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-scene-ir-'));

function fixtureSourceIr() {
  return normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    project: { name: 'Water Seller', theme: 'farming' },
    scene: {
      backgroundColor: '#071026',
      camera: {
        kind: 'perspective',
        fov: 55,
        position: [0, 8, 12],
        lookAt: [0, 0, 0],
      },
      ground: { kind: 'plane', size: [24, 24], color: '#13233a' },
      lights: [{ kind: 'ambient', color: '#ffffff', intensity: 0.65 }],
    },
    entities: [
      {
        id: 'Player',
        label: 'Player',
        kind: 'player',
        position: [0, 0, 0],
        visual: { primitive: 'capsule', color: '#66ccff' },
      },
      {
        id: 'GoldPile',
        label: 'Gold',
        kind: 'resource',
        position: [4, 0, 0],
        visual: { primitive: 'box', color: '#ffcc33' },
      },
      {
        id: 'CtaButton',
        label: 'Install',
        kind: 'cta',
        position: [7, 0, 0],
        visual: { primitive: 'box', color: '#22cc88' },
      },
    ],
    resources: [{ id: 'Gold', label: 'Gold', carrierEntity: 'GoldPile', kind: 'currency', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: 'Collect gold',
        guideText: 'Move to the gold pile',
        showEntities: ['Player', 'GoldPile'],
        steps: [
          { kind: 'move_to', target: 'GoldPile', radius: 1.2 },
          { kind: 'collect', resource: 'Gold', amount: 5, from: 'GoldPile' },
        ],
        gate: { kind: 'resource', resource: 'Gold', threshold: 5 },
        duration: { min: 10, max: 15 },
        plannedModuleIds: ['player_input_joystick'],
      },
      {
        id: 'phase2',
        title: 'Install',
        guideText: 'Tap install',
        showEntities: ['Player', 'CtaButton'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton' },
        duration: { min: 10, max: 15 },
      },
    ],
    hud: {
      tip: { source: 'phase.guideText' },
      resourceBar: ['Gold'],
      cta: { entity: 'CtaButton', arrivalGated: true },
    },
    runtimeContract: {
      requiresJoystick: true,
      requiresArrivalGate: true,
      forbidAutoplayProgress: true,
    },
  }, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
}

var directIr = fixtureSourceIr();
validateSourceSceneIr(directIr);
assert.strictEqual(directIr.semanticHash, computeSourceSceneIrHash(directIr));
assert.strictEqual(directIr.scene.ground.width, 24);
assert.strictEqual(directIr.scene.ground.depth, 24);
assert.strictEqual(directIr.scene.ground.height, 24);
var repairedInput = JSON.parse(JSON.stringify(directIr));
repairedInput.phases[1].showEntities = ['CtaButton'];
repairedInput.phases[1].steps = [{ kind: 'set_entity_state', entity: 'CtaButton', state: 1 }];
repairedInput.phases[1].gate = { kind: 'entity_state', entity: 'CtaButton', state: 2 };
var repairedIr = normalizeSourceSceneIr(repairedInput, {
  html: '<div id="joystick"></div>',
  generatedAt: '2026-06-07T00:00:00.000Z',
});
assert.ok(repairedIr.phases[1].showEntities.indexOf('Player') >= 0);
assert.strictEqual(repairedIr.phases[1].steps[0].kind, 'cta_finish');
assert.strictEqual(repairedIr.phases[1].steps[0].ctaId, 'CtaButton');
assert.strictEqual(repairedIr.phases[1].gate.kind, 'cta_arrival');
assert.ok(repairedIr.diagnostics.normalizationRepairs.some(function(repair) {
  return repair.code === 'source_ir_phase_player_visibility_repaired' && repair.phaseId === 'phase2';
}));
assert.ok(repairedIr.diagnostics.normalizationRepairs.some(function(repair) {
  return repair.code === 'source_ir_final_cta_step_rewritten' && repair.phaseId === 'phase2';
}));
var directProjection = projectSourceSceneIrToLegacy(directIr);

function buildSourceIrHtml(ir, projection) {
  projection = projection || projectSourceSceneIrToLegacy(ir);
  return [
    '<!doctype html><html><body><div id="joystick"></div><script>',
    'window.__BP_SOURCE_IR__ = ' + JSON.stringify(ir) + ';',
    'window.__BP_SOURCE_IR_HASH__ = "' + ir.semanticHash + '";',
    'const PHASES = ' + JSON.stringify(projection.PHASES) + ';',
    'const ENTITY_STYLE = ' + JSON.stringify(projection.ENTITY_STYLE) + ';',
    'const ENTITY_POSITIONS = ' + JSON.stringify(projection.ENTITY_POSITIONS) + ';',
    'const SCENE_CONFIG = ' + JSON.stringify(projection.SCENE_CONFIG) + ';',
    '</script></body></html>',
  ].join('\n');
}

var directHtmlPath = path.join(tmp, 'direct.html');
var directHtml = buildSourceIrHtml(directIr, directProjection);
fs.writeFileSync(directHtmlPath, directHtml);

var extractedDirect = extractSourceSceneIrFromHtml(directHtml, directHtmlPath, {
  generatedAt: '2026-06-07T01:00:00.000Z',
});
assert.strictEqual(extractedDirect.extraction.carrier, 'window.__BP_SOURCE_IR__');
assert.strictEqual(extractedDirect.extraction.embeddedSourceIrPresent, true);
assert.strictEqual(extractedDirect.semanticHash, directIr.semanticHash);
assert.strictEqual(extractedDirect.source.htmlSha256, sha256OfString(directHtml));

assert.deepStrictEqual(assertSourceSceneIrBinding(extractedDirect, {
  sourceHtmlPath: directHtmlPath,
  sourceHtmlSha256: sha256OfString(directHtml),
}), {
  sourceHtmlPath: path.resolve(directHtmlPath),
  sourceHtmlSha256: sha256OfString(directHtml),
  sourceSceneIrHash: directIr.semanticHash,
});

var projection = projectSourceSceneIrToLegacy(extractedDirect);
assert.strictEqual(projection.PHASES.length, 2);
assert.strictEqual(projection.PHASES[0].trigger.type, 'resource_collected');
assert.strictEqual(projection.ENTITY_STYLE.Player.color, '#66ccff');
assert.deepStrictEqual(projection.ENTITY_POSITIONS.GoldPile, { x: 4, y: 0, z: 0 });
assert.strictEqual(projection.SCENE_CONFIG.camera.fov, 55);

var directPreflight = preflightSourceSceneIrHtml(directHtml, { sourceHtmlPath: directHtmlPath });
assert.strictEqual(directPreflight.passed, true);
assert.strictEqual(directPreflight.summary.embeddedSourceIrPresent, true);
assert.strictEqual(directPreflight.summary.hashMatches, true);
assert.strictEqual(directPreflight.summary.legacyProjectionUsed, false);
assert.strictEqual(directPreflight.summary.projectionParity.PHASES.parseable, true);

var badProjection = JSON.parse(JSON.stringify(directProjection));
badProjection.PHASES[0].guideText = 'Wrong guide';
var badProjectionPreflight = preflightSourceSceneIrHtml(buildSourceIrHtml(directIr, badProjection), {
  sourceHtmlPath: directHtmlPath,
});
assert.strictEqual(badProjectionPreflight.passed, false);
assert.ok(badProjectionPreflight.violations.some(function(violation) {
  return violation.code === 'source_ir_projection_mismatch' && violation.carrier === 'PHASES';
}));

assert.throws(function() {
  extractSourceSceneIrFromHtml(directHtml.replace(
    'window.__BP_SOURCE_IR_HASH__ = "' + directIr.semanticHash + '"',
    'window.__BP_SOURCE_IR_HASH__ = "' + '0'.repeat(64) + '"'
  ), directHtmlPath);
}, /SourceSceneIR hash mismatch/);

var irPath = path.join(tmp, 'source-ir.json');
writeSourceSceneIr(irPath, extractedDirect);
assert.strictEqual(loadSourceSceneIr(irPath).semanticHash, extractedDirect.semanticHash);

assert.throws(function() {
  validateSourceSceneIr(normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    project: { name: 'bad' },
    scene: {},
    entities: [{ id: 'Player' }],
    phases: [
      { id: 'phase1', showEntities: ['MissingEntity'], steps: [], gate: { kind: 'timer', seconds: 1 } },
    ],
  }));
}, /source_ir_phase_show_entity_missing/);

assert.throws(function() {
  validateSourceSceneIr(normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    project: { name: 'bad' },
    scene: {},
    entities: [{ id: 'Player' }, { id: 'CtaButton' }],
    phases: [
      { id: 'phase1', showEntities: ['Player', 'CtaButton'], steps: [{ kind: 'cta_finish', entity: 'CtaButton' }], gate: { kind: 'cta_arrival', entity: 'CtaButton' } },
      { id: 'phase2', showEntities: ['Player'], steps: [], gate: { kind: 'timer', seconds: 1 } },
    ],
  }));
}, /source_ir_non_final_cta/);

assert.throws(function() {
  validateSourceSceneIr(normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    project: { name: 'bad' },
    scene: {},
    entities: [{ id: 'Player' }],
    phases: [
      { id: 'phase1', showEntities: ['Player'], gate: { kind: 'timer', seconds: 1 } },
      { id: 'phase3', showEntities: ['Player'], gate: { kind: 'timer', seconds: 1 } },
    ],
  }));
}, /source_ir_phase_id_not_sequential/);

var legacyHtmlPath = path.join(tmp, 'legacy.html');
var legacyHtml = [
  '<!doctype html><html><head><title>Legacy fixture</title></head><body>',
  '<div id="joystick"></div>',
  '<script>',
  'const SCENE_CONFIG = { backgroundColor:"#112233", camera:{ fov:50, position:[0,22,18], lookAt:[0,0,0] }, ground:{kind:"plane", width:12, height:12, color:"#445566"}, ambientLight:{color:"#ffffff",intensity:.6} };',
  'const ENTITY_STYLE = { Player:{label:"Player",kind:"hero",color:"#66ccff"}, WaterDrop:{label:"Water",kind:"resource",color:"#33aaff"}, CtaButton:{label:"Install",kind:"cta",color:"#22cc88"} };',
  'const ENTITY_POSITIONS = { Player:{x:1,y:0,z:2}, WaterDrop:{x:4,y:0,z:2}, CtaButton:{x:7,y:0,z:2} };',
  'const PHASES = [',
  '  { id:"phase1", guideText:"Collect water", showEntities:["Player","WaterDrop"], plannedModuleIds:["player_input_joystick"], steps:[{target:"WaterDrop",label:"Water",gain:"Water",amount:3}], trigger:{type:"resource_collected",resource:"Water",amount:3} },',
  '  { id:"phase2", guideText:"Install", showEntities:["Player","CtaButton"], trigger:{type:"click_entity",entity:"CtaButton"} }',
  '];',
  '</script>',
  '</body></html>',
].join('\n');
fs.writeFileSync(legacyHtmlPath, legacyHtml);

var legacyIr = extractSourceSceneIrFromHtml(legacyHtml, legacyHtmlPath, {
  generatedAt: '2026-06-07T02:00:00.000Z',
});
assert.strictEqual(legacyIr.extraction.carrier, 'legacy-html-contract');
assert.strictEqual(legacyIr.extraction.legacyProjectionUsed, true);
assert.strictEqual(legacyIr.scene.backgroundColor, '#112233');
assert.deepStrictEqual(legacyIr.scene.camera.position, [0, 22, 18]);
assert.ok(legacyIr.entities.some(function(entity) {
  return entity.id === 'WaterDrop' && entity.position[0] === 4;
}));
assert.strictEqual(legacyIr.resources[0].id, 'Water');
assert.strictEqual(legacyIr.phases[0].steps[0].kind, 'collect');
assert.strictEqual(legacyIr.phases[0].gate.kind, 'resource');
assert.strictEqual(legacyIr.phases[1].gate.kind, 'cta_arrival');

var playableHtmlPath = path.join(tmp, 'playable.html');
var playableHtml = [
  '<!doctype html><html><body><div id="joystick"></div><script>',
  'window.__BLUEPRINT_PLAYABLE_SCENE_IR__ = {',
  '  schemaVersion:"1.0.0", kind:"blueprint.playableSceneIR", project:"playable-fixture",',
  '  source:{htmlPath:"/tmp/source.html",htmlSha256:"' + '1'.repeat(64) + '"},',
  '  scene:{backgroundColor:"#101820",camera:{position:[0,8,12],lookAt:[0,0,0]}},',
  '  entities:[{name:"Player",label:"Player",kind:"hero",position:{x:0,y:0,z:0}},{name:"CtaButton",label:"Install",kind:"cta",position:{x:2,y:0,z:0}}],',
  '  phases:[{id:"phase1",guideText:"Install",showEntities:["Player","CtaButton"],trigger:{type:"click_entity",entity:"CtaButton"}}],',
  '  semanticHash:"' + '2'.repeat(64) + '"',
  '};',
  '</script></body></html>',
].join('\n');
fs.writeFileSync(playableHtmlPath, playableHtml);
var playableIr = extractSourceSceneIrFromHtml(playableHtml, playableHtmlPath);
assert.strictEqual(playableIr.extraction.carrier, 'window.__BLUEPRINT_PLAYABLE_SCENE_IR__');
assert.strictEqual(playableIr.phases[0].gate.kind, 'cta_arrival');
assert.strictEqual(playableIr.hud.cta.ctaId, 'CtaButton');
assert.ok(!playableIr.entities.some(function(entity) { return entity.id === 'CtaButton'; }));

var preflight = preflightSourceSceneIrHtml(legacyHtml, { sourceHtmlPath: legacyHtmlPath });
assert.strictEqual(preflight.passed, false);
assert.strictEqual(preflight.summary.embeddedSourceIrPresent, false);
assert.strictEqual(preflight.summary.legacyProjectionUsed, true);
assert.ok(preflight.violations.some(function(violation) { return violation.code === 'source_ir_embedded_missing'; }));
assert.ok(preflight.violations.some(function(violation) { return violation.code === 'source_ir_declared_hash_missing'; }));
assert.ok(preflight.violations.some(function(violation) { return violation.code === 'source_ir_legacy_projection_forbidden'; }));

var legacyAllowedPreflight = preflightSourceSceneIrHtml(legacyHtml, {
  sourceHtmlPath: legacyHtmlPath,
  requireEmbeddedSourceIr: false,
  requireDeclaredHash: false,
  forbidLegacyProjection: false,
});
assert.strictEqual(legacyAllowedPreflight.passed, true);
assert.strictEqual(legacyAllowedPreflight.warnings[0].code, 'source_ir_embedded_missing');

var reportPath = path.join(tmp, 'preflight-report.json');
childProcess.execFileSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'source-scene-ir-preflight.cjs'),
  directHtmlPath,
  reportPath,
], { stdio: 'pipe' });
var report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.strictEqual(report.passed, true);
assert.strictEqual(report.summary.phaseCount, 2);
assert.strictEqual(report.summary.joystickEvidencePresent, true);

var legacyCliReportPath = path.join(tmp, 'legacy-preflight-report.json');
var legacyCli = childProcess.spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'source-scene-ir-preflight.cjs'),
  legacyHtmlPath,
  legacyCliReportPath,
], { encoding: 'utf8' });
assert.notStrictEqual(legacyCli.status, 0);
var legacyCliReport = JSON.parse(fs.readFileSync(legacyCliReportPath, 'utf8'));
assert.strictEqual(legacyCliReport.passed, false);
assert.ok(legacyCliReport.violations.some(function(violation) { return violation.code === 'source_ir_legacy_projection_forbidden'; }));

console.log('source scene IR tests passed');
