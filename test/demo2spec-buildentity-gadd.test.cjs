#!/usr/bin/env node
'use strict';

const assert = require('assert');
const visualAssets = require('../adapters/demo2spec/visual-assets.js');

const html = [
  '<!doctype html><html><body><script>',
  'const ENTITY_STYLE = {',
  '  PlayerCharacter: { kind: "astronaut", label: "玩家角色", color: 0x3399ff },',
  '  Ballista1: { kind: "machine", label: "弩炮1", color: 0x5577aa }',
  '};',
  'const ENTITY_POSITIONS = {',
  '  PlayerCharacter: { x: 0, y: 0, z: 0 },',
  '  Ballista1: { x: 5, y: 0, z: -3 }',
  '};',
  'const PHASES = [{ id: "phase1", showEntities: ["PlayerCharacter", "Ballista1"] }];',
  'var models = {};',
  'function buildEntity(name){',
  '  var style = ENTITY_STYLE[name];',
  '  var kind = style.kind;',
  '  var col = style.color;',
  '  var g = new THREE.Group();',
  '  if(kind === "astronaut"){',
  '    var head = new THREE.Mesh(new THREE.SphereGeometry(.28,12,12), new THREE.MeshStandardMaterial({color: col}));',
  '    head.position.y = 1.3; g.add(head);',
  '  } else if(kind === "machine"){',
  '    var base2 = new THREE.Mesh(new THREE.BoxGeometry(1.1,.42,1.1), new THREE.MeshStandardMaterial({color: col}));',
  '    base2.position.y = .21; g.add(base2);',
  '  }',
  '  models[name] = g;',
  '}',
  'Object.keys(ENTITY_STYLE).forEach(buildEntity);',
  '</script></body></html>',
].join('\n');

const manifest = visualAssets.extractVisualAssetManifest(html, {
  source: 'inline-buildentity-gadd.html',
  entityNames: ['PlayerCharacter', 'Ballista1'],
});

assert.strictEqual(manifest.sourceEntityContract.entities.length, 2);
assert.ok(manifest.entityBindings.PlayerCharacter, 'PlayerCharacter should bind through g.add(localMesh)');
assert.ok(manifest.entityBindings.Ballista1, 'Ballista1 should bind through g.add(localMesh)');
assert.ok(manifest.entityBindings.PlayerCharacter.assetIds.length > 0);
assert.ok(manifest.assets.some(asset => asset.source && asset.source.pattern === 'buildEntity:group.add-local-mesh'));
const ballistaPrimitive = manifest.assets.find(asset => asset.kind === 'procedural_primitive' && asset.source && asset.source.entityName === 'Ballista1');
assert.ok(ballistaPrimitive, 'Ballista1 primitive should be extracted');
assert.strictEqual(ballistaPrimitive.material.diffuseColor, '#5577AA', 'buildEntity material variable should resolve to ENTITY_STYLE color');
assert.strictEqual(manifest.extractionSummary.entityBindingRate, 1);

const matFactoryHtml = [
  '<!doctype html><html><body><script>',
  'const ENTITY_STYLE = { SecondArea: { kind: "area", label: "第二区域", color: 0x30664b } };',
  'const ENTITY_POSITIONS = { SecondArea: { x: 5, y: 0, z: 2 } };',
  'const PHASES = [{ id: "phase1", showEntities: ["SecondArea"] }];',
  'var models = {};',
  'function mat(color,opacity,emissive){return new THREE.MeshStandardMaterial({color:color,roughness:.55,metalness:.1,transparent:opacity<1,opacity:opacity,emissive:emissive||0x000000});}',
  'function buildEntity(name){',
  '  var style = ENTITY_STYLE[name]; var kind = style.kind; var c = style.color; var g = new THREE.Group();',
  '  if(kind === "area"){ var ar = new THREE.Mesh(new THREE.BoxGeometry(6,.22,6), mat(c,.5,0x063116)); ar.position.y = .07; g.add(ar); }',
  '  models[name] = g;',
  '}',
  'Object.keys(ENTITY_STYLE).forEach(buildEntity);',
  '</script></body></html>',
].join('\n');
const matFactoryManifest = visualAssets.extractVisualAssetManifest(matFactoryHtml, {
  source: 'inline-mat-factory.html',
  entityNames: ['SecondArea'],
});
const areaPrimitive = matFactoryManifest.assets.find(asset => asset.kind === 'procedural_primitive' && asset.source && asset.source.entityName === 'SecondArea');
assert.ok(areaPrimitive, 'SecondArea primitive should be extracted from mat factory');
assert.strictEqual(areaPrimitive.material.diffuseColor, '#30664B');
assert.strictEqual(areaPrimitive.material.opacity, 0.5);
assert.strictEqual(areaPrimitive.material.transparent, true);
assert.strictEqual(areaPrimitive.material.emissiveColor, '#063116');

const meshOpsHtml = [
  '<!doctype html><html><body><script>',
  'const ENTITY_STYLE = { Player: { kind: "astronaut", label: "玩家", color: 0x3399ff }, Crate: { kind: "boxpile", label: "箱子", color: 0xaa7733 } };',
  'const ENTITY_POSITIONS = { Player: { x: 0, y: 0, z: 0 }, Crate: { x: 3, y: 0, z: 1 } };',
  'const PHASES = [{ id: "phase1", showEntities: ["Player", "Crate"] }];',
  'var meshOps = {',
  '  Player: [{ kind: "sphere", position: [0, 1.2, 0], size: [.3], color: 0x3399ff }],',
  '  Crate: [{ kind: "box", position: [0, .4, 0], size: [1, .8, 1], color: 0xaa7733 }]',
  '};',
  'var models = {};',
  'function buildFromOps(name,g){ (meshOps[name] || []).forEach(function(op){ g.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color: op.color}))); }); }',
  'function buildEntity(name){ var style = ENTITY_STYLE[name]; var kind = style.kind; var g = new THREE.Group(); models[name] = g; if(kind === "astronaut"){ buildFromOps(name,g); } else { buildFromOps(name,g); } }',
  'Object.keys(ENTITY_STYLE).forEach(buildEntity);',
  '</script></body></html>',
].join('\n');

const meshOpsManifest = visualAssets.extractVisualAssetManifest(meshOpsHtml, {
  source: 'inline-meshops.html',
  entityNames: ['Player', 'Crate'],
});
assert.strictEqual(meshOpsManifest.entityBindings.Player.visualFallback, null);
assert.strictEqual(meshOpsManifest.entityBindings.Crate.visualFallback, null);
assert.ok(meshOpsManifest.assets.some(asset => asset.source && asset.source.pattern === 'meshOps:entity-composite'));
assert.strictEqual(meshOpsManifest.extractionSummary.entityBindingRate, 1);

console.log('demo2spec buildEntity g.add tests passed');
