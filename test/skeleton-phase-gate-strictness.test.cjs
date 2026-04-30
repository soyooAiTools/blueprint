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
assert.match(code, /return _autoPlayMode \? phaseRealTimer >= requiredSeconds : phaseTimer >= requiredSeconds;/);
assert.match(code, /currentPhaseName == "intro"/);
assert.match(code, /currentPhaseName == "defendBase"/);
assert.match(code, /EnterPhase\(0, "intro", true, true\);/);
assert.match(code, /currentPhaseName == "intro"[\s\S]*PhaseDwellReady\(1f\)/);
assert.match(code, /currentPhaseName == "defendBase"[\s\S]*PhaseDwellReady\(15f\)/);
assert.match(code, /Phase_intro_Init\(\);[\s\S]*return;[\s\S]*Phase 跳转：intro → defendBase/);
assert.match(code, /CompletePhaseProgress\("intro"\);[^\n]*\n\s*return;/);
assert.match(code, /FinishGame\("defendBase"\);[^\n]*\n\s*return;/);

console.log('skeleton phase-gate strictness tests passed');
