#!/usr/bin/env node
'use strict';

// Storyboard visual overlay must not depend on the legacy PlayCanvas "model"
// component system. Luna builds expose Unity primitive + renderer paths, and
// missing legacy model system previously aborted the whole overlay.

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var workerPath = path.join(__dirname, '..', 'worker', 'linux-bridge-build.js');
var src = fs.readFileSync(workerPath, 'utf8');

assert.strictEqual(src.indexOf("addComponent('model'"), -1,
  'overlay fallback must not call missing legacy PlayCanvas model system');
assert.strictEqual(src.indexOf('addComponent("model"'), -1,
  'overlay fallback must not call missing legacy PlayCanvas model system');

[
  'function createUnityPrimitiveEntity(name, type)',
  'function findPoolRenderable()',
  'function clonePoolMaterial(value, fallback)',
  'function createRendererPrimitiveEntity(parent, name, type)',
  'UnityEngine.GameObject.CreatePrimitive',
  'function createPrimitiveEntity(parent, name, type)',
  'function buildStyledComposite(group, name, primitiveStyle, sourceStyle)',
  'function storyboardSceneBackground()',
  'function applyStoryboardSceneBackground(source)',
  'window.__storyboardSceneDetails',
  "var bgPlane = createPrimitiveEntity(root, 'StoryboardBackground', 'box')",
  'function currentStoryboardTargetLabel(gs, phaseId)',
  'function storyboardEntityLabel(name)',
  'phaseFirstStoryboardTarget(phaseId)',
  "set('bp-storyboard-target', currentStoryboardTargetLabel(gs, 'phase' + phase))",
  'function primitiveStyleForName(name)',
  'window.__storyboardEntityDetails',
  "recordPrimitiveStyle(name, primitiveStyle, 'styled-composite:' + kind, count)",
  "if (kind === 'astronaut')",
  "if (kind === 'ship')",
  "if (kind === 'pad')",
  "m.setParameter('_BaseColor', rgba)",
  "m.setParameter('_Color', rgba)",
  "m.setParameter('_EmissionColor', [0, 0, 0, 1])",
  'm.__storyboardColor = [c.r, c.g, c.b, 1]',
  'function recolorMaterial(target, rgba)',
  'recolorMaterial(rc.code.sharedMaterial, rgba)',
  'recolorMaterial(instances[i].material, rgba)',
  'pcApp.systems.meshFilter',
  'pcApp.systems.renderer',
  'new pc.MeshFilterComponent(e)',
  'new RCCtor(e)',
  'rc.updateMesh',
  'rc.code.sharedMaterial = material',
  'rc.code.material = material',
  'instances[i].visible = true',
  'instances[i].cull = false',
  'for (var pass = 0; pass < 5; pass++)',
  'Math.abs(1 - ratio) > 0.01',
  'var maxStep = 64',
  "console.warn('[AI] Storyboard primitive unavailable:",
  "Storyboard primitive reparent failed",
  "if (typeof pc.StandardMaterial !== 'function') return null",
  'if (!material) return',
  'if (!e) return null',
  'if (!s) continue',
  'if (!dot) continue',
  'ent._unityComponents && ent._unityComponents.renderer'
].forEach(function(needle) {
  assert.ok(src.indexOf(needle) >= 0, 'missing render fallback snippet: ' + needle);
});

// Fast path remains available for runtimes that do expose PlayCanvas render.
assert.ok(src.indexOf("addComponent('render'") >= 0,
  'PlayCanvas render fast path should remain available');

assert.ok(src.indexOf('e = createUnityPrimitiveEntity(name, type)') <
          src.indexOf('e = createRendererPrimitiveEntity(parent, name, type)'),
  'Unity primitive path should run before pool-renderer mesh reuse so sphere/cylinder/box stay type-specific');

assert.strictEqual(src.indexOf("set('bp-storyboard-target', guide ? '目标：' + guide.slice(0, 24) : '目标')"), -1,
  'target hint must use current target entity label, not truncated guideText');

console.log('linux bridge render fallback smoke passed');
