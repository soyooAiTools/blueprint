#!/usr/bin/env node
/**
 * 2026-04-27: deterministic post-template-fill validator tests.
 *
 * Locks the three rules that gate the new template-output deterministic-skip
 * branch in review.cjs:isAssemblyReadyForDeterministicReview:
 *   1. phase ID coverage (every schema phase has AddCompletedPhase call)
 *   2. NPC method coverage (every NPC has Update<Entity> defined AND called)
 *   3. marker residue (no empty TODO_*_START/_END pairs)
 *
 * Also locks the review-stage gate's template-output branch:
 *   - validator.passed + templateCoverage>=0.95 + todoSectionsRemaining===0 → skip
 *   - any single condition false → do NOT skip
 */

var assert = require('assert');
var validator = require('../adapters/template-output-validator.cjs');
var review = require('../engine/stages/review.cjs');

var schema = {
  phases: [
    { phaseId: 'collectOre', trigger: { type: 'resource_collected' } },
    { phaseId: 'deliverOre', trigger: { type: 'entity_state_reached' } },
    { phaseId: 'gameEnd', trigger: null },
  ],
  entities: [{ name: 'player' }, { name: 'Ore' }, { name: 'Enemy' }],
  npcs: [{ entity: 'Enemy', template: 'patrol', params: { patrolRadius: 5, moveSpeed: 2 } }],
};

// Case 1: well-formed code → passes
var goodMain = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    GameObject Enemy;',
  '    void Update() {',
  '        UpdateEnemy(Time.deltaTime);',
  '        if (collected >= 1) AddCompletedPhase("collectOre");',
  '        if (delivered) AddCompletedPhase("deliverOre");',
  '        if (gameOver) AddCompletedPhase("gameEnd");',
  '    }',
  '    void UpdateEnemy(float dt) { /* patrol */ }',
  '}',
].join('\n');
var r1 = validator.validateTemplateOutput({ schema: schema, csCode: goodMain });
assert.strictEqual(r1.passed, true, 'Case 1: valid code must pass. Issues: ' + JSON.stringify(r1.issues));
assert.strictEqual(r1.summary.phaseImplemented, 3);
assert.strictEqual(r1.summary.npcDefined, 1);
assert.strictEqual(r1.summary.npcCalled, 1);
assert.strictEqual(r1.summary.markerResidueCount, 0);

// Case 2: missing AddCompletedPhase for one phase → critical
var missingPhase = goodMain.replace('AddCompletedPhase("deliverOre");', '/* gone */');
var r2 = validator.validateTemplateOutput({ schema: schema, csCode: missingPhase });
assert.strictEqual(r2.passed, false, 'Case 2: missing phase must fail');
assert.ok(r2.issues.some(function(i) { return i.rule === 'phase-coverage' && /deliverOre/.test(i.message); }),
  'Case 2: must report missing deliverOre phase');

// Case 3: NPC defined but never called → critical
var npcUncalled = goodMain.replace('UpdateEnemy(Time.deltaTime);', '/* call removed */');
var r3 = validator.validateTemplateOutput({ schema: schema, csCode: npcUncalled });
assert.strictEqual(r3.passed, false, 'Case 3: uncalled NPC must fail');
assert.ok(r3.issues.some(function(i) { return i.rule === 'npc-method-uncalled'; }),
  'Case 3: must flag npc-method-uncalled, got rules: ' + r3.issues.map(function(i){return i.rule;}).join(','));

// Case 4: NPC called but no definition → critical
var npcNoDef = goodMain.replace('void UpdateEnemy(float dt) { /* patrol */ }', '/* def removed */');
var r4 = validator.validateTemplateOutput({ schema: schema, csCode: npcNoDef });
assert.strictEqual(r4.passed, false, 'Case 4: NPC without definition must fail');
assert.ok(r4.issues.some(function(i) { return i.rule === 'npc-method-missing-def'; }),
  'Case 4: must flag npc-method-missing-def');

// Case 5: empty TODO marker block → critical (residue)
var withResidue = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    void Start() {',
  '        // TODO_START_START',
  '        ',
  '        // TODO_START_END',
  '    }',
  '    void Update() {',
  '        UpdateEnemy(Time.deltaTime);',
  '        AddCompletedPhase("collectOre");',
  '        AddCompletedPhase("deliverOre");',
  '        AddCompletedPhase("gameEnd");',
  '    }',
  '    void UpdateEnemy(float dt) {}',
  '}',
].join('\n');
var r5 = validator.validateTemplateOutput({ schema: schema, csCode: withResidue });
assert.strictEqual(r5.passed, false, 'Case 5: empty TODO marker block must fail');
assert.ok(r5.issues.some(function(i) { return i.rule === 'marker-residue' && i.marker === 'TODO_START'; }),
  'Case 5: must flag marker-residue for TODO_START');

// Case 6: filled TODO marker block → no residue flagged
var filled = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    void Start() {',
  '        // TODO_START_START',
  '        var x = 1; // real fill',
  '        // TODO_START_END',
  '    }',
  '    void Update() {',
  '        UpdateEnemy(Time.deltaTime);',
  '        AddCompletedPhase("collectOre");',
  '        AddCompletedPhase("deliverOre");',
  '        AddCompletedPhase("gameEnd");',
  '    }',
  '    void UpdateEnemy(float dt) {}',
  '}',
].join('\n');
var r6 = validator.validateTemplateOutput({ schema: schema, csCode: filled });
assert.strictEqual(r6.summary.markerResidueCount, 0, 'Case 6: filled marker must not be flagged');
assert.strictEqual(r6.passed, true, 'Case 6: filled-and-complete code must pass');

// Case 7: cross-file aggregate — phase implemented in companion partial → no failure
var mainNoPhases = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    void Update() { UpdateEnemy(Time.deltaTime); }',
  '    void UpdateEnemy(float dt) {}',
  '}',
].join('\n');
var flowExtra = [
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    void OnPhaseTick() {',
  '        AddCompletedPhase("collectOre");',
  '        AddCompletedPhase("deliverOre");',
  '        AddCompletedPhase("gameEnd");',
  '    }',
  '}',
].join('\n');
var r7 = validator.validateTemplateOutput({
  schema: schema,
  csCode: mainNoPhases,
  extraFiles: { 'GameFlowManagerMain.Flow.cs': flowExtra },
});
assert.strictEqual(r7.passed, true, 'Case 7: cross-file phase calls must aggregate');
assert.strictEqual(r7.summary.phaseImplemented, 3);

// Case 8: schema with no NPCs and no phases → trivially passes
var r8 = validator.validateTemplateOutput({ schema: { phases: [], entities: [], npcs: [] }, csCode: 'class X {}' });
assert.strictEqual(r8.passed, true, 'Case 8: empty schema must pass trivially');
assert.strictEqual(r8.summary.phaseExpected, 0);
assert.strictEqual(r8.summary.npcChecked, 0);

// Case 9: validateFromContext convenience wrapper
var ctx9 = {
  blueprint: { gameSchema: schema },
  csCode: goodMain,
  extraFiles: {},
};
var r9 = validator.validateFromContext(ctx9);
assert.strictEqual(r9.passed, true, 'Case 9: validateFromContext must pull schema from ctx.blueprint.gameSchema');

// Case 10: review's deterministic-skip gate with template-output branch
var ctxOk = {
  blueprint: {
    templateValidation: { passed: true, summary: { criticalCount: 0, markerResidueCount: 0 } },
    templateCoverage: 0.97,
    todoSectionsRemaining: 0,
  },
};
assert.strictEqual(review.isAssemblyReadyForDeterministicReview(ctxOk, [], 0), true,
  'Case 10: template-output gate must pass when validator passed + coverage>=0.95 + no TODOs');

// Case 11: gate must NOT pass if validator failed
var ctxValFail = {
  blueprint: {
    templateValidation: { passed: false, summary: { criticalCount: 2 } },
    templateCoverage: 0.99,
    todoSectionsRemaining: 0,
  },
};
assert.strictEqual(review.isAssemblyReadyForDeterministicReview(ctxValFail, [], 0), false,
  'Case 11: gate must reject when validator failed');

// Case 12: gate must NOT pass if templateCoverage < 0.95
var ctxLowCov = {
  blueprint: {
    templateValidation: { passed: true, summary: { criticalCount: 0 } },
    templateCoverage: 0.80,
    todoSectionsRemaining: 0,
  },
};
assert.strictEqual(review.isAssemblyReadyForDeterministicReview(ctxLowCov, [], 0), false,
  'Case 12: gate must reject when templateCoverage < 0.95');

// Case 13: gate must NOT pass if todoSectionsRemaining > 0
var ctxTodos = {
  blueprint: {
    templateValidation: { passed: true, summary: { criticalCount: 0 } },
    templateCoverage: 0.99,
    todoSectionsRemaining: 2,
  },
};
assert.strictEqual(review.isAssemblyReadyForDeterministicReview(ctxTodos, [], 0), false,
  'Case 13: gate must reject when TODO sections remain');

// Case 14: gate must NOT pass if specCriticalCount > 0
var ctxSpecCrit = {
  blueprint: {
    templateValidation: { passed: true, summary: { criticalCount: 0 } },
    templateCoverage: 0.99,
    todoSectionsRemaining: 0,
  },
};
assert.strictEqual(review.isAssemblyReadyForDeterministicReview(ctxSpecCrit, [], 1), false,
  'Case 14: gate must reject when spec critical count > 0');

// Case 15: gate must NOT pass if staticWarnings is not an array (sentinel for "blocking found")
assert.strictEqual(review.isAssemblyReadyForDeterministicReview(ctxOk, null, 0), false,
  'Case 15: gate must reject when staticWarnings sentinel absent');

// Case 16: legacy assembly-ready gate still works (regression — don't break old path)
var ctxLegacy = {
  blueprint: {
    assemblyDecision: 'assembly_ready',
    assemblyFallbackRequired: false,
    assemblyCoverage: 1.0,
    assemblyImplementationCoverage: 1.0,
    assemblyImplementationMissingCount: 0,
    plans: { assemblyPlan: { unresolved: [] } },
  },
};
assert.strictEqual(review.isAssemblyReadyForDeterministicReview(ctxLegacy, [], 0), true,
  'Case 16: legacy assembly-ready gate must still work');

// Case 17: env override DISABLE_ASSEMBLY_REVIEW_SKIP forces false
process.env.DISABLE_ASSEMBLY_REVIEW_SKIP = 'true';
assert.strictEqual(review.isAssemblyReadyForDeterministicReview(ctxOk, [], 0), false,
  'Case 17: env override must disable both gates');
delete process.env.DISABLE_ASSEMBLY_REVIEW_SKIP;

// Case 18: spawner template regression — Update<entity> naming must align with
// validator (other 11 NPC templates use Update<entity>; spawner historically
// emitted Update<entity>Spawner which produced false-positive npc-method-missing-def
// → fix-loop infinite retry → codex quota burn). 2026-05-05 incident.
var spawnerTpl = require('../adapters/templates/npc-behaviors/spawner.cjs');
var spawnerNpc = {
  entity: 'GarbageSpawner',
  template: 'spawner',
  params: { spawnEntity: 'SpaceGarbage', spawnInterval: 2, maxAlive: 20, spawnRadius: 4 },
};
var spawnerSchema = {
  phases: [{ phaseId: 'p1', trigger: null }],
  entities: [{ name: 'player' }, { name: 'GarbageSpawner' }, { name: 'SpaceGarbage' }],
  npcs: [spawnerNpc],
};
var spawnerCs = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    void Update() {',
  '        ' + spawnerTpl.generateUpdate(spawnerNpc).trim(),
  '        AddCompletedPhase("p1");',
  '    }',
  '    ' + spawnerTpl.generateSystem(spawnerNpc).trim(),
  '}',
].join('\n');
var r18 = validator.validateTemplateOutput({ schema: spawnerSchema, csCode: spawnerCs });
assert.strictEqual(r18.passed, true,
  'Case 18: spawner template output must satisfy validator. Issues: ' + JSON.stringify(r18.issues));
assert.strictEqual(r18.summary.npcDefined, 1, 'Case 18: spawner method def must be detected');
assert.strictEqual(r18.summary.npcCalled, 1, 'Case 18: spawner method call must be detected');

console.log('template-output-validator + review gate: 18 cases passed');
