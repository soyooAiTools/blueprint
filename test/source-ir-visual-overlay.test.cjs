#!/usr/bin/env node
'use strict';

const assert = require('assert');

const { injectVisualOverlay } = require('../adapters/source-ir/visual-overlay.js');

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
        keyframes: '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(41,217,111,.58)}70%{box-shadow:0 0 0 18px rgba(41,217,111,0)}100%{box-shadow:0 0 0 0 rgba(41,217,111,0)}}',
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
    resources: [{ id: 'Ice', label: '冰块', carrierEntity: 'IceBlock', initial: 0 }],
    phases: [{ id: 'phase1', showEntities: ['Hero'], steps: [] }],
  },
  sourceSceneContract: {
    ground: {
      kind: 'plane',
      width: 60,
      height: 60,
      color: '#111122',
      positionY: -0.12,
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
    decor: {
      orbitalRings: 2,
      orbitalRingStyle: {
        geometry: { type: 'TorusGeometry', argsBase: [10, 0.025, 8, 128], argsStep: [5.5, 0, 0, 0] },
        material: { diffuseColor: '#234C76', opacity: 0.5, transparent: true },
        rotation: [1.5708, 0, 0],
        positionY: { base: 0.04, step: 0.015 },
      },
    },
    guidance: {
      trailLine: { from: 'Player', to: 'SpaceBase', fromYOffset: 1, toYOffset: 1 },
    },
  },
  playableSceneIrHash: 'a'.repeat(64),
  entityBindings: {},
  assets: [],
};

const out = injectVisualOverlay(html, manifest);
const overlayScriptMatch = out.match(/<script>\s*(\(function\(\)\{[\s\S]*?\n\}\)\(\);)\s*<\\?\/script>/);
assert.ok(overlayScriptMatch, 'injected overlay script should be extractable');
assert.doesNotThrow(function() {
  new Function(overlayScriptMatch[1]);
}, 'injected overlay script should parse as JavaScript');

assert.notStrictEqual(out, html, 'visual overlay should still inject when entityStyles is empty');
assert.match(out, /function sourceEntityNames\(contract\)/);
assert.match(out, /Object\.keys\(composites\)/);
assert.match(out, /var names = sourceEntityNames\(contract\);/);
assert.match(out, /Three\.js source visual overlay active: entities=/);
assert.match(out, /function sourceVisualEnabled\(\)/);
assert.match(out, /return hasPlayableSceneIr\(\);/);
assert.match(out, /function sourceDomWorldLabelsEnabled\(\)/);
assert.match(out, /source === 'source-scene-ir'/);
assert.match(out, /function sourceResourceDescriptors\(\)/);
assert.match(out, /function sourceInitialResourceValues\(\)/);
assert.match(out, /function renderSourceResourcePills\(res\)/);
assert.match(out, /source-ir-resource-pills/);
assert.doesNotMatch(out, /data-k="ice">冰 0/);
assert.doesNotMatch(out, /resources: \{ Ice: 0, Oxygen: 0, Scrap: 0/);
assert.match(out, /function sourceAutoplayRuntimeActive\(\)/);
assert.match(out, /function observerReadyRequested\(\)/);
assert.match(out, /function sourceAutoplayObserverReady\(\)/);
assert.match(out, /sourceRuntimeEnabled && autoplayRequested\(\) && sourceAutoplayObserverReady\(\)/);
assert.match(out, /observerReady: sourceAutoplayObserverReady\(\)/);
assert.match(out, /var targetEntity = worldTargetName\(step && step\.target\) \|\| sourceTargetName\(info, overlayRuntime\.resources, entityStates\)/);
assert.match(out, /highlightTarget: targetEntity/);
assert.match(out, /var targetSequence = worldTargetSequence\(info && info\.targetSequence \|\| \[\]\)/);
assert.match(out, /currentStepIndex: overlayRuntime\.stepIndex/);
assert.match(out, /phaseTimestamps: {}/);
assert.match(out, /var hasRuntimeVisibleEntities = !!\(info && Array\.isArray\(info\.runtimeVisibleEntities\) && info\.runtimeVisibleEntities\.length\)/);
assert.match(out, /var baselineCoverageEntities = baselineEntities\.filter/);
assert.match(out, /var coveredBaselineEntities = baselineCoverageEntities\.filter/);
assert.match(out, /var needsBaselinePhase = hasRuntimeVisibleEntities && coveredBaselineEntities < Math\.min\(2, baselineCoverageEntities\.length \|\| 0\)/);
assert.match(out, /needsBaselinePhase \? terminalRetainedPhaseList\(phases, phaseIndex\) : \[phases\[phaseIndex\]\]/);
assert.match(out, /function terminalRetainedPhaseList\(phases, phaseIndex\)/);
assert.match(out, /phaseIndex - 3/);
assert.match(out, /function markPhaseTimestamp\(phaseId\)/);
assert.match(out, /markPhaseTimestamp\(info\.id\)/);
assert.match(out, /overlayRuntime\.cooldown = Math\.max\(overlayRuntime\.cooldown, 1\.7\)/);
assert.match(out, /phaseTimestamps: Object\.assign\({}, overlayRuntime\.phaseTimestamps\)/);
assert.match(out, /target_hp_decreased_or_target_dead = \{ covered: true, changed: true \}/);
assert.match(out, /camera_height_changed_or_view_widened = \{ covered: true, changed: true \}/);
assert.match(out, /step\.kind === 'deliver' \|\| step\.kind === 'transfer' \|\| step\.kind === 'combine'/);
assert.match(out, /ev\.resource_decremented = \{ covered: true, changed: true \}/);
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
assert.match(out, /function isTerminalSourcePhaseIndex\(index\)/);
assert.match(out, /function sourceDomHudContract\(\)/);
assert.match(out, /function sourceDomCtaPresent\(\)/);
assert.match(out, /function sourceDomHudUsesResourceBar\(\)/);
assert.match(out, /function sourceDomHudUsesCompactPills\(\)/);
assert.match(out, /function sourceDomHudCssRules\(\)/);
assert.match(out, /var tipHasVerticalAnchor = \/\\b\(\?:top\|bottom\)\\s\*:\/i\.test\(tipCss\)/);
assert.match(out, /sourceDomCtaPresent\(\) && !hudCss && !tipHasVerticalAnchor && !\/\\bposition\\s\*:\\s\*fixed\\b\/i\.test\(tipCss\)/);
assert.match(out, /function sourceDomHudUsesTopbarStats\(\)/);
assert.match(out, /data-k="goldPanel"/);
assert.match(out, /set\('goldPanel', '金币 ' \+ String/);
assert.match(out, /source-ir-upgrade-panel/);
assert.match(out, /sourceUpgradePanel\.style\.display = overlayRuntime\.phaseIndex === 6 \? 'block' : 'none'/);
assert.match(out, /function applySourceCameraFrame\(camera, contract, playerPos\)/);
assert.match(out, /applySourceCameraFrame\(camera, cameraContract, player\)/);
assert.match(out, /var targetRingColor = hexToNumber\(guidance\.targetRing && guidance\.targetRing\.material && guidance\.targetRing\.material\.color, '#ffe45c'\)/);
assert.match(out, /var contractedTrailTargetName = guidance\.trailLine && guidance\.trailLine\.to \|\| ''/);
assert.match(out, /trailFromYOffset = Number\(guidance\.trailLine && guidance\.trailLine\.fromYOffset\)/);
assert.doesNotMatch(out, /replace\(\s*\/\\?s\+/);
assert.match(out, /bridgeOverlayHiddenCss\(\) \+ style\.textContent \+ sourceDomHudCssRules\(\)/);
assert.match(out, /bp-storyboard-hud,#bp-storyboard-target,#bp-storyboard-scene-tone/);
assert.match(out, /source-ir-world-label/);
assert.match(out, /#source-ir-phase-band\{display:none!important;visibility:hidden!important\}/);
assert.match(out, /function terminalCtaCopy\(info\)/);
assert.match(out, /function setTerminalCta\(info, visible\)/);
assert.match(out, /title = '立即下载，解锁更多' \+ unlock\[1\] \+ '玩法！'/);
assert.match(out, /button = '安装完整游戏'/);
assert.match(out, /title = sourceDomHudInitial\('victory', title\)/);
assert.match(out, /button = sourceDomHudInitial\('ctaDom', button\)/);
assert.match(out, /source-ir-cta-overlay/);
assert.match(out, /background:rgba\(0,0,0,\.62\)/);
assert.match(out, /source-dom-cta/);
assert.match(out, /#source-ir-cta-overlay\.source-dom-cta\.visible/);
assert.match(out, /#source-ir-cta-overlay\.source-dom-cta #source-ir-cta-box/);
assert.match(out, /sourceCtaBoxExtra = 'width:auto!important;max-width:calc\(100vw - 48px\)!important;display:inline-block!important'/);
assert.match(out, /#source-ir-cta-overlay\.source-dom-cta #source-ir-cta-btn/);
assert.match(out, /@keyframes pulse/);
assert.match(out, /source-ir-cta-subtitle/);
assert.match(out, /source-ir-phase-badge/);
assert.match(out, /source-ir-resources/);
assert.match(out, /source-ir-gold-box/);
assert.match(out, /sourceDomHudInitial\('goldText'/);
assert.match(out, /sourceDomHudInitial\('matText'/);
assert.match(out, /sourceDomHudUsesResourceBar\(\) \|\| sourceDomHudUsesCompactPills\(\) \|\| sourceDomHudUsesMeterPills\(\)/);
assert.match(out, /function sourceDomHudUsesMeterPills\(\)/);
assert.match(out, /function sourceDomHudHasProgressBar\(\)/);
assert.match(out, /function sourceDomHudHasIdleJoystick\(\)/);
assert.match(out, /source-ir-logo/);
assert.match(out, /source-ir-meters/);
assert.match(out, /!sourceDomHudUsesMeterPills\(\) &&/);
assert.match(out, /source-ir-oxygen-text/);
assert.match(out, /source-ir-worker-panel/);
assert.match(out, /source-ir-progress-wrap/);
assert.match(out, /source-ir-progress-bar/);
assert.match(out, /inlineSourceTip/);
assert.match(out, /source-ir-stick', css\.joystick/);
assert.match(out, /source-ir-stick-knob', css\.stickThumb/);
assert.match(out, /display:block!important;visibility:visible!important/);
assert.match(out, /function setStyleImportant\(el, name, value\)/);
assert.match(out, /setStyleImportant\(stick, 'left', origin\.x \+ 'px'\)/);
assert.match(out, /#source-ir-stick:before\{display:none!important;visibility:hidden!important\}/);
assert.match(out, /sourceCounterText\('iceText'/);
assert.match(out, /source-ir-cta-title/);
assert.match(out, /source-ir-cta-btn/);
assert.match(out, /display\\s\*:\\s\*none/);
assert.match(out, /if \(!sourceDomCtaPresent\(\)\)/);
assert.match(out, /\['source-ir-hud', 'source-ir-target'\]\.forEach/);
assert.match(out, /setTerminalCta\(info, isTerminalSourcePhaseIndex\(index\)\)/);
assert.match(out, /var terminalVisible = phaseText === 'gameEnd' \|\| isTerminalSourcePhaseIndex/);
assert.match(out, /!\/\\bbottom\\s\*:\/i\.test\(targetHintCss\)/);
assert.match(out, /right:auto!important;width:auto!important;height:auto!important/);
assert.match(out, /source-ir-gold-count/);
assert.match(out, /sourceDomHudInitial\('goldCount'/);
assert.match(out, /sourceDomHudInitial\('goldBox'/);
assert.match(out, /sourceProgressBar\.style\.width/);
assert.match(out, /function sourceCameraContract\(\)/);
assert.match(out, /function applySourceCameraFrame\(camera, contract, playerPos\)/);
assert.match(out, /follow\.positionY == null \? NaN : Number\(follow\.positionY\)/);
assert.match(out, /follow\.lookAtY == null \? NaN : Number\(follow\.lookAtY\)/);
assert.match(out, /var hasLookAtFactor = isFinite\(Number\(lf\.x\)\) \|\| isFinite\(Number\(lf\.z\)\)/);
assert.match(out, /var useDynamicLookAt = hasLookAtFactor && contract\.dynamicLookAtPlayer !== false/);
assert.match(out, /useDynamicLookAt \? Number\(playerPos\.x \|\| 0\).*: target\[0\]/);
assert.match(out, /useDynamicLookAt \? lookAtY : target\[1\]/);
assert.match(out, /useDynamicLookAt \? Number\(playerPos\.z \|\| 0\).*: target\[2\]/);
assert.match(out, /function rotationVector\(values, fallback\)/);
assert.match(out, /value \* Math\.PI \/ 180/);
assert.match(out, /sourceCameraPresent\(\) && isFinite\(Number\(cameraContract\.fov\)\)/);
assert.match(out, /applySourceCameraFrame\(camera, cameraContract, player\)/);
assert.match(out, /new THREE\.PlaneGeometry\(ground\.width \|\| ground\.radius \|\| 72, ground\.height \|\| ground\.width \|\| ground\.radius \|\| 72\)/);
assert.match(out, /new THREE\.BoxGeometry\(ground\.width \|\| ground\.radius \|\| 72, ground\.thickness \|\| \.18, ground\.height \|\| ground\.width \|\| ground\.radius \|\| 72\)/);
assert.match(out, /Number\.isFinite\(Number\(ground\.positionY\)\)/);
assert.match(out, /new THREE\.WebGLRenderer\(\{ antialias: true, alpha: false, powerPreference: 'high-performance' \}\)/);
assert.match(out, /new THREE\.GridHelper\(/);
assert.match(out, /numericSeriesValue\(orbitStyle\.positionY, torusIndex, \.04 \+ torusIndex \* \.015\)/);
assert.match(out, /new THREE\.TorusGeometry\(args\[0\] \|\| 10, args\[1\] \|\| \.025, args\[2\] \|\| 8, args\[3\] \|\| 128\)/);
assert.match(out, /baselineCoverageEntities = baselineEntities\.filter/);
assert.match(out, /guide\|ui\|hint\|target/i);
assert.match(out, /window\.__driveToSourcePhase = driveSourceOverlayToPhase/);
assert.match(out, /canvas\.height = 64/);
assert.match(out, /spr\.scale\.set\(2\.1, \.52, 1\)/);
assert.match(out, /spr\.position\.y = 2\.25/);
assert.match(out, /wrapped\.__SOURCE_IR_SOURCE_WRAPPED = true/);
assert.match(out, /phaseDriverFallback = error && error\.message/);
assert.match(out, /function sourceVisualDiffRunning\(\)/);
assert.match(out, /sourceRuntimeEnabled && sourceVisualDiffRunning\(\) && !manualActive && !sourceAutoplayRuntimeActive\(\)/);
assert.match(out, /var sourceDrivenAuto = autoMode && sourceVisualEnabled\(\)/);
assert.match(out, /moveToward\(playerAuto, targetAuto, dt \* \(sourceAutoplayRuntimeActive\(\) \? 3\.0 : 16\)\)/);
assert.match(out, /function sourceGroundMovementBounds\(\)/);
assert.match(out, /function overlayMovementBounds\(composites\)/);
assert.match(out, /function clampOverlayPlayerPosition\(player, composites\)/);
assert.match(out, /function sourceReachabilityReport\(composites\)/);
assert.match(out, /window\.__SOURCE_IR_OVERLAY_MOVEMENT_BOUNDS__ = overlayRuntime\.movementBounds/);
assert.match(out, /window\.__SOURCE_IR_OVERLAY_REACHABILITY__ = sourceReachabilityReport\(composites\)/);
assert.match(out, /targetReachability: window\.__SOURCE_IR_OVERLAY_REACHABILITY__ \|\| null/);
assert.match(out, /clampOverlayPlayerPosition\(player, composites\)/);
assert.doesNotMatch(out, /Math\.max\(-18,\s*Math\.min\(72,\s*player\.x\)\)/);
assert.doesNotMatch(out, /Math\.max\(-18,\s*Math\.min\(18,\s*player\.z\)\)/);
assert.match(out, /var targetDisc = null/);
assert.match(out, /var domLabels = {}/);
assert.match(out, /new THREE\.CircleGeometry\(2\.45, 64\)/);
assert.match(out, /source-ir-phase-band/);
assert.match(out, /function cssHex\(value\)/);
assert.match(out, /function storyboardRuntimeComparableTargetPosition\(name, pos\)/);
assert.match(out, /function overlayStepReadyWithoutTarget\(step\)/);
assert.match(out, /function stepLabel\(step\)/);
assert.match(out, /if \(target && label === target\) return targetLabel \|\| label/);
assert.match(out, /showOverlayToast\(stepLabel\(step\)\)/);
assert.match(out, /step\.kind === 'wait'/);
assert.match(out, /step\.kind === 'cta_finish'/);
assert.match(out, /overlayStepElapsedSeconds\(\) >= Math\.max/);
assert.match(out, /overlayRuntime\.stepStartedAt = runtimeNowMs\(\)/);
assert.match(out, /var runtimeTarget = storyboardRuntimeComparableTargetPosition\(step && step\.target, target\)/);
assert.match(out, /distance2\(runtimePlayer, runtimeTarget\) <= 2\.5/);
assert.match(out, /pos\.project\(camera\)/);
assert.doesNotMatch(out, /Phase 1\/8/);

console.log('source-ir visual overlay tests passed');
