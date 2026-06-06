const assert = require('assert');

const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

const specs = [
  {
    phaseId: 'intro',
    entitiesRequired: [{ name: 'player' }],
    requiredInteractions: ['wait:1'],
    triggerNext: { condition: 'true' },
    duration: { min: 1, max: 2 },
  },
  {
    phaseId: 'defendBase',
    entitiesRequired: [{ name: 'Tower' }],
    requiredInteractions: ['defend:Tower'],
    triggerNext: { condition: 'waveCleared' },
    duration: { min: 15, max: 30 },
  },
];

const skeleton = generateSkeleton(specs, {
  entityPoolMap: { player: '__Pool_Player', Tower: '__Pool_Tower' },
  entities: [{ name: 'player' }, { name: 'Tower' }],
});
const code = typeof skeleton === 'string'
  ? skeleton
  : Object.keys(skeleton).map(k => skeleton[k]).filter(v => typeof v === 'string').join('\n');

function methodBlock(src, methodName) {
  const marker = `bool ${methodName}()`;
  const start = src.indexOf(marker);
  assert.notStrictEqual(start, -1, `missing method ${methodName}`);
  const braceStart = src.indexOf('{', start);
  assert.notStrictEqual(braceStart, -1, `missing body for ${methodName}`);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated method ${methodName}`);
}

function assertGateAllowsManual(src, methodName, phaseId) {
  const block = methodBlock(src, methodName);
  assert.match(block, new RegExp(`realReady \\|\\| ManualPhaseTargetEvidenceReady\\("${phaseId}"\\)`));
}

function assertGateRequiresManualAndReal(src, methodName, phaseId) {
  const block = methodBlock(src, methodName);
  assert.match(block, /&& realReady/);
  assert.match(block, new RegExp(`_autoPlayMode \\|\\| ManualPhaseTargetEvidenceReady\\("${phaseId}"\\)`));
}

function assertGateDeniesManual(src, methodName, phaseId) {
  const block = methodBlock(src, methodName);
  assert.match(block, /&& realReady/);
  assert.doesNotMatch(block, new RegExp(`ManualPhaseTargetEvidenceReady\\("${phaseId}"\\)`));
}

assert.doesNotMatch(code, /EntityAdvanced\(Tower,\s*_snap_TowerPos\)/);
assert.match(code, /time-only beat/);
assert.match(code, /DetectRealTime <= 0f \|\| GFM_AutoPlay\.Instance\.IsActive/);
assert.match(code, /float phaseRealTimer = 0f;/);
assert.match(code, /float lastPhaseRealClock = 0f;/);
assert.match(code, /float nowReal = Time\.realtimeSinceStartup;/);
assert.match(code, /if \(realDt < 0f\) realDt = 0f;/);
assert.match(code, /if \(realDt > 12f\) realDt = 12f;/);
assert.doesNotMatch(code, /realDt < 0f \|\| realDt > 1f\) realDt = 0f/);
assert.match(code, /bool PhaseDwellReady\(float specMinSeconds\)/);
assert.match(code, /const float AUTO_PLAY_PHASE_DURATION = 12f;/);
assert.match(code, /string _autoPlayVisualPhase = "";/);
assert.match(code, /void TickAutoPlayVisualMotion\(\)/);
assert.match(code, /if \(!_autoPlayMode \|\| mainCam == null \|\| gameEnded\) return;/);
assert.match(code, /mainCam\.transform\.rotation = _autoPlayCameraBaseRotation \* Quaternion\.Euler\(pulse \* 2\.4f, pulse \* 4\.5f, 0f\);/);
assert.match(code, /mainCam\.fieldOfView = Mathf\.Clamp\(_autoPlayCameraBaseFov \+ pulse \* 3\.0f, 32f, 64f\);/);
assert.match(code, /float requiredSeconds = _autoPlayMode \? AUTO_PLAY_PHASE_DURATION : Mathf\.Min\(specMinSeconds, 0\.35f\);/);
assert.match(code, /bool ManualPhaseTargetEvidenceReady\(string phaseId\)/);
assert.match(code, /_autoPlayMode \|\| !_manualGameplayUnlocked/);
assert.match(code, /HasPhaseEvidenceRecord\(phaseId, "distance_to_target_below_threshold"\)/);
assert.match(code, /HasPhaseEvidenceRecord\(phaseId, "player_position_changed"\)/);
assert.match(code, /bool manualClickReady = HasPhaseEvidenceRecord\(phaseId, "tap_registered"\)/);
assert.match(code, /HasPhaseEvidenceRecord\(phaseId, "click_trigger"\)/);
assert.match(code, /return manualMoveReady \|\| manualClickReady;/);
assert.doesNotMatch(code, /ManualPhaseTargetEvidenceReady[\s\S]{0,500}source_hidden_or_moved/);
assert.match(code, /bool realtimeUnavailable = Time\.realtimeSinceStartup <= 0\.01f;/);
assert.match(code, /phaseRealTimer >= requiredSeconds \|\| \(realtimeUnavailable && phaseTimer >= requiredSeconds\)/);
assert.doesNotMatch(code, /phaseRealTimer <= 0\.01f && phaseTimer >= requiredSeconds/);
assert.match(code, /currentPhaseName == "intro"/);
assert.match(code, /currentPhaseName == "defendBase"/);
assert.match(code, /EnterPhase\(0, "intro", true, true\);/);
assert.match(code, /currentPhaseName == "intro"[\s\S]*PhaseDwellReady\(1f\)/);
assert.match(code, /currentPhaseName == "defendBase"[\s\S]*PhaseDwellReady\(15f\)/);
assertGateDeniesManual(code, 'Phase_defendBase_GateReady', 'intro');
assertGateDeniesManual(code, 'EndGame_GateReady', 'defendBase');
assert.match(code, /Phase_intro_Init\(\);[\s\S]*return;[\s\S]*Phase 跳转：intro → defendBase/);
assert.match(code, /CompletePhaseProgress\("intro"\);[^\n]*\n\s*return;/);
assert.match(code, /FinishGame\("defendBase"\);[^\n]*\n\s*return;/);

const collectSkeleton = generateSkeleton([
  {
    phaseId: 'collectGold',
    entitiesRequired: [{ name: 'Gold' }],
    requiredInteractions: ['move_to:Gold', 'collect:Gold:6'],
    duration: { min: 12, max: 15 },
  },
  {
    phaseId: 'next',
    entitiesRequired: [{ name: 'Base' }],
    requiredInteractions: ['move_to:Base'],
    duration: { min: 12, max: 15 },
  },
], {
  entityPoolMap: { Gold: '__Pool_Gold', Base: '__Pool_Base' },
  entities: [{ name: 'Gold' }, { name: 'Base' }],
});
const collectCode = typeof collectSkeleton === 'string'
  ? collectSkeleton
  : Object.keys(collectSkeleton).map(k => collectSkeleton[k]).filter(v => typeof v === 'string').join('\n');
assert.match(
  collectCode,
  /EntityAdvanced\(Gold,\s*_snap_GoldPos\)[\s\S]*GetPhaseCarriedProgress\(GFM_ResourceIds\.Normalize\("Gold"\), GoldCarried\) >= 6 \|\| GetPhaseCollectedProgress\(GFM_ResourceIds\.Normalize\("Gold"\)\) >= 6/,
  'resource collection gates must use phase-local carried/collected deltas instead of historical inventory'
);
assert.match(collectCode, /int GetCollectedResource\(string id\)/);
assert.match(collectCode, /void CapturePhaseResourceBaselines\(\)/);
assert.match(collectCode, /SetLastKnownResourceBalance\(GFM_ResourceIds\.Normalize\("Gold"\), GetCollectedResource\(GFM_ResourceIds\.Normalize\("Gold"\)\)\)/);
assert.match(collectCode, /SetLastKnownResourceBalance\(GFM_ResourceIds\.Normalize\("Gold"\) \+ "_carried", GoldCarried\)/);
assert.match(collectCode, /currentPhaseName == "collectGold"[\s\S]*PhaseDwellReady\(12f\)/);
assertGateRequiresManualAndReal(collectCode, 'Phase_next_GateReady', 'collectGold');

const visibleResourceTargetSkeleton = generateSkeleton([
  {
    phaseId: 'collectIce',
    entitiesRequired: [{ name: 'IceChunk', resource: 'Ice' }],
    requiredInteractions: ['move_to:IceChunk', 'collect:Ice:5'],
    duration: { min: 12, max: 15 },
  },
  {
    phaseId: 'next',
    entitiesRequired: [{ name: 'Base' }],
    requiredInteractions: ['move_to:Base'],
    duration: { min: 12, max: 15 },
  },
], {
  entityPoolMap: { IceChunk: '__Pool_IceChunk', Ice: '__Pool_Ice', Base: '__Pool_Base' },
  entities: [{ name: 'IceChunk' }, { name: 'Ice' }, { name: 'Base' }],
});
const visibleResourceTargetCode = typeof visibleResourceTargetSkeleton === 'string'
  ? visibleResourceTargetSkeleton
  : Object.keys(visibleResourceTargetSkeleton).map(k => visibleResourceTargetSkeleton[k]).filter(v => typeof v === 'string').join('\n');
assert.match(visibleResourceTargetCode, /EntityAdvanced\(IceChunk,\s*_snap_IceChunkPos\)/);
assert.doesNotMatch(visibleResourceTargetCode, /EntityAdvanced\(Ice,\s*_snap_IcePos\)/);
assert.match(visibleResourceTargetCode, /GetPhaseCarriedProgress\(GFM_ResourceIds\.Normalize\("Ice"\), IceCarried\) >= 5 \|\| GetPhaseCollectedProgress\(GFM_ResourceIds\.Normalize\("Ice"\)\) >= 5/);

const moveOnlySkeleton = generateSkeleton([
  {
    phaseId: 'walkOnly',
    entitiesRequired: [{ name: 'Player' }],
    requiredInteractions: ['move_to:Target'],
    duration: { min: 10, max: 15 },
  },
  {
    phaseId: 'nextClick',
    entitiesRequired: [{ name: 'Target' }],
    requiredInteractions: ['click:Target'],
    duration: { min: 10, max: 15 },
  },
], {
  entityPoolMap: { Player: '__Pool_Player', Target: '__Pool_Target' },
  entities: [{ name: 'Player' }, { name: 'Target' }],
});
const moveOnlyCode = typeof moveOnlySkeleton === 'string'
  ? moveOnlySkeleton
  : Object.keys(moveOnlySkeleton).map(k => moveOnlySkeleton[k]).filter(v => typeof v === 'string').join('\n');
assertGateAllowsManual(moveOnlyCode, 'Phase_nextClick_GateReady', 'walkOnly');
assertGateAllowsManual(moveOnlyCode, 'EndGame_GateReady', 'nextClick');

const latePhaseSkeleton = generateSkeleton([
  {
    phaseId: 'p1',
    entitiesRequired: [{ name: 'Player' }],
    requiredInteractions: ['move_to:A'],
    triggerNext: { condition: 'first' },
    duration: { min: 10, max: 15 },
  },
  {
    phaseId: 'p2',
    entitiesRequired: [{ name: 'A' }],
    requiredInteractions: ['move_to:B'],
    triggerNext: { condition: 'second' },
    duration: { min: 10, max: 15 },
  },
  {
    phaseId: 'p3',
    entitiesRequired: [{ name: 'B' }],
    requiredInteractions: ['move_to:C', 'collect:C:1'],
    triggerNext: { condition: 'third' },
    duration: { min: 10, max: 15 },
  },
  {
    phaseId: 'p4',
    entitiesRequired: [{ name: 'CtaButton' }],
    requiredInteractions: ['click:CtaButton'],
    duration: { min: 10, max: 15 },
  },
], {
  entityPoolMap: { Player: '__Pool_Player', A: '__Pool_A', B: '__Pool_B', C: '__Pool_C', CtaButton: '__Pool_CTA' },
  entities: [{ name: 'Player' }, { name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'CtaButton' }],
});
const latePhaseCode = typeof latePhaseSkeleton === 'string'
  ? latePhaseSkeleton
  : Object.keys(latePhaseSkeleton).map(k => latePhaseSkeleton[k]).filter(v => typeof v === 'string').join('\n');
assertGateAllowsManual(latePhaseCode, 'Phase_p2_GateReady', 'p1');
assertGateAllowsManual(latePhaseCode, 'Phase_p3_GateReady', 'p2');
assertGateRequiresManualAndReal(latePhaseCode, 'Phase_p4_GateReady', 'p3');
assertGateAllowsManual(latePhaseCode, 'EndGame_GateReady', 'p4');

const buildOnlySkeleton = generateSkeleton([
  {
    phaseId: 'buildTower',
    entitiesRequired: [{ name: 'Tower' }],
    requiredInteractions: ['build:Tower'],
    duration: { min: 12, max: 15 },
  },
  {
    phaseId: 'next',
    entitiesRequired: [{ name: 'Base' }],
    requiredInteractions: ['move_to:Base'],
    duration: { min: 12, max: 15 },
  },
], {
  entityPoolMap: { Tower: '__Pool_Tower', Base: '__Pool_Base' },
  entities: [{ name: 'Tower' }, { name: 'Base' }],
});
const buildOnlyCode = typeof buildOnlySkeleton === 'string'
  ? buildOnlySkeleton
  : Object.keys(buildOnlySkeleton).map(k => buildOnlySkeleton[k]).filter(v => typeof v === 'string').join('\n');
assertGateRequiresManualAndReal(buildOnlyCode, 'Phase_next_GateReady', 'buildTower');

const highComplexitySkeleton = generateSkeleton(Array.from({ length: 9 }, (_, idx) => ({
  phaseId: 'phase' + (idx + 1),
  entitiesRequired: [{ name: 'Target' + (idx + 1) }],
  requiredInteractions: ['move_to:Target' + (idx + 1)],
  duration: { min: 12, max: 15 },
})), {
  entityPoolMap: {},
  entities: Array.from({ length: 9 }, (_, idx) => ({ name: 'Target' + (idx + 1) })),
});
const highComplexityCode = typeof highComplexitySkeleton === 'string'
  ? highComplexitySkeleton
  : Object.keys(highComplexitySkeleton).map(k => highComplexitySkeleton[k]).filter(v => typeof v === 'string').join('\n');
assert.match(highComplexityCode, /const float AUTO_PLAY_PHASE_DURATION = 20f;/);

const interactionTargetSkeleton = generateSkeleton([
  {
    phaseId: 'collectHiddenGold',
    entitiesRequired: [{ name: 'Hero' }],
    requiredInteractions: ['move_to:Gold', 'collect:Gold:1'],
    duration: { min: 12, max: 15 },
  },
], {
  entityPoolMap: { Hero: '__Pool_Hero', Gold: '__Pool_Gold' },
  entities: [{ name: 'Hero' }, { name: 'Gold' }],
});
const interactionTargetCode = typeof interactionTargetSkeleton === 'string'
  ? interactionTargetSkeleton
  : Object.keys(interactionTargetSkeleton).map(k => interactionTargetSkeleton[k]).filter(v => typeof v === 'string').join('\n');
assert.match(
  interactionTargetCode,
  /string\[\] _autoTargets = new string\[\] \{ "Gold" \};/,
  'autoplay targets must include semantic interaction targets even when entitiesRequired lists only scenery'
);
assert.match(
  interactionTargetCode,
  /floatingText\.text = "AUTO " \+ currentPhaseName \+ " OK";/,
  'autoplay fallback should emit an explicit visible UI progress cue in observe mode'
);

console.log('skeleton phase-gate strictness tests passed');
