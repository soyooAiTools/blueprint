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

assert.doesNotMatch(code, /EntityAdvanced\(Tower,\s*_snap_TowerPos\)/);
assert.match(code, /time-only beat/);
assert.match(code, /DetectRealTime <= 0f \|\| GFM_AutoPlay\.Instance\.IsActive/);
assert.match(code, /float phaseRealTimer = 0f;/);
assert.match(code, /float lastPhaseRealClock = 0f;/);
assert.match(code, /float nowReal = Time\.realtimeSinceStartup;/);
assert.match(code, /bool PhaseDwellReady\(float specMinSeconds\)/);
assert.match(code, /float requiredSeconds = _autoPlayMode \? 12f : specMinSeconds;/);
assert.match(code, /phaseRealTimer >= requiredSeconds \|\| \(phaseRealTimer <= 0\.01f && phaseTimer >= requiredSeconds\)/);
assert.match(code, /currentPhaseName == "intro"/);
assert.match(code, /currentPhaseName == "defendBase"/);
assert.match(code, /EnterPhase\(0, "intro", true, true\);/);
assert.match(code, /currentPhaseName == "intro"[\s\S]*PhaseDwellReady\(1f\)/);
assert.match(code, /currentPhaseName == "defendBase"[\s\S]*PhaseDwellReady\(15f\)/);
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
  /EntityAdvanced\(Gold,\s*_snap_GoldPos\)[\s\S]*GetCollectedResource\(GFM_ResourceIds\.Normalize\("Gold"\)\) >= 6/,
  'resource collection gates must survive hidden source objects by checking accumulated resources'
);
assert.match(collectCode, /int GetCollectedResource\(string id\)/);
assert.match(collectCode, /currentPhaseName == "collectGold"[\s\S]*PhaseDwellReady\(12f\)/);

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
