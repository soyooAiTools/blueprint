const assert = require('assert');

const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');
const { generateDeliverUpdate } = require('../adapters/templates/interactions/deliver-sell.cjs');
const { generateCostClickUpdate } = require('../adapters/templates/interactions/cost-gated-click.cjs');
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
  const deliver = generateDeliverUpdate({
    resources: [{ name: 'ore' }],
    phases: [{ trigger: { type: 'entity_state_reached', entity: 'SalesDesk', goldPerUnit: 5 } }],
  });
  assert.match(deliver, /var SalesDeskPos = SalesDesk\.transform\.position;/);
  assert.doesNotMatch(deliver, /SalesDesk\.transform\.position = SalesDesk\.transform\.position \+ new Vector3/);
}

{
  const cost = generateCostClickUpdate({
    phases: [{ trigger: { type: 'click_entity', entity: 'Forge' }, cost: { amount: 10, resource: 'gold' } }],
  });
  assert.match(cost, /var ForgePos = Forge\.transform\.position;/);
  assert.doesNotMatch(cost, /new Vector3\(Forge\.transform\.position\.x/);
}

{
  const cond = triggerToCondition({ type: 'click_entity', entity: 'CTAButton' }, []);
  assert.strictEqual(cond, 'IsNear(CTAButton, 2f) && Input.GetMouseButtonDown(0)');
}

console.log('skeleton template regression tests passed');
