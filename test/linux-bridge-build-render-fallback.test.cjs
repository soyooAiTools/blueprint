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
  'function clonePoolMaterial(value, fallback, alphaValue)',
  'function createRendererPrimitiveEntity(parent, name, type)',
  'UnityEngine.GameObject.CreatePrimitive',
  'function createPrimitiveEntity(parent, name, type)',
  'function buildStyledComposite(group, name, primitiveStyle, sourceStyle)',
  'function storyboardSceneBackground()',
  'function applyStoryboardSceneBackground(source)',
  'function installStoryboardSceneBackgroundBootstrap()',
  'window.__storyboardApplyActualSceneBackground',
  "window.addEventListener(\"luna:starting\", function()",
  'UnityEngine.RenderSettings.skybox = null',
  'UnityEngine.RenderSettings.setskybox(null)',
  'mainCam.clearFlags = storyboardCameraClearFlag()',
  'pcApp.graphicsDevice.setClearColor(c.r, c.g, c.b, 1)',
  'node.camera.clearColor = c',
  'node.camera.clearColorBuffer = true',
  'window.__storyboardSceneDetails',
  "ent.name === '__Ground' || ent.name === '__MaterialSource'",
  "sceneFillMode = 'camera-clear'",
  'if (sceneContract.ground && sceneContract.ground.color)',
  'function currentStoryboardTargetLabel(gs, phaseId)',
  'function storyboardEntityLabel(name)',
  'phaseFirstStoryboardTarget(phaseId, gs)',
  "set('bp-storyboard-target', currentStoryboardTargetLabel(gs, sourcePhaseId))",
  'function primitiveStyleForName(name)',
  'window.__storyboardEntityDetails',
  'var storyboardVisualPositions = {}',
  'function setStoryboardEntityPosition(name, x, y, z, smooth)',
  'var alpha = 1 - Math.pow(0.002, dt / 220)',
  'var maxVisualStep = Math.min(0.1, 6.5 * dt / 1000)',
  'setStoryboardEntityPosition(name, storyboardRenderX(p.x), Number(p.y) || 0, storyboardRenderZForName(name, p.z), isPlayer)',
  "recordPrimitiveStyle(name, primitiveStyle, 'styled-composite:' + kind, count)",
  "if (kind === 'astronaut' || kind === 'npc')",
  "if (kind === 'ship')",
  "if (kind === 'pad')",
  "m.setParameter('_BaseColor', rgba)",
  "m.setParameter('_Color', rgba)",
  "m.setParameter('_EmissionColor', [0, 0, 0, 1])",
  'm.__storyboardColor = [c.r, c.g, c.b, alpha]',
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
  'function calibrateOverlayEntityScreenSize(ent, rect, target)',
  'function syncOverlayTransforms()',
  'pcApp.root.syncHierarchy',
  'var wRatio = target.w / Math.max(1, rect.w_px)',
  'var hRatio = target.h / Math.max(1, rect.h_px)',
  'var xzRatio = clampScaleRatio(wRatio, 0.45, 2.2)',
  'var yRatio = clampScaleRatio(hRatio, 0.45, 2.2)',
  'function currentViewportAnchoredOverlays(gs)',
  'var anchorFitApplied = {}',
  'function rectWithinAnchorFitTolerance(rect, target)',
  'rectWithinAnchorFitTolerance(rect, anchorToCanvas(anchor))',
  '&& !(viewportAnchored[name] && fitForPhase[name] && !isPlayer)',
  'var maxStep = 64',
  'var len = Math.sqrt(dx*dx+dy*dy), max = 44',
  'function currentWorldLabelPhase()',
  'function canonicalWorldLabelEntityName(raw)',
  'var parentLeaf = String(e.parentPath || \'\').split(\'/\').filter(Boolean).pop()',
  'function addWorldLabelLookupAliases(keys, raw, allowSourceKeyAlias)',
  'if (allowSourceKeyAlias || raw.charAt(0) === \'_\')',
  'phase.projectedWorldLabels',
  'lookupProjectedWorldLabel(projected, L.entityId, L.runtimeAliases, L.sourceAliases)',
  'storyboardEntityRectForLabel(L)',
  'placeWorldLabelAboveRect(L, entityRect)',
  'measured[projectedHit.key] = observedWorldLabelRect(L.div, true)',
  'function projectWorldLabelRectToViewport(rect)',
  'function observedWorldLabelRect(div, visible)',
  'window.__targetWorldLabels = measured',
  'window.__targetWorldLabelsByPhase[phaseId] = measured',
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
assert.strictEqual(src.indexOf('SellCounter'), -1,
  'worldLabel position fix must be generic, not entity-specific');
assert.strictEqual(src.indexOf('3.1'), -1,
  'worldLabel position fix must not hard-code the old source local y offset');
assert.strictEqual(src.indexOf('0.0275, 0.0627, 0.149'), -1,
  'scene background fix must read contract.scene.backgroundColor, not hard-code the Space Ranger RGB tuple');

var helperStart = src.indexOf('function worldLabelRecordValue(rec, keys)');
var helperEnd = src.indexOf('function projectWorldLabelRectToViewport(rect)');
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'worldLabel helper block should be extractable');
var helperBlock = src.slice(helperStart, helperEnd);
var lookupProjectedWorldLabel = new Function(helperBlock + '\nreturn lookupProjectedWorldLabel;')();
var rects = {
  _sellCounter: { x: 629.25, y: 159.35, width: 72.04, height: 20.26, centerX: 665.27, centerY: 169.48 },
  Player: { x: 100, y: 120, width: 30, height: 20, centerX: 115, centerY: 130 }
};
assert.deepStrictEqual(
  lookupProjectedWorldLabel(rects, 'SellCounter', ['SellCounter'], ['_sellCounter']).key,
  '_sellCounter',
  'worldLabel bridge should map runtime entity.id to contract parentPath key via descriptor alias');
assert.deepStrictEqual(
  lookupProjectedWorldLabel(rects, 'Player', ['Player'], []).key,
  'Player',
  'worldLabel bridge should keep matching keys unchanged');
assert.strictEqual(
  lookupProjectedWorldLabel(rects, 'SellCounter', ['SellCounter'], []),
  null,
  'worldLabel bridge should skip alias misses instead of leaking runtime entity.id key space');

console.log('linux bridge render fallback smoke passed');
