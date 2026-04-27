#!/usr/bin/env node
/**
 * 2026-04-27: deterministic-trigger-normalizer locks per-DSL-verb derivation.
 *
 * The cases below were extracted from a real production checkpoint
 * (proj_1777127909317_ksgqw6, 11 phases, all triggers LLM-generated and
 * accepted by Ajv). The normalizer's deterministic derivation should match
 * the LLM output on at least all "trivial" patterns (collect / build / CTA).
 * Disagreements on borderline patterns (deliver state numbering) are
 * documented as KNOWN — the normalizer emits status='disagree' which the
 * caller can choose to apply or log.
 */

var assert = require('assert');
var n = require('../adapters/deterministic-trigger-normalizer.cjs');

// ---------- Pure derivation tests ----------

// 1. collect:resource:N
var t1 = n.deriveTriggerFromInteractions(
  ['click:SpaceshipDebris', 'move_to:SpaceshipDebris', 'collect:metal:1'], []
);
assert.deepStrictEqual(t1, { type: 'resource_collected', resource: 'metal', amount: 1 },
  'Case 1: collect:metal:1 → resource_collected');

// 2. collect:bullet:10 (larger amount)
var t2 = n.deriveTriggerFromInteractions(
  ['click:BulletProcessor', 'move_to:BulletProcessor', 'collect:bullet:10'], []
);
assert.deepStrictEqual(t2, { type: 'resource_collected', resource: 'bullet', amount: 10 },
  'Case 2: collect:bullet:10');

// 3. collect:gold:20
var t3 = n.deriveTriggerFromInteractions(
  ['click:GoldUI', 'move_to:GoldUI', 'collect:gold:20'], []
);
assert.deepStrictEqual(t3, { type: 'resource_collected', resource: 'gold', amount: 20 });

// 4. build:Entity → entity_state_reached state=2
var entities4 = [{ name: 'ResourceConveyor' }];
var t4 = n.deriveTriggerFromInteractions(
  ['click:ResourceConveyor', 'spend:gold:50', 'build:ResourceConveyor'], entities4
);
assert.deepStrictEqual(t4, { type: 'entity_state_reached', entity: 'ResourceConveyor', state: 2 },
  'Case 4: build:Entity → state=2');

// 5. upgrade single entity
var entities5 = [{ name: 'WorkerAI' }];
var t5 = n.deriveTriggerFromInteractions(
  ['click:Player', 'spend:gold:10', 'upgrade:worker:2'], entities5
);
// upgrade:worker → loose-match to WorkerAI by substring
assert.deepStrictEqual(t5, { type: 'entity_state_reached', entity: 'WorkerAI', state: 2 },
  'Case 5: upgrade:worker:2 → loose-matches WorkerAI');

// 6. multiple upgrades → compound and
var entities6 = [{ name: 'TurretLeft' }, { name: 'TurretMiddle' }, { name: 'TurretRight' }];
var t6 = n.deriveTriggerFromInteractions([
  'click:TurretLeft', 'spend:gold:30',
  'upgrade:TurretLeft:3', 'upgrade:TurretMiddle:3', 'upgrade:TurretRight:3'
], entities6);
assert.strictEqual(t6.type, 'compound');
assert.strictEqual(t6.operator, 'and');
assert.strictEqual(t6.triggers.length, 3);
assert.deepStrictEqual(t6.triggers[0], { type: 'entity_state_reached', entity: 'TurretLeft', state: 3 });
assert.deepStrictEqual(t6.triggers[2], { type: 'entity_state_reached', entity: 'TurretRight', state: 3 });

// 7. deliver:resource:Entity → entity_state_reached state=1 (default loaded)
var entities7 = [{ name: 'TurretLeft' }];
var t7 = n.deriveTriggerFromInteractions(
  ['click:TurretLeft', 'move_to:TurretLeft', 'deliver:bullet:TurretLeft'], entities7
);
assert.deepStrictEqual(t7, { type: 'entity_state_reached', entity: 'TurretLeft', state: 1 },
  'Case 7: deliver → state=1 default');

// 8. CTA terminal click
var entities8 = [{ name: 'CTAButton' }];
var t8 = n.deriveTriggerFromInteractions(['click:CTAButton'], entities8);
assert.deepStrictEqual(t8, { type: 'click_entity', entity: 'CTAButton' },
  'Case 8: pure click on CTA → click_entity');

// 9. recruit with role-name mismatch (worker → WorkerAI substring match)
var entities9 = [{ name: 'WorkerAI' }];
var t9 = n.deriveTriggerFromInteractions(
  ['click:BasePlatform', 'spend:gold:20', 'recruit:worker:1'], entities9
);
assert.deepStrictEqual(t9, { type: 'entity_state_reached', entity: 'WorkerAI', state: 1 });

// 10. empty interactions → null (no derivation; LLM stays in charge)
assert.strictEqual(n.deriveTriggerFromInteractions([], []), null);
assert.strictEqual(n.deriveTriggerFromInteractions(null, []), null);

// 11. ambiguous (only click on non-CTA) → null
assert.strictEqual(n.deriveTriggerFromInteractions(['click:RandomThing'], []), null);

// ---------- triggersEqual tests ----------

// 12. equality
assert.strictEqual(n.triggersEqual(
  { type: 'resource_collected', resource: 'gold', amount: 5 },
  { type: 'resource_collected', resource: 'GOLD', amount: 5 }
), true, 'Case 12: resource compare is case-insensitive');

assert.strictEqual(n.triggersEqual(
  { type: 'resource_collected', resource: 'gold', amount: 5 },
  { type: 'resource_collected', resource: 'gold', amount: 6 }
), false, 'Case 12b: amount mismatch ≠ equal');

// 13. compound with reordered children → equal under `and`
var ca = { type: 'compound', operator: 'and', triggers: [
  { type: 'entity_state_reached', entity: 'A', state: 1 },
  { type: 'entity_state_reached', entity: 'B', state: 2 },
]};
var cb = { type: 'compound', operator: 'and', triggers: [
  { type: 'entity_state_reached', entity: 'B', state: 2 },
  { type: 'entity_state_reached', entity: 'A', state: 1 },
]};
assert.strictEqual(n.triggersEqual(ca, cb), true, 'Case 13: compound `and` is order-insensitive');

// ---------- Schema-level analyze tests ----------

// 14. analyze: phase whose trigger matches derivation → status='agree'
var schema14 = {
  entities: [{ name: 'SpaceshipDebris' }],
  phases: [{
    phaseId: 'p1',
    showEntities: ['SpaceshipDebris'],
    trigger: { type: 'resource_collected', resource: 'metal', amount: 1 },
  }],
};
var specs14 = [{ phaseId: 'p1', requiredInteractions: ['collect:metal:1'] }];
var r14 = n.analyzeSchemaTriggers(schema14, specs14);
assert.strictEqual(r14.diagnostics[0].status, 'agree');
assert.strictEqual(r14.applied, 0); // analyze never applies

// 15. analyze: phase trigger disagrees with derivation → status='disagree'
var schema15 = {
  entities: [{ name: 'SpaceshipDebris' }],
  phases: [{
    phaseId: 'p1',
    showEntities: ['SpaceshipDebris'],
    trigger: { type: 'timer', seconds: 10 }, // wrong: should be resource_collected
  }],
};
var specs15 = [{ phaseId: 'p1', requiredInteractions: ['collect:metal:1'] }];
var r15 = n.analyzeSchemaTriggers(schema15, specs15);
assert.strictEqual(r15.diagnostics[0].status, 'disagree');
assert.deepStrictEqual(r15.diagnostics[0].derivedTrigger,
  { type: 'resource_collected', resource: 'metal', amount: 1 });
// schema must be unmutated
assert.deepStrictEqual(schema15.phases[0].trigger, { type: 'timer', seconds: 10 });

// 16. apply: phase trigger gets rewritten when disagree
var schema16 = JSON.parse(JSON.stringify(schema15)); // deep copy
var r16 = n.applyDerivedTriggers(schema16, specs15);
assert.strictEqual(r16.applied, 1);
assert.deepStrictEqual(schema16.phases[0].trigger,
  { type: 'resource_collected', resource: 'metal', amount: 1 },
  'Case 16: apply must mutate schema in-place');

// 17. env-driven maybeNormalize off (default)
var schema17 = { entities: [], phases: [{ phaseId: 'x', showEntities: [], trigger: { type: 'timer', seconds: 1 } }] };
var specs17 = [{ phaseId: 'x', requiredInteractions: ['collect:gold:5'] }];
delete process.env.DETERMINISTIC_TRIGGER_NORMALIZE;
var r17 = n.maybeNormalize(schema17, specs17);
assert.strictEqual(r17.mode, 'off');
assert.strictEqual(r17.applied, 0);
assert.deepStrictEqual(schema17.phases[0].trigger, { type: 'timer', seconds: 1 }, 'off mode must not mutate');

// 18. shadow mode → diagnostics produced, schema untouched
process.env.DETERMINISTIC_TRIGGER_NORMALIZE = 'shadow';
var schema18 = JSON.parse(JSON.stringify(schema17));
var r18 = n.maybeNormalize(schema18, specs17);
assert.strictEqual(r18.mode, 'analyze');
assert.strictEqual(r18.diagnostics[0].status, 'disagree');
assert.deepStrictEqual(schema18.phases[0].trigger, { type: 'timer', seconds: 1 }, 'shadow must not mutate');

// 19. apply mode → schema rewritten
process.env.DETERMINISTIC_TRIGGER_NORMALIZE = 'apply';
var schema19 = JSON.parse(JSON.stringify(schema17));
var r19 = n.maybeNormalize(schema19, specs17);
assert.strictEqual(r19.mode, 'apply');
assert.strictEqual(r19.applied, 1);
assert.deepStrictEqual(schema19.phases[0].trigger,
  { type: 'resource_collected', resource: 'gold', amount: 5 });
delete process.env.DETERMINISTIC_TRIGGER_NORMALIZE;

// 20. spec-by-index fallback when phaseId missing on spec
var schema20 = { entities: [], phases: [{ phaseId: 'p1', showEntities: [], trigger: { type: 'timer', seconds: 5 } }] };
var specs20 = [{ requiredInteractions: ['collect:wood:3'] }]; // no phaseId
var r20 = n.analyzeSchemaTriggers(schema20, specs20);
assert.strictEqual(r20.diagnostics[0].status, 'disagree');
assert.deepStrictEqual(r20.diagnostics[0].derivedTrigger,
  { type: 'resource_collected', resource: 'wood', amount: 3 });

// 21. real-checkpoint regression: 11-phase production schema
// Verifies all 11 LLM-generated triggers (proj_1777127909317_ksgqw6).
// 'agree' for trivial DSL, 'disagree' acceptable for cases where LLM has
// spec-author intent the DSL doesn't capture (e.g. terminalState != 1).
var realSchemaPhases = [
  { phaseId: 'spaceBaseOpening',                trigger: { type: 'resource_collected', resource: 'metal', amount: 1 } },
  { phaseId: 'deliverMaterialToProcessor',      trigger: { type: 'entity_state_reached', entity: 'BulletProcessor', state: 2 } },
  { phaseId: 'collectManufacturedBullet',       trigger: { type: 'resource_collected', resource: 'bullet', amount: 10 } },
  { phaseId: 'loadBulletForTurret',             trigger: { type: 'entity_state_reached', entity: 'TurretLeft', state: 1 } },
  { phaseId: 'collectKillRewardGold',           trigger: { type: 'resource_collected', resource: 'gold', amount: 20 } },
  { phaseId: 'upgradeUnlockNewWorker',          trigger: { type: 'entity_state_reached', entity: 'WorkerAI', state: 1 } },
  { phaseId: 'upgradeWorkerCollectionEfficiency', trigger: { type: 'entity_state_reached', entity: 'WorkerAI', state: 2 } },
  { phaseId: 'buildResourceConveyor',           trigger: { type: 'entity_state_reached', entity: 'ResourceConveyor', state: 2 } },
  { phaseId: 'buildBulletConveyor',             trigger: { type: 'entity_state_reached', entity: 'BulletConveyor', state: 2 } },
  { phaseId: 'upgradeTurretToGatling', trigger: { type: 'compound', operator: 'and', triggers: [
    { type: 'entity_state_reached', entity: 'TurretLeft', state: 3 },
    { type: 'entity_state_reached', entity: 'TurretMiddle', state: 3 },
    { type: 'entity_state_reached', entity: 'TurretRight', state: 3 }
  ]}},
  { phaseId: 'victoryCtaJump',                  trigger: { type: 'click_entity', entity: 'CTAButton' } },
];
var realSpecs = [
  { phaseId: 'spaceBaseOpening',                requiredInteractions: ['click:SpaceshipDebris','move_to:SpaceshipDebris','collect:metal:1'] },
  { phaseId: 'deliverMaterialToProcessor',      requiredInteractions: ['click:BulletProcessor','move_to:BulletProcessor','deliver:metal:BulletProcessor'] },
  { phaseId: 'collectManufacturedBullet',       requiredInteractions: ['click:BulletProcessor','move_to:BulletProcessor','collect:bullet:10'] },
  { phaseId: 'loadBulletForTurret',             requiredInteractions: ['click:TurretLeft','move_to:TurretLeft','deliver:bullet:TurretLeft'] },
  { phaseId: 'collectKillRewardGold',           requiredInteractions: ['click:GoldUI','move_to:GoldUI','collect:gold:20'] },
  { phaseId: 'upgradeUnlockNewWorker',          requiredInteractions: ['click:BasePlatform','spend:gold:20','recruit:worker:1'] },
  { phaseId: 'upgradeWorkerCollectionEfficiency', requiredInteractions: ['click:Player','spend:gold:10','upgrade:worker:2'] },
  { phaseId: 'buildResourceConveyor',           requiredInteractions: ['click:ResourceConveyor','spend:gold:50','build:ResourceConveyor'] },
  { phaseId: 'buildBulletConveyor',             requiredInteractions: ['click:BulletConveyor','spend:gold:60','build:BulletConveyor'] },
  { phaseId: 'upgradeTurretToGatling',          requiredInteractions: ['click:TurretLeft','spend:gold:30','upgrade:TurretLeft:3','upgrade:TurretMiddle:3','upgrade:TurretRight:3'] },
  { phaseId: 'victoryCtaJump',                  requiredInteractions: ['click:CTAButton'] },
];
var realSchema = {
  entities: [
    {name:'Player'},{name:'BulletProcessor'},{name:'TurretLeft'},{name:'TurretMiddle'},{name:'TurretRight'},
    {name:'WorkerAI'},{name:'ResourceConveyor'},{name:'BulletConveyor'},{name:'CTAButton'},
    {name:'SpaceshipDebris'},{name:'GoldUI'},{name:'BasePlatform'},
  ],
  phases: realSchemaPhases,
};
var realResult = n.analyzeSchemaTriggers(realSchema, realSpecs);
var agreeCount = realResult.diagnostics.filter(function(d){return d.status==='agree';}).length;
var disagreeCount = realResult.diagnostics.filter(function(d){return d.status==='disagree';}).length;
var noDerivCount = realResult.diagnostics.filter(function(d){return d.status==='no-derivation';}).length;
// On this real checkpoint: deliverMaterialToProcessor has LLM state=2 vs derived state=1
// (LLM inferred from "MaterialFilled == true" which is the post-fill state). One disagree expected.
console.log('  Real-data check: 11 phases — agree=' + agreeCount + ' disagree=' + disagreeCount + ' no-deriv=' + noDerivCount);
assert.ok(agreeCount >= 9, 'Case 21: at least 9/11 real-data triggers must agree (got ' + agreeCount + ')');
assert.ok(disagreeCount <= 2, 'Case 21: at most 2/11 real-data triggers may disagree (got ' + disagreeCount + ')');
assert.strictEqual(noDerivCount, 0, 'Case 21: every real phase must have a derivation');

console.log('deterministic-trigger-normalizer: 21 cases passed');
