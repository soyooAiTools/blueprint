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
  'function clonePoolMaterial(hex)',
  'function createRendererPrimitiveEntity(parent, name, type)',
  'UnityEngine.GameObject.CreatePrimitive',
  'function createPrimitiveEntity(parent, name, type)',
  'pcApp.systems.meshFilter',
  'pcApp.systems.renderer',
  'new pc.MeshFilterComponent(e)',
  'new RCCtor(e)',
  'rc.updateMesh',
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

console.log('linux bridge render fallback smoke passed');
