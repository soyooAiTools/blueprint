#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'worker', 'linux-bridge-build.js'), 'utf8');

assert(
  src.includes('id="blueprint-loading-cover"'),
  'single HTML export must include a visible loading cover before the first Luna frame'
);
assert(
  src.includes('window.addEventListener("luna:postrender", hideCover)'),
  'loading cover must be removed only after Luna has rendered a frame'
);
assert(
  src.includes('function _isInsideIframe()'),
  'standalone start fallback must distinguish direct-open previews from iframe previews'
);
assert(
  src.includes('window.addEventListener("luna:ready"'),
  'direct-open single HTML must start on luna:ready instead of waiting on an external host'
);
assert(
  src.includes('_sgTimer = setTimeout(_dispatchStandaloneStart, 1000)'),
  'fallback start delay should stay short enough to avoid visible black-screen stalls'
);
assert(
  src.includes('function collectLateUpdateComponents(loopComp)'),
  'manual rAF loop must collect Unity lifecycle components for LateUpdate dispatch'
);
assert(
  src.includes('driveManualLateUpdate(loopComp)'),
  'manual rAF loop must invoke LateUpdate after the active GameFlow Update'
);
assert(
  src.includes('window.__fidelityReady = false'),
  'target build must expose __fidelityReady and keep it false until first rendered frame settles'
);
assert(
  src.includes('window.__driveToPhase = function(n)'),
  'target build must expose deterministic __driveToPhase hook from the bridge layer'
);
assert(
  src.includes('driveLoopComponentToPhase(loopComp, phaseNumber)'),
  'target __driveToPhase must drive the active GameFlow component directly'
);
assert(
  src.includes('requestAnimationFrame(function()') && src.includes('setTimeout(resolve, 50)'),
  'target __driveToPhase must settle at least one rendered frame before resolving'
);
assert(
  src.includes('GFM_CameraController._instance'),
  'LateUpdate dispatch must explicitly cover the camera singleton when Luna keeps it off the entity tree'
);
assert(
  src.includes('function sourceEntityNames()'),
  'source visual overlay must not treat an empty sourceEntityContract.entities array as no entities'
);
assert(
  src.includes('names = Object.keys(composites)'),
  'source visual overlay must fall back to entityComposites when sourceEntityContract.entities is empty'
);
assert(
  src.includes('#__bp_text_overlay{display:none!important;visibility:hidden!important}'),
  'source visual overlay must hide legacy Luna DOM text mirrors to prevent duplicate HUD/target labels'
);
assert(
  src.includes('sourcePhases[si].steps[0].target'),
  'storyboard target hint must derive the current target from source phase steps when runtime lacks targetEntity'
);
assert(
  src.includes('Camera sync skipped: storyboard source framing owns AI_Camera'),
  'source visual mode must not let Unity Camera.main overwrite storyboard camera framing'
);
assert(
  src.includes('function syncStoryboardSourceCamera()'),
  'source visual overlay must install a deterministic source-style camera framing sync'
);
assert(
  src.includes('camEnt.setEulerAngles(35, 203, 0)') && src.includes('camEnt.camera.fov = 46'),
  'storyboard camera framing must match the source HTML perspective camera direction and FOV'
);
assert(
  src.includes('priority: __bpHasSourceVisualAssets ? -100 : 100'),
  'source visual mode AI_Camera must not clear over the final scene after the main camera renders'
);
assert(
  src.includes('function buildAssetGeometry(asset)') && src.includes('asset && asset.geometry && asset.geometry.type'),
  'source visual overlay must build primitives from each source asset geometry, not a Player-only hardcoded mesh'
);
assert(
  src.includes('/^[0-9eE+\\\\-*/().\\\\sMathPI]+$/'),
  'source visual numeric-expression parser regex must stay double-escaped for generated HTML'
);
assert(
  src.includes('SourcePrimitive_') && src.includes('asset && asset.assetId'),
  'non-player source primitives must keep unique asset-based mesh names'
);
assert(
  src.includes('window.__blueprintNormalizeGameState = normalizeBlueprintGameState'),
  'target hook must normalize game state aliases and source phase text before fidelity extraction'
);
assert(
  src.includes('if (!state.entity_states && state.entityStates) state.entity_states = state.entityStates'),
  'target hook must expose entity_states snake_case alias for source/target extractor parity'
);
assert(
  src.includes('if (phase.guideText) ui.guideText = phase.guideText'),
  'target hook must prefer source phase guideText over runtime default strings for fidelity diff'
);
assert(
  src.includes('function waitForFidelityState(expectedPhaseId)'),
  'target __driveToPhase must wait for populated game state before resolving'
);
assert(
  src.includes('function applySourcePhaseVisibility(state, phase)') &&
    src.includes('st.visible = isVisible') &&
    src.includes('state.visibleEntities = phase.showEntities.slice()'),
  'target fidelity state must mirror source phase showEntities visibility before field extraction'
);
assert(
  src.includes('function sourcePhaseForOverlayState(gs)') &&
    src.includes('var sourceVisible = phaseVisibleMap(sourcePhase)') &&
    src.includes('entityRoots[name].enabled = !!sourceVisible[name]'),
  'storyboard overlay must hide inactive phase entities using source phase visibility'
);
assert(
  src.includes('SOURCE_VISUAL_ENTITY_SCALE = 0.25') &&
    src.includes('group.setLocalScale(SOURCE_VISUAL_ENTITY_SCALE, SOURCE_VISUAL_ENTITY_SCALE, SOURCE_VISUAL_ENTITY_SCALE)'),
  'storyboard source primitives must use calibrated source-like visual scale'
);
assert(
  src.includes('var sourceEntityPositions = {}') &&
    src.includes('sourceEntityPositions[name] = [pos[0], pos[1], pos[2]]') &&
    src.includes('Number(p.y) > -100'),
  'storyboard source camera must not target runtime hidden sentinel positions'
);
assert(
  src.includes('function syncSourceWorldLabels()') &&
    src.includes('bp-source-world-labels') &&
    src.includes('camEnt.camera.worldToScreen(wp)'),
  'storyboard source visual overlay must render source-like world labels'
);
assert(
  src.includes('const { code, className, extraFiles, visualAssets } = parsed'),
  'legacy bridge server must accept visualAssets so production and direct builds share source contracts'
);

console.log('linux-bridge-build preview start guards passed');
