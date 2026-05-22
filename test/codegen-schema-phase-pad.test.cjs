/**
 * 2026-05-12 P1b: deterministic 末尾 phase pad.
 *
 * 当 Sonnet 输出截断导致 schema.phases.length < blueprintSpecs.length 时,
 * _repairSchema 会从 specs 反推补齐尾部 phase,避免下一轮 codegen-schema LLM 调用。
 * - phaseId: 取自 spec.phaseId
 * - showEntities: 取自 spec.entitiesRequired (string 或 {name})
 * - trigger: 走 deterministic-trigger-normalizer 从 DSL 反推
 * - 末位 phase 强制注入 click_entity (CTA gate)
 */

var assert = require('assert');
var codegenSchema = require('../engine/stages/codegen-schema.cjs');

function makeSchemaWithEntities(entityNames) {
  return {
    gameConfig: {
      cameraBackground: [0.5, 0.7, 1.0],
      groundColor: [0.3, 0.6, 0.2],
      moveSpeed: 5.0,
      collectRange: 2.0,
      maxCarry: 10,
    },
    entities: entityNames.map(function(name, i) {
      return {
        name: name,
        chineseName: name + '中文',
        showLabel: true,
        pool: '__Pool_Cube_White_' + String(i + 1).padStart(2, '0'),
        initPos: [i, 1, 0],
        scale: 1.0,
      };
    }),
    resources: [],
    phases: [],
    npcs: [],
    customLogic: [],
  };
}

// 1. Schema 有 2 phase,specs 有 4 — 补齐 2 个尾部 phase
(function testTailPaddingBasic() {
  var schema = makeSchemaWithEntities(['Forge', 'Workshop', 'Ore', 'CTAButton']);
  schema.phases = [
    { phaseId: 'intro', showEntities: ['Forge'], trigger: { type: 'near_entity', entity: 'Forge', range: 2 } },
    { phaseId: 'gather', showEntities: ['Ore'], trigger: { type: 'resource_collected', resource: 'ore', amount: 3 } },
  ];
  var blueprintEnts = schema.entities.slice();
  var specs = [
    { phaseId: 'intro', requiredInteractions: [], entitiesRequired: [{ name: 'Forge' }] },
    { phaseId: 'gather', requiredInteractions: ['collect:ore:3'], entitiesRequired: [{ name: 'Ore' }] },
    { phaseId: 'build', requiredInteractions: ['build:Workshop'], entitiesRequired: [{ name: 'Workshop' }], shortDescription: '建造工坊' },
    { phaseId: 'cta', requiredInteractions: ['click:CTAButton'], entitiesRequired: [{ name: 'CTAButton' }], shortDescription: '开始游戏' },
  ];

  codegenSchema._repairSchema(schema, blueprintEnts, specs);

  assert.strictEqual(schema.phases.length, 4, 'phases padded to spec count, got ' + schema.phases.length);
  assert.strictEqual(schema.phases[2].phaseId, 'build');
  assert.strictEqual(schema.phases[3].phaseId, 'cta');
  // build phase 用 entity_state_reached(state=2 = built)
  assert.strictEqual(schema.phases[2].trigger.type, 'entity_state_reached');
  assert.strictEqual(schema.phases[2].trigger.entity, 'Workshop');
  assert.strictEqual(schema.phases[2].trigger.state, 2);
  // 末位 trigger 必含 click_entity 或 compound(含 click_entity)
  var lastTrig = schema.phases[3].trigger;
  var hasClick = lastTrig.type === 'click_entity' ||
    (lastTrig.type === 'compound' && lastTrig.triggers.some(function(t) { return t.type === 'click_entity'; }));
  assert.ok(hasClick, '末位 phase 必须含 click_entity,实际 = ' + JSON.stringify(lastTrig));
  // showEntities 从 entitiesRequired 反推
  assert.deepStrictEqual(schema.phases[2].showEntities, ['Workshop']);
  assert.deepStrictEqual(schema.phases[3].showEntities, ['CTAButton']);
  // guideText 优先 shortDescription
  assert.strictEqual(schema.phases[2].guideText, '建造工坊');
  console.log('  ✓ tail-padding: 2 phases padded with DSL-derived trigger');
})();

// 2. phases.length === specs.length 时不做任何 pad
(function testNoPadWhenEqualLength() {
  var schema = makeSchemaWithEntities(['Forge', 'CTAButton']);
  schema.phases = [
    { phaseId: 'p1', showEntities: ['Forge'], trigger: { type: 'near_entity', entity: 'Forge', range: 2 } },
    { phaseId: 'p2', showEntities: ['CTAButton'], trigger: { type: 'click_entity', entity: 'CTAButton' } },
  ];
  var specs = [
    { phaseId: 'p1', requiredInteractions: [], entitiesRequired: [{ name: 'Forge' }] },
    { phaseId: 'p2', requiredInteractions: ['click:CTAButton'], entitiesRequired: [{ name: 'CTAButton' }] },
  ];
  codegenSchema._repairSchema(schema, schema.entities.slice(), specs);
  assert.strictEqual(schema.phases.length, 2, 'no padding when counts match');
  assert.strictEqual(schema.phases[0].phaseId, 'p1');
  assert.strictEqual(schema.phases[1].phaseId, 'p2');
  console.log('  ✓ no-pad: equal counts untouched');
})();

// 3. specs.length < phases.length 时也不 pad
(function testNoPadWhenSpecsShort() {
  var schema = makeSchemaWithEntities(['Forge', 'CTAButton']);
  schema.phases = [
    { phaseId: 'p1', showEntities: ['Forge'], trigger: { type: 'near_entity', entity: 'Forge', range: 2 } },
    { phaseId: 'p2', showEntities: ['CTAButton'], trigger: { type: 'click_entity', entity: 'CTAButton' } },
    { phaseId: 'p3', showEntities: ['CTAButton'], trigger: { type: 'click_entity', entity: 'CTAButton' } },
  ];
  var specs = [{ phaseId: 'p1', requiredInteractions: [], entitiesRequired: [] }];
  codegenSchema._repairSchema(schema, schema.entities.slice(), specs);
  assert.strictEqual(schema.phases.length, 3);
  console.log('  ✓ no-pad: specs shorter than phases is left alone');
})();

// 4. entitiesRequired 是字符串数组(legacy 形式)也能取到 showEntities
(function testEntitiesRequiredStringForm() {
  var schema = makeSchemaWithEntities(['Forge', 'CTAButton']);
  schema.phases = [{ phaseId: 'p1', showEntities: ['Forge'], trigger: { type: 'near_entity', entity: 'Forge', range: 2 } }];
  var specs = [
    { phaseId: 'p1', requiredInteractions: [], entitiesRequired: ['Forge'] },
    { phaseId: 'p2', requiredInteractions: ['click:CTAButton'], entitiesRequired: ['CTAButton'] },
  ];
  codegenSchema._repairSchema(schema, schema.entities.slice(), specs);
  assert.strictEqual(schema.phases.length, 2);
  assert.deepStrictEqual(schema.phases[1].showEntities, ['CTAButton']);
  console.log('  ✓ entitiesRequired string form accepted');
})();

// 5. 无 DSL 推导时,末位 fallback 到 click_entity,中间 fallback 到 near_entity
(function testFallbackTriggersWhenNoDsl() {
  var schema = makeSchemaWithEntities(['Player', 'CTAButton']);
  schema.phases = [{ phaseId: 'p1', showEntities: ['Player'], trigger: { type: 'near_entity', entity: 'Player', range: 2 } }];
  var specs = [
    { phaseId: 'p1', requiredInteractions: [], entitiesRequired: [{ name: 'Player' }] },
    { phaseId: 'p2', requiredInteractions: [], entitiesRequired: [] }, // 中间 fallback
    { phaseId: 'p3', requiredInteractions: [], entitiesRequired: [] }, // 末位 fallback
  ];
  codegenSchema._repairSchema(schema, schema.entities.slice(), specs);
  assert.strictEqual(schema.phases.length, 3);
  assert.strictEqual(schema.phases[1].trigger.type, 'near_entity', '中间 phase 走 near_entity');
  var lastTrig = schema.phases[2].trigger;
  var hasClick = lastTrig.type === 'click_entity' ||
    (lastTrig.type === 'compound' && lastTrig.triggers.some(function(t) { return t.type === 'click_entity'; }));
  assert.ok(hasClick, '末位 phase 必须含 click_entity');
  console.log('  ✓ fallback triggers when no DSL: near_entity (mid) / click_entity (last)');
})();

// 6. 末位没有 CTA gate 但有 DSL 推出别的 trigger 时,包成 compound + CtaButton near_entity
(function testWrapLastInCompound() {
  var schema = makeSchemaWithEntities(['Workshop', 'CTAButton']);
  schema.phases = [{ phaseId: 'p1', showEntities: ['Workshop'], trigger: { type: 'near_entity', entity: 'Workshop', range: 2 } }];
  var specs = [
    { phaseId: 'p1', requiredInteractions: [], entitiesRequired: [{ name: 'Workshop' }] },
    { phaseId: 'p2', requiredInteractions: ['build:Workshop'], entitiesRequired: [{ name: 'Workshop' }] },
  ];
  codegenSchema._repairSchema(schema, schema.entities.slice(), specs);
  assert.strictEqual(schema.phases.length, 2);
  var lastTrig = schema.phases[1].trigger;
  assert.strictEqual(lastTrig.type, 'compound', '末位缺 CTA gate 时必须包成 compound');
  var hasCtaArrival = lastTrig.triggers.some(function(t) {
    return t.type === 'near_entity' && /^CTAButton$/i.test(t.entity);
  });
  assert.ok(hasCtaArrival, 'compound 内必须有 CtaButton near_entity');
  console.log('  ✓ wrap-last-in-compound: non-CTA trigger + CtaButton near_entity');
})();

// 7. 末位 phase 已经是 click_entity 时不重新包
(function testKeepLastClickEntity() {
  var schema = makeSchemaWithEntities(['Forge', 'CTAButton']);
  schema.phases = [{ phaseId: 'p1', showEntities: ['Forge'], trigger: { type: 'near_entity', entity: 'Forge', range: 2 } }];
  var specs = [
    { phaseId: 'p1', requiredInteractions: [], entitiesRequired: [{ name: 'Forge' }] },
    { phaseId: 'p2', requiredInteractions: ['click:CTAButton'], entitiesRequired: [{ name: 'CTAButton' }] },
  ];
  codegenSchema._repairSchema(schema, schema.entities.slice(), specs);
  assert.strictEqual(schema.phases[1].trigger.type, 'click_entity');
  assert.strictEqual(schema.phases[1].trigger.entity, 'CTAButton');
  console.log('  ✓ keep-last-click-entity: not re-wrapped');
})();

console.log('\ncodegen-schema phase pad: 7 cases passed');
