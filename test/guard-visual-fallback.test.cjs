#!/usr/bin/env node
'use strict';

var assert = require('assert');
var path = require('path');

var pdfSamples = require('../scripts/process-storyboard-pdf-samples.cjs');
var storyboardIr = require('../engine/storyboard-ir.cjs');
var storyboardSpecCompiler = require('../engine/storyboard-spec-compiler.cjs');
var storyboardSourceIrCompiler = require('../engine/storyboard-source-ir-compiler.cjs');

var internals = pdfSamples._internals;
var rows = Array.from({ length: 23 }).map(function(_, index) {
  return {
    index: index + 1,
    cropPath: path.join('/tmp', 'guard-row-' + String(index + 1).padStart(2, '0') + '.jpg'),
  };
});

assert.strictEqual(internals.themeForKind('guard'), 'space');

var frames = internals.buildGuardVisualFallbackFrames({ rows: rows });
assert.strictEqual(frames.length, 23);
assert.ok(frames.every(function(frame) { return frame.interaction; }), 'guard fallback frames must keep every row actionable');
assert.ok(frames.every(function(frame) { return frame.parserFallback === internals.GUARD_HOME_VISUAL_FALLBACK_VERSION; }));
assert.deepStrictEqual(frames[2].visibleEntities, ['Player', 'WaterTank', 'CornField', 'ShipCabin']);
assert.ok(frames[21].visibleEntities.indexOf('HeroTower') >= 0);
assert.ok(frames[21].visibleEntities.indexOf('Spore') >= 0);
assert.strictEqual(frames[22].interaction, 'click:CtaButton');

var entities = internals.entitiesForKind('guard');
var resources = internals.resourcesForKind('guard');
assert.deepStrictEqual(resources.map(function(resource) { return resource.id + ':' + resource.carrierEntity; }), [
  'Ice:IceChunk',
  'Corn:CornField',
  'Popcorn:PopcornMachine',
  'Coin:PopcornStand',
]);
var ir = storyboardIr.normalizeStoryboardIr({
  projectName: '守护家园',
  themeHint: 'space',
  storyboardFrames: frames,
  entities: entities,
}, {
  projectName: '守护家园',
  theme: 'space',
  entities: entities,
});

assert.strictEqual(ir.frames.length, 23);
assert.strictEqual(ir.project.theme, 'space');
assert.strictEqual(ir.diagnostics.length, 0);

var compiled = storyboardSpecCompiler.compileSpecsFromStoryboardIr(ir, {
  entities: entities,
  minActionCoverage: 1,
});
assert.strictEqual(compiled.ok, true);
assert.strictEqual(compiled.summary.phaseCount, 23);
assert.strictEqual(compiled.summary.actionCoverage, 1);
assert.deepStrictEqual(compiled.specs[22].requiredInteractions, ['click:CtaButton']);
assert.ok(compiled.specs[2].visibleEntities.length > 2, 'guard spec must keep storyboard-visible entities');
assert.ok(compiled.specs[2].entitiesRequired.some(function(entity) { return entity.name === 'ShipCabin'; }));

var sourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard({
  projectName: '守护家园',
  themeHint: 'space',
  entities: entities,
  resources: resources,
  specs: compiled.specs,
  storyboardIr: ir,
});
assert.strictEqual(sourceIr.project.theme, 'space');
assert.strictEqual(sourceIr.phases.length, 23);
assert.strictEqual(sourceIr.hud.domHudContract.present, true);
assert.strictEqual(sourceIr.hud.domHudContract.ids.tip, 'tip');
assert.strictEqual(sourceIr.hud.domHudContract.ids.targetHint, 'targetHint');
assert.strictEqual(sourceIr.hud.domHudContract.ids.joystick, 'joystick');
assert.strictEqual(sourceIr.phases[22].gate.kind, 'cta_arrival');
assert.deepStrictEqual(sourceIr.phases[2].showEntities.slice(0, 4), ['Player', 'WaterTank', 'CornField', 'ShipCabin']);
assert.ok(sourceIr.phases[21].showEntities.indexOf('HeroTower') >= 0);
assert.ok(sourceIr.phases[21].showEntities.indexOf('Spore') >= 0);
assert.ok(sourceIr.resources.some(function(resource) { return resource.id === 'Ice' && resource.carrierEntity === 'IceChunk'; }));
assert.ok(sourceIr.resources.some(function(resource) { return resource.id === 'Corn' && resource.carrierEntity === 'CornField'; }));
assert.ok(sourceIr.resources.some(function(resource) { return resource.id === 'Coin' && resource.carrierEntity === 'PopcornStand'; }));
assert.ok(sourceIr.entities.some(function(entity) { return entity.id === 'HeroTower'; }));
var sourceEntityById = {};
sourceIr.entities.forEach(function(entity) {
  sourceEntityById[entity.id] = entity;
});
assert.strictEqual(sourceEntityById.Player.kind, 'player');
assert.notStrictEqual(sourceEntityById.HeroTower.kind, 'player', 'HeroTower must not be classified as the player');
assert.ok(Math.abs(sourceEntityById.HeroTower.position[0]) > 5 || Math.abs(sourceEntityById.HeroTower.position[2]) > 5, 'HeroTower should be placed away from the player origin');
var worldEntities = sourceIr.entities.filter(function(entity) {
  return !/cta|ui_marker|hud/i.test(entity.kind || '') && !/CtaButton/i.test(entity.id);
});
var nearest = { distance: Infinity, pair: [] };
for (var wi = 0; wi < worldEntities.length; wi += 1) {
  for (var wj = wi + 1; wj < worldEntities.length; wj += 1) {
    var a = worldEntities[wi];
    var b = worldEntities[wj];
    var dx = Number(a.position[0]) - Number(b.position[0]);
    var dz = Number(a.position[2]) - Number(b.position[2]);
    var distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < nearest.distance) nearest = { distance: distance, pair: [a.id, b.id] };
  }
}
assert.ok(nearest.distance >= 3.2, 'storyboard SourceIR layout too dense: ' + nearest.pair.join('/') + ' distance=' + nearest.distance.toFixed(2));
assert.ok(sourceIr.scene.ground.size[0] >= 42 && sourceIr.scene.ground.size[1] >= 42, 'guard map should be larger than the old compact 22x22 scene');
assert.strictEqual(sourceIr.scene.ground.width, sourceIr.scene.ground.size[0]);
assert.strictEqual(sourceIr.scene.ground.height, sourceIr.scene.ground.size[1]);
assert.ok(sourceIr.scene.camera.position[1] >= 16 && sourceIr.scene.camera.position[2] >= 24, 'camera should widen for the larger generated map');

console.log('guard visual fallback tests passed');
