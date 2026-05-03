// 2026-04-21: verify each interaction template emits exactly one observable-movement
// statement per target, matching what `phase-entity-init-only` (static-check) and
// `EntityAdvanced` (skeleton phase-exit gate) require at runtime.
// Entity names stay PascalCase (toLowerCamel is a PascalCase-passthrough here —
// see feedback_entity_name_pascal_case memory).

const { generateCollectUpdate } = require('../adapters/templates/interactions/collect-interaction.cjs');
const { generateDeliverUpdate } = require('../adapters/templates/interactions/deliver-sell.cjs');
const { generateCostClickUpdate } = require('../adapters/templates/interactions/cost-gated-click.cjs');

function countMoves(code, entity) {
  const patterns = [
    new RegExp('\\bPlaceObj\\s*\\(\\s*' + entity + '\\b', 'g'),
    new RegExp('\\bHideObj\\s*\\(\\s*' + entity + '\\b', 'g'),
    new RegExp('\\b' + entity + '\\s*\\.\\s*transform\\s*\\.\\s*position\\s*=', 'g'),
  ];
  return patterns.reduce((sum, re) => sum + (code.match(re) || []).length, 0);
}

describe('interaction templates emit observable-movement per target', () => {
  test('collect-interaction: each resource entity gets HideObj + respawn PlaceObj', () => {
    // 2026-05-03: 单次采集→HideObj 满足 EntityAdvanced 退出 gate；2s 后 PlaceObj 回填
    // 让单源采集不会一次就锁死（参考 SpaceGarbage 8→13 冻住的事故）。
    const schema = {
      gameConfig: { collectRange: 2, maxCarry: 10 },
      resources: [
        { name: 'ice', entity: 'IceOre', maxStock: 5 },
        { name: 'rock', entity: 'SpaceRock', maxStock: 8 },
      ],
    };
    const code = generateCollectUpdate(schema);
    expect(countMoves(code, 'IceOre')).toBe(2);
    expect(countMoves(code, 'SpaceRock')).toBe(2);
    expect(code).toMatch(/HideObj\(IceOre\)/);
    expect(code).toMatch(/HideObj\(SpaceRock\)/);
    expect(code).toMatch(/PlaceObj\(IceOre,/);
    expect(code).toMatch(/PlaceObj\(SpaceRock,/);
  });

  test('deliver-sell: each delivery target gets transform.position pop', () => {
    const schema = {
      resources: [{ name: 'ore', entity: 'IceOre' }],
      phases: [
        { trigger: { type: 'entity_state_reached', entity: 'Smelter', goldPerUnit: 5 } },
        { trigger: { type: 'entity_state_reached', entity: 'Market', goldPerUnit: 10 } },
      ],
    };
    const code = generateDeliverUpdate(schema);
    expect(countMoves(code, 'Smelter')).toBe(1);
    expect(countMoves(code, 'Market')).toBe(1);
    expect(code).toMatch(/Smelter\.transform\.position\s*=/);
    expect(code).toMatch(/Market\.transform\.position\s*=/);
  });

  test('cost-gated-click: cost>0 branch pops transform.position', () => {
    const schema = {
      phases: [
        {
          trigger: { type: 'click_entity', entity: 'ForgeWorkshop' },
          cost: { resource: 'gold', amount: 50 },
        },
      ],
    };
    const code = generateCostClickUpdate(schema);
    expect(countMoves(code, 'ForgeWorkshop')).toBe(1);
    expect(code).toMatch(/ForgeWorkshop\.transform\.position\s*=/);
  });

  test('cost-gated-click: free click branch pops transform.position', () => {
    const schema = {
      phases: [
        {
          trigger: { type: 'click_entity', entity: 'Crossbow' },
        },
      ],
    };
    const code = generateCostClickUpdate(schema);
    expect(countMoves(code, 'Crossbow')).toBe(1);
    expect(code).toMatch(/Crossbow\.transform\.position\s*=/);
  });

  test('cost-gated-click: multiple targets each get exactly one move', () => {
    const schema = {
      phases: [
        { trigger: { type: 'click_entity', entity: 'ForgeA' }, cost: { amount: 10 } },
        { trigger: { type: 'click_entity', entity: 'ForgeB' } },
      ],
    };
    const code = generateCostClickUpdate(schema);
    expect(countMoves(code, 'ForgeA')).toBe(1);
    expect(countMoves(code, 'ForgeB')).toBe(1);
  });
});
