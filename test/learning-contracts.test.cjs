const assert = require('assert');

const {
  isInjectablePromotedRule,
} = require('../worker/code-reviewer.js');
const {
  summarizePendingRules,
} = require('../engine/pending-rule-candidates.cjs');
const {
  curatedStatusForDraft,
  curatedBodyForDraft,
} = require('../engine/curate-learning-drafts.cjs');

{
  assert.strictEqual(isInjectablePromotedRule({
    description: 'Real recurring issue',
    rule: 'Architecture',
    crossProjectCount: 2,
  }), true);

  assert.strictEqual(isInjectablePromotedRule({
    description: 'Single project spike',
    rule: 'Architecture',
    crossProjectCount: 1,
  }), false);

  assert.strictEqual(isInjectablePromotedRule({
    description: 'ReportPhase uses UnityEngine.Debug.Log for gameplay flow phase reporting',
    rule: 'auto-promoted critical debug.log runtime reporting risk',
    crossProjectCount: 3,
  }), false);
}

{
  const snapshot = summarizePendingRules([
    {
      description: 'UpdateCarryVisuals() constructs pool names dynamically with "__Pool_Cube_Yellow_" + (60 + i)',
      rule: 'Object Naming — Pool Objects',
      taskId: 'task-a',
      severity: 'warning',
    },
    {
      description: 'UpdateCarryVisuals() constructs pool names dynamically with "__Pool_Cube_Yellow_" + (60 + i)',
      rule: 'Object Naming — Pool Objects',
      taskId: 'task-b',
      severity: 'warning',
    },
    {
      description: 'OnAutoPlayArrive mutates gold/resources directly instead of routing through gameplay handlers.',
      rule: 'AutoPlay State Mutation Forbidden',
      taskId: 'task-a',
      severity: 'critical',
    },
    {
      description: 'OnAutoPlayArrive mutates gold/resources directly instead of routing through gameplay handlers.',
      rule: 'AutoPlay State Mutation Forbidden',
      taskId: 'task-b',
      severity: 'critical',
    },
  ], {
    updatedAt: '2026-04-22T00:00:00.000Z',
  });

  assert.strictEqual(snapshot.updatedAt, '2026-04-22T00:00:00.000Z');
  assert.strictEqual(snapshot.count, 1);
  assert.strictEqual(snapshot.items[0].uniqueTasks, 2);
  assert.match(snapshot.items[0].phrase, /gold\/resources/i);
}

{
  assert.strictEqual(curatedStatusForDraft({
    id: 'draft-a',
    status: 'candidate',
  }), 'review-needed');

  assert.strictEqual(curatedBodyForDraft({
    id: 'draft-a',
    status: 'candidate',
  }), null);

  assert.strictEqual(curatedStatusForDraft({
    id: 'draft-b',
    status: 'candidate',
    reviewStatus: 'approved',
  }), 'active');

  assert.ok(curatedBodyForDraft({
    id: 'draft-b',
    title: 'Draft b',
    category: 'systemic',
    layer: ['prompt'],
    severity: 'warning',
    status: 'candidate',
    reviewStatus: 'approved',
    symptom: 'symptom',
    rootCause: 'cause',
    suggestedAction: 'fix it',
    evidence: { sampleTaskIds: [] },
    createdAt: '2026-04-22T00:00:00.000Z',
  }));
}

console.log('learning contract tests passed');
