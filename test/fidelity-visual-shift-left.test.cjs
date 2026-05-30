#!/usr/bin/env node
'use strict';

var assert = require('assert');
var shiftLeft = require('../engine/fidelity-visual-shift-left.cjs');

function vec(x, y, z) { return { x: x, y: y, z: z }; }
function transform(x, y, z) {
  return { localPosition: vec(x, y, z), localRotation: vec(0, 0, 0), localScale: vec(1, 1, 1) };
}
function prim(id, x) {
  return {
    id: id,
    name: id,
    parentPath: '/Player',
    transform: transform(x, 0, 0),
    pivot: vec(0, 0, 0),
    bounds: { center: vec(x, 0, 0), size: vec(1, 1, 1) },
    mesh: { type: 'BoxGeometry', args: [1, 1, 1] },
    material: {
      id: 'mat.' + id,
      guid: 'guid-' + id,
      shader: 'URP/Lit',
      colors: { _Color: [1, 1, 1, 1], _ColorTint: [1, 1, 1, 1], _EmissionColor: [0, 0, 0, 1] }
    }
  };
}
function contract(overrides) {
  var base = {
    phases: [{ id: 'phase1', showEntities: ['Player'], trigger: { type: 'steps_complete' } }],
    hud: [{ id: 'hud.coin', slot: 'Coin', role: 'hud-slot', text: '金币 0', anchor: { x: 1, y: 2 }, style: { fontSize: 16 } }],
    entities: [{
      id: 'Player',
      name: 'Player',
      parentPath: '/SceneRoot',
      transform: transform(0, 0, 0),
      pivot: vec(0, 0, 0),
      bounds: { center: vec(0, 0, 0), size: vec(2, 1, 1) },
      primitives: [prim('SourcePrimitive_Player_00', 0), prim('SourcePrimitive_Player_01', 1)]
    }]
  };
  return Object.assign(base, overrides || {});
}

var source = contract();
var identical = contract();
var pass = shiftLeft.buildVisualShiftLeftDiff(source, identical, { phase: 'phase1' });
assert.strictEqual(pass.summary.passed, true);
assert.strictEqual(pass.summary.diffCount, 0);
assert.strictEqual(pass.source.compositionRoots.Player.primitiveCount, 2);

var folded = contract({
  hud: [{ id: 'hud.gold', slot: 'Gold', role: 'hud-slot', text: 'Gold: 1', anchor: { x: 99, y: 2 }, style: { fontSize: 20 } }],
  entities: [{
    id: 'Player',
    name: 'Player',
    parentPath: '/SceneRoot',
    transform: transform(0, 0, 0),
    pivot: vec(0, 0, 0),
    bounds: { center: vec(0, 0, 0), size: vec(2, 1, 1) },
    primitives: [prim('SourcePrimitive_Player_00', 0)]
  }]
});
var fail = shiftLeft.buildVisualShiftLeftDiff(source, folded, { phase: 'phase1' });
assert.strictEqual(fail.summary.passed, false);
assert.ok(fail.diffs.some(function(diff) { return diff.path === 'hudSlots.Coin' && diff.category === 'missing-hud'; }));
assert.ok(fail.diffs.some(function(diff) { return diff.path === 'compositionRoots.Player.primitiveCount' && diff.category === 'composition-divergence'; }));
assert.ok(fail.diffs.some(function(diff) { return diff.path === 'compositionRoots.Player.primitives.SourcePrimitive_Player_01' && diff.category === 'missing-primitive'; }));

console.log('fidelity visual shift-left tests passed');
