const assert = require('assert');

const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');
const { generateDeliverUpdate } = require('../adapters/templates/interactions/deliver-sell.cjs');
const { generateCostClickUpdate } = require('../adapters/templates/interactions/cost-gated-click.cjs');
const { generateMultiSourceVariables } = require('../adapters/templates/interactions/multi-source-collect.cjs');
const { triggerToCondition } = require('../adapters/templates/trigger-codegen.cjs');

{
  const out = generateSkeleton([
    {
      phaseId: 'intro',
      phaseName: 'Intro',
      entitiesRequired: [{ name: 'player' }],
      requiredInteractions: ['wait:1'],
      triggerNext: { condition: 'true' },
      duration: { min: 1, max: 2 },
      playerMustAct: false,
    },
    {
      phaseId: 'tapOre',
      phaseName: 'Tap Ore',
      entitiesRequired: [{ name: 'Ore' }],
      requiredInteractions: ['click:Ore'],
      triggerNext: { condition: 'ore' },
      duration: { min: 3, max: 5 },
      playerMustAct: true,
    },
  ], {
    entityPoolMap: { player: '__Pool_Player', Ore: '__Pool_Ore' },
    entities: [{ name: 'player' }, { name: 'Ore' }],
  });
  const flow = out.flow || '';
  const tapBody = flow.match(/void Phase_tapOre_OnTap\(\)[\s\S]*?TODO_PHASE_tapOre_ONTAP_END/);
  assert.ok(tapBody, 'tap handler should exist');
  assert.doesNotMatch(tapBody[0], /InteractionDone = true|PlayerActed = true/);
}

{
  // 2026-05-04: deliver-sell 改用 GFM_SmoothMover.Bobble 替代 +2y SetPosition,
  // 仍保留"目标实体可观察位移"的 EntityAdvanced 兼容,但不会瞬移到天上。
  const deliver = generateDeliverUpdate({
    resources: [{ name: 'ore' }],
    phases: [{ trigger: { type: 'entity_state_reached', entity: 'SalesDesk', goldPerUnit: 5 } }],
  });
  assert.match(deliver, /GFM_SmoothMover\.Bobble\(SalesDesk, 2f, 0\.6f\)/);
  assert.doesNotMatch(deliver, /SalesDesk\.transform\.position\s*=/);
}

{
  // 2026-05-04: cost-gated-click 同样改 Bobble,旧 var XxxPos = ...; XxxPos.y += 2f 模式废弃。
  const cost = generateCostClickUpdate({
    phases: [{ trigger: { type: 'click_entity', entity: 'Forge' }, cost: { amount: 10, resource: 'gold' } }],
  });
  assert.match(cost, /GFM_SmoothMover\.Bobble\(Forge, 2f, 0\.6f\)/);
  assert.doesNotMatch(cost, /Forge\.transform\.position\s*=/);
}

{
  const cond = triggerToCondition({ type: 'click_entity', entity: 'CTAButton' }, []);
  assert.strictEqual(cond, 'IsNear(CTAButton, 2f) && Input.GetMouseButtonDown(0)');
}

{
  // 2026-05-22: skeleton 已统一声明全部实体 GameObject，多源采集模板不能在 TODO_VARIABLES 里二次声明。
  const schema = {
    resources: [{ name: 'Corn', entity: 'Corn' }],
    entities: [{ name: 'Corn' }, { name: 'CornB' }, { name: 'CornC' }],
  };
  const skeleton = [
    'partial class GameFlowManagerMain {',
    '    GameObject Corn;',
    '    GameObject CornB;',
    '    GameObject CornC;',
    '    // TODO_VARIABLES_START',
    '    // TODO_VARIABLES_END',
    '}',
  ].join('\n');
  assert.strictEqual(generateMultiSourceVariables(schema, skeleton), '');
  assert.match(generateMultiSourceVariables(schema), /GameObject CornB/);
}

console.log('skeleton template regression tests passed');
