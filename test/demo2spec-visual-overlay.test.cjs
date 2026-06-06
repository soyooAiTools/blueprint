#!/usr/bin/env node
'use strict';

const assert = require('assert');

const { injectVisualOverlay } = require('../adapters/demo2spec/visual-overlay.js');

const html = '<html><body><canvas id="application-canvas"></canvas></body></html>';
const manifest = {
  sourceEntityContract: {
    entities: [],
    entityStyles: {},
    domHudContract: {
      present: true,
      css: {
        hud: 'position:fixed;top:0;left:0;right:0;height:52px;background:rgba(0,0,0,0.6);display:flex',
        goldIcon: 'width:24px;height:24px;background:radial-gradient(circle,#ffe45c,#f0a000);border-radius:50%',
        goldCount: 'color:#ffe45c;font-weight:bold;font-size:18px;min-width:40px',
        tip: 'flex:1;text-align:center;color:#8deaff;font-size:13px',
        phaseLabel: 'color:#fff;font-size:12px;opacity:0.7',
        targetHint: 'position:fixed;top:56px;left:50%;transform:translateX(-50%);color:#ffe45c',
      },
      initialText: {
        goldCount: '50',
        tip: '欢迎！用摇杆移动宇航员',
        phaseLabel: 'Phase 1/1',
      },
    },
    entityComposites: {
      Hero: {
        entityName: 'Hero',
        label: 'Hero',
        position: { x: 0, y: 0, z: 0 },
        primitives: [
          {
            geometry: { type: 'BoxGeometry', args: [1, 1, 1] },
            material: { diffuseColor: '#3B82F6' },
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
      },
    },
  },
  sourcePhaseContract: {
    phaseCount: 1,
    phases: [{ id: 'phase1', showEntities: ['Hero'], steps: [] }],
  },
  sourceSceneContract: {
    ground: {
      kind: 'plane',
      width: 60,
      height: 60,
      color: '#111122',
    },
    grid: {
      present: true,
      size: 60,
      divisions: 30,
      colorCenterLine: '#223344',
      colorGrid: '#1a2233',
    },
    camera: {
      present: true,
      type: 'PerspectiveCamera',
      fov: 50,
      near: 0.1,
      far: 200,
      position: [0, 22, 18],
      lookAt: [0, 0, 0],
    },
  },
  playableSceneIrHash: 'a'.repeat(64),
  entityBindings: {},
  assets: [],
};

const out = injectVisualOverlay(html, manifest);

assert.notStrictEqual(out, html, 'visual overlay should still inject when entityStyles is empty');
assert.match(out, /function sourceEntityNames\(contract\)/);
assert.match(out, /Object\.keys\(composites\)/);
assert.match(out, /var names = sourceEntityNames\(contract\);/);
assert.match(out, /Three\.js source visual overlay active: entities=/);
assert.match(out, /function sourceVisualEnabled\(\)/);
assert.match(out, /return hasPlayableSceneIr\(\);/);
assert.match(out, /function sourceAutoplayRuntimeActive\(\)/);
assert.match(out, /function observerReadyRequested\(\)/);
assert.match(out, /function sourceAutoplayObserverReady\(\)/);
assert.match(out, /sourceRuntimeEnabled && autoplayRequested\(\) && sourceAutoplayObserverReady\(\)/);
assert.match(out, /observerReady: sourceAutoplayObserverReady\(\)/);
assert.match(out, /var targetEntity = step && step\.target \|\| sourceTargetName\(info, overlayRuntime\.resources, entityStates\)/);
assert.match(out, /highlightTarget: targetEntity/);
assert.match(out, /targetSequence: info && info\.targetSequence \|\| \[\]/);
assert.match(out, /currentStepIndex: overlayRuntime\.stepIndex/);
assert.match(out, /phaseTimestamps: {}/);
assert.match(out, /function markPhaseTimestamp\(phaseId\)/);
assert.match(out, /markPhaseTimestamp\(info\.id\)/);
assert.match(out, /phaseTimestamps: Object\.assign\({}, overlayRuntime\.phaseTimestamps\)/);
assert.match(out, /target_hp_decreased_or_target_dead = \{ covered: true, changed: true \}/);
assert.match(out, /window\.__BLUEPRINT_SOURCE_RUNTIME_ACTIVE__/);
assert.match(out, /function installSourceRuntimeGameState\(\)/);
assert.match(out, /sourceGameStateFn = function\(\)/);
assert.match(out, /Object\.defineProperty\(window, '__gameState'/);
assert.match(out, /get: getSourceGameState/);
assert.match(out, /set: setSourceGameState/);
assert.match(out, /window\.__getGameState = sourceGameStateFn/);
assert.match(out, /window\.__gameState = sourceGameStateFn/);
assert.match(out, /window\.__bpManualJoystickOverride/);
assert.match(out, /function sourcePhaseCount\(\)/);
assert.match(out, /function sourceDomHudContract\(\)/);
assert.match(out, /function sourceDomHudCssRules\(\)/);
assert.match(out, /bridgeOverlayHiddenCss\(\) \+ style\.textContent \+ sourceDomHudCssRules\(\)/);
assert.match(out, /bp-storyboard-hud,#bp-storyboard-target,#bp-storyboard-scene-tone/);
assert.match(out, /#demo2spec-source-phase-band\{display:none!important;visibility:hidden!important\}/);
assert.match(out, /bottom:auto!important;right:auto!important;width:auto!important;height:auto!important/);
assert.match(out, /demo2spec-source-gold-count/);
assert.match(out, /sourceDomHudInitial\('goldCount'/);
assert.match(out, /function sourceCameraContract\(\)/);
assert.match(out, /function applySourceCameraFrame\(camera, contract\)/);
assert.match(out, /sourceCameraPresent\(\) && isFinite\(Number\(cameraContract\.fov\)\)/);
assert.match(out, /applySourceCameraFrame\(camera, cameraContract\)/);
assert.match(out, /new THREE\.PlaneGeometry\(ground\.width \|\| ground\.radius \|\| 72, ground\.height \|\| ground\.width \|\| ground\.radius \|\| 72\)/);
assert.match(out, /new THREE\.GridHelper\(/);
assert.match(out, /window\.__driveToSourcePhase = driveSourceOverlayToPhase/);
assert.match(out, /wrapped\.__demo2specSourceWrapped = true/);
assert.match(out, /var sourceDrivenAuto = autoMode && sourceVisualEnabled\(\)/);
assert.match(out, /moveToward\(playerAuto, targetAuto, dt \* \(sourceAutoplayRuntimeActive\(\) \? 3\.0 : 16\)\)/);
assert.match(out, /var targetDisc = null/);
assert.match(out, /new THREE\.CircleGeometry\(2\.45, 64\)/);
assert.match(out, /demo2spec-source-phase-band/);
assert.match(out, /function cssHex\(value\)/);
assert.match(out, /function storyboardRuntimeComparableTargetPosition\(name, pos\)/);
assert.match(out, /var runtimeTarget = storyboardRuntimeComparableTargetPosition\(step && step\.target, target\)/);
assert.match(out, /distance2\(runtimePlayer, runtimeTarget\) <= 2\.5/);
assert.doesNotMatch(out, /Phase 1\/8/);

console.log('demo2spec visual overlay tests passed');
