const assert = require('assert');

const methodCheck = require('../engine/stages/method-check.cjs');

{
  const ctx = { blueprint: { feedbackHistory: [] } };
  const entry = {
    source: 'codegen-contract-check',
    rule: 'forbidden-generic-api',
    message: 'Forbidden generic component APIs detected: GetComponent<Renderer>.',
    severity: 'critical',
  };
  methodCheck.pushFeedbackUnique(ctx, entry);
  methodCheck.pushFeedbackUnique(ctx, Object.assign({}, entry));
  assert.strictEqual(ctx.blueprint.feedbackHistory.length, 1);
}

{
  const ctx = { blueprint: { feedbackHistory: [] } };
  methodCheck.pushFeedbackUnique(ctx, {
    source: 'phase-gate-contract-check',
    rule: 'phase-entity-init-only',
    file: 'main',
    line: 12,
    message: 'EntityAdvanced(goldObj, _snap_goldObjPos) only moved in init.',
    severity: 'critical',
  });
  methodCheck.pushFeedbackUnique(ctx, {
    source: 'phase-gate-contract-check',
    rule: 'phase-entity-init-only',
    file: 'main',
    line: 12,
    message: 'EntityAdvanced(goldObj, _snap_goldObjPos) only moved in init.',
    severity: 'critical',
  });
  assert.strictEqual(ctx.blueprint.feedbackHistory.length, 1);
}

console.log('method-check feedback dedupe tests passed');
