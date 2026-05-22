#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { validateSemantics } = require('../adapters/schema/validate-schema.cjs');

function makeSchema(trigger) {
  return {
    entities: [
      { name: 'Player' },
      { name: 'Workbench' },
      { name: 'CtaButton' },
    ],
    resources: [],
    phases: [
      {
        phaseId: 'phase1',
        showEntities: ['Player', 'Workbench'],
        hideEntities: [],
        trigger: { type: 'near_entity', entity: 'Workbench', range: 2 },
      },
      {
        phaseId: 'phase2',
        showEntities: ['Player', 'CtaButton'],
        hideEntities: [],
        trigger,
      },
    ],
  };
}

{
  const errors = validateSemantics(makeSchema({ type: 'near_entity', entity: 'CtaButton', range: 2 }));
  assert.deepStrictEqual(errors, [], 'final CtaButton near_entity should be accepted for arrival-only CTA');
}

{
  const errors = validateSemantics(makeSchema({ type: 'click_entity', entity: 'CtaButton' }));
  assert.deepStrictEqual(errors, [], 'final CtaButton click_entity should remain accepted');
}

{
  const errors = validateSemantics(makeSchema({ type: 'click_entity', entity: 'Workbench' }));
  assert.deepStrictEqual(errors, [], 'legacy final click_entity should remain accepted even when target is not CtaButton');
}

{
  const errors = validateSemantics(makeSchema({
    type: 'compound',
    operator: 'and',
    triggers: [
      { type: 'timer', seconds: 0.8 },
      { type: 'near_entity', entity: 'CtaButton', range: 2 },
    ],
  }));
  assert.deepStrictEqual(errors, [], 'compound final CTA should accept nested near_entity CtaButton');
}

{
  const errors = validateSemantics(makeSchema({ type: 'near_entity', entity: 'Workbench', range: 2 }));
  assert.ok(errors.indexOf('Last phase trigger must include click_entity or CtaButton near_entity') >= 0,
    'non-CTA arrival should still fail terminal CTA validation');
}

console.log('schema final CTA validation tests passed');
