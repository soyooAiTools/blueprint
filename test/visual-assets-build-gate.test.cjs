#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var helpers = require('../engine/helpers.cjs');
var visualAssets = require('../adapters/demo2spec/visual-assets.js');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-visual-assets-gate-'));
var sourceHtmlPath = path.join(tmpDir, 'source.html');

fs.writeFileSync(sourceHtmlPath, [
  '<!doctype html><html><head><style>',
  '#hud{position:fixed;top:0;left:0;right:0;height:52px;background:rgba(0,0,0,0.6);display:flex}',
  '#goldIcon{width:24px;height:24px;background:radial-gradient(circle,#ffe45c,#f0a000);border-radius:50%}',
  '#goldCount{color:#ffe45c;font-weight:bold;font-size:18px;min-width:40px}',
  '#tip{flex:1;text-align:center;color:#8deaff;font-size:13px}',
  '#phaseLabel{color:#fff;font-size:12px;opacity:0.7}',
  '#targetHint{position:fixed;top:56px;left:50%;transform:translateX(-50%);color:#ffe45c}',
  '</style></head><body>',
  '<div id="hud"><div id="goldIcon"></div><div id="goldCount">50</div><div id="tip">欢迎！用摇杆移动宇航员</div><div id="phaseLabel">Phase 1/1</div></div>',
  '<div id="targetHint"></div>',
  '<script>',
  'var camera = new THREE.PerspectiveCamera(50, innerWidth/innerHeight, 0.1, 200);',
  'camera.position.set(0, 22, 18); camera.lookAt(0, 0, 0);',
  'var gridHelper = new THREE.GridHelper(60, 30, 0x223344, 0x1a2233);',
  'const ENTITY_STYLE = {',
  '  Player: { kind: "astronaut", label: "玩家角色", color: 0x4fc3f7 },',
  '  IceBlock: { kind: "ice", label: "冰晶", color: "#66ccff" }',
  '};',
  'const ENTITY_POSITIONS = {',
  '  Player: { x: 0, y: 0, z: 1 },',
  '  IceBlock: { x: 2, y: 0, z: 3 }',
  '};',
  'const PHASES = [{',
  '  id: "phase1",',
  '  name: "初始需求引导",',
  '  guideText: "靠近冰晶采集",',
  '  goalText: "采集 1 块冰",',
  '  showEntities: ["Player", "IceBlock"],',
  '  steps: [{ target: "IceBlock", label: "采冰" }]',
  '}];',
  '</script></body></html>',
].join('\n'), 'utf8');

var baseCtx = {
  taskId: 'visual-assets-build-gate',
  sourceHtmlPath: sourceHtmlPath,
  blueprint: {
    sourceHtmlPath: sourceHtmlPath,
    entities: [{ name: 'Player' }, { name: 'IceBlock' }],
  },
  addLog: function() {},
};

assert.throws(function() {
  helpers.buildVisualAssetsForRequest(baseCtx);
}, /no fidelityContract is available/, 'source-bound build must fail closed without fidelityContract');

var ctx = JSON.parse(JSON.stringify(baseCtx));
ctx.addLog = function() {};
ctx.blueprint.fidelityContract = {
  schemaVersion: '1.2.0',
  kind: 'blueprint.fidelityContract',
  phases: [
    {
      id: 'phase1',
      projectedAnchors: {
        Player: { x_px: 100, y_px: 120, w_px: 60, h_px: 80 },
        IceBlock: {
          x_px: 0, y_px: 0, w_px: 0, h_px: 0,
          provenance: 'inferred-default',
          lookupPath: 'not-found',
          resolverRule: 'unresolved',
        },
      },
    },
  ],
  entities: [
    { id: 'Player', worldLabel: { text: '玩家角色', worldOffset: { y: 1.5 } } },
    { id: 'IceBlock', worldLabel: { text: '冰晶', worldOffset: { y: 1.5 } } },
  ],
};

var manifest = helpers.buildVisualAssetsForRequest(ctx);
assert.ok(manifest, 'manifest should be synthesized');
assert.strictEqual(manifest.sourceEntityContract.entities.length, 2);
assert.strictEqual(manifest.sourceEntityContract.entityStyles.Player.label, '玩家角色');
assert.deepStrictEqual(manifest.sourceSceneContract.camera.position, [0, 22, 18]);
assert.deepStrictEqual(manifest.sourceSceneContract.camera.lookAt, [0, 0, 0]);
assert.strictEqual(manifest.sourceSceneContract.camera.fov, 50);
assert.strictEqual(manifest.sourceSceneContract.grid.present, true);
assert.strictEqual(manifest.sourceSceneContract.grid.size, 60);
assert.strictEqual(manifest.sourceSceneContract.grid.divisions, 30);
assert.strictEqual(manifest.sourceSceneContract.grid.colorCenterLine, '#223344');
assert.strictEqual(manifest.sourceEntityContract.domHudContract.present, true);
assert.strictEqual(manifest.sourceEntityContract.domHudContract.initialText.goldCount, '50');
assert.strictEqual(manifest.sourceEntityContract.domHudContract.initialText.tip, '欢迎！用摇杆移动宇航员');
assert.ok(manifest.sourceEntityContract.domHudContract.css.hud.indexOf('position:fixed') >= 0);
assert.strictEqual(manifest.sourcePhaseContract.phases.length, 1);
assert.strictEqual(Object.keys(manifest.entityBindings).length, 2);
assert.ok(manifest.fidelityContract, 'fidelityContract should be merged into build manifest');
assert.ok(manifest.fidelityContract.phases[0].projectedAnchors.Player, 'valid anchor should be retained');
assert.strictEqual(
  manifest.fidelityContract.phases[0].projectedAnchors.IceBlock,
  undefined,
  'inferred/default unresolved 0x0 anchor must be stripped before build injection'
);

var invalidOnlyCtx = JSON.parse(JSON.stringify(baseCtx));
invalidOnlyCtx.addLog = function() {};
invalidOnlyCtx.blueprint.fidelityContract = {
  schemaVersion: '1.2.0',
  kind: 'blueprint.fidelityContract',
  phases: [
    {
      id: 'phase1',
      projectedAnchors: {
        Player: {
          x_px: 0, y_px: 0, w_px: 0, h_px: 0,
          provenance: 'inferred-default',
          lookupPath: 'not-found',
          resolverRule: 'unresolved',
        },
      },
    },
  ],
  entities: [{ id: 'Player' }],
};
var invalidOnlyManifest = helpers.buildVisualAssetsForRequest(invalidOnlyCtx);
assert.deepStrictEqual(
  invalidOnlyManifest.fidelityContract.phases[0].projectedAnchors,
  {},
  'all-invalid projectedAnchors should sanitize to an empty map instead of forcing bogus origin anchors'
);

var playerGroupHtml = [
  '<!doctype html><html><body><script>',
  'const ENTITY_STYLE = {',
  '  OurAstronaut: { kind: "astronaut", label: "我方宇航员", color: 0x60a5fa },',
  '  EnemyShip: { kind: "ship", label: "敌方战舰", color: 0xef4444 }',
  '};',
  'const ENTITY_POSITIONS = {',
  '  OurAstronaut: { x: -5, y: 0, z: 0 },',
  '  EnemyShip: { x: 8, y: 0, z: 0 }',
  '};',
  'var playerGroup = new THREE.Group();',
  'var bodyMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,1,8), new THREE.MeshStandardMaterial({color:0x60a5fa}));',
  'var headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.32,8,8), new THREE.MeshStandardMaterial({color:0xe0f2fe}));',
  'playerGroup.add(bodyMesh); playerGroup.add(headMesh);',
  'playerGroup.position.set(-5,0,0); scene.add(playerGroup);',
  'function buildEntity(name){',
  '  var style = ENTITY_STYLE[name]; var g = new THREE.Group();',
  '  var kind = style.kind;',
  '  if(kind === "ship"){',
  '    var sm = new THREE.Mesh(new THREE.ConeGeometry(2,4,8), new THREE.MeshStandardMaterial({color:style.color}));',
  '    g.add(sm);',
  '  } else {',
  '    var dm = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:style.color}));',
  '    g.add(dm);',
  '  }',
  '  models[name]=g;',
  '}',
  '</script></body></html>',
].join('\n');
var playerEntityNames = visualAssets.collectEntityNamesFromHtml(playerGroupHtml);
var playerManifest = visualAssets.extractVisualAssetManifest(playerGroupHtml, {
  source: path.join(tmpDir, 'player-group.html'),
  project: 'player-group-fixture',
  entityNames: playerEntityNames,
});
assert.strictEqual(
  playerManifest.assets.some(function(asset) { return asset.assetId === 'asset_g'; }),
  false,
  'buildEntity local group g must not be counted as a standalone unbound asset'
);
['asset_bodyMesh', 'asset_headMesh', 'asset_playerGroup'].forEach(function(assetId) {
  var asset = playerManifest.assets.find(function(item) { return item.assetId === assetId; });
  assert.ok(asset, assetId + ' missing');
  assert.strictEqual(asset.entityBinding.entityName, 'OurAstronaut', assetId + ' should bind to semantic player entity');
});
assert.strictEqual(
  visualAssets.validateVisualAssetReadiness(playerManifest, {
    expectedEntities: playerEntityNames,
    minAssetBindingRate: 0.9,
    minEntityBindingRate: 0.7,
    minExpectedEntityCoverageRate: 0.9,
  }).passed,
  true,
  'global playerGroup meshes should not fail asset binding readiness'
);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('visual-assets build gate tests passed');
