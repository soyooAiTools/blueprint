const assert = require('assert');
const stage = require('../engine/stages/fidelity-source-diff.cjs');

const pushBlueprintFeedback = stage._internals.pushBlueprintFeedback;
assert.strictEqual(typeof pushBlueprintFeedback, 'function');

{
  const ctx = { blueprint: { feedbackHistory: [] } };
  const entry = { source: 'fidelity-source-diff', type: 'canvas-never-rendered' };
  const history = pushBlueprintFeedback(ctx, entry);
  assert.strictEqual(history, ctx.blueprint.feedbackHistory);
  assert.strictEqual(ctx.feedbackHistory, ctx.blueprint.feedbackHistory);
  assert.deepStrictEqual(ctx.blueprint.feedbackHistory, [entry]);
}

{
  const ctx = {};
  pushBlueprintFeedback(ctx, { source: 'fidelity-source-diff' });
  assert.ok(ctx.blueprint);
  assert.strictEqual(ctx.blueprint.feedbackHistory.length, 1);
  assert.strictEqual(ctx.feedbackHistory, ctx.blueprint.feedbackHistory);
}

console.log('fidelity-source-diff feedback history tests passed');
