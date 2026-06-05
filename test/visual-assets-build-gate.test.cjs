#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var helpers = require('../engine/helpers.cjs');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-visual-assets-gate-'));
var sourceHtmlPath = path.join(tmpDir, 'source.html');

fs.writeFileSync(sourceHtmlPath, [
  '<!doctype html><html><body><script>',
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

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('visual-assets build gate tests passed');
