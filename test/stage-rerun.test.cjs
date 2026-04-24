const assert = require('assert');

const stageRerun = require('../engine/stage-rerun.cjs');

{
  const reset = stageRerun.buildTaskReset({
    metadata_json: JSON.stringify({
      blueprintEditorId: 'proj_test',
      outerFpHistory: ['same-code-fingerprint'],
      source: 'blueprint-editor',
    }),
  }, '[stage-rerun] restart from codegen');

  assert.strictEqual(reset.status, 'pending');
  assert.strictEqual(reset.assigned_to, null);
  assert.strictEqual(reset.assigned_at, null);
  assert.strictEqual(reset.retry_after, null);
  assert.strictEqual(reset.fail_count, 0);
  assert.strictEqual(reset.infra_retry_count, 0);
  assert.strictEqual(reset.code_retry_count, 0);

  const metadata = JSON.parse(reset.metadata_json);
  assert.strictEqual(metadata.blueprintEditorId, 'proj_test');
  assert.strictEqual(metadata.source, 'blueprint-editor');
  assert.ok(!Object.prototype.hasOwnProperty.call(metadata, 'outerFpHistory'));
}

{
  assert.strictEqual(stageRerun.scrubTaskMetadataJsonForRerun('not-json'), 'not-json');
}

{
  const project = stageRerun.prepareProjectForRerun({
    status: 'failed',
    statusMessage: 'old failure',
    lastFailure: { failedAtStage: 'review' },
    failureHistory: [{ failedAtStage: 'review' }],
  }, '[stage-rerun] restart from review', '2026-04-23T00:00:00.000Z');

  assert.strictEqual(project.status, 'submitted');
  assert.strictEqual(project.statusMessage, '[stage-rerun] restart from review');
  assert.strictEqual(project.updatedAt, '2026-04-23T00:00:00.000Z');
  assert.ok(!Object.prototype.hasOwnProperty.call(project, 'lastFailure'));
  assert.strictEqual(project.failureHistory.length, 1);
}

{
  const checkpoint = stageRerun.scrubCheckpointFor('assembly-plan', {
    completedStages: ['clone', 'spec-extract', 'spec-validate', 'complexity-gate', 'assembly-plan', 'codegen'],
    stageResults: {
      clone: { passed: true },
      'spec-extract': { passed: true },
      'spec-validate': { passed: true },
      'complexity-gate': { passed: true },
      'assembly-plan': { passed: true },
      codegen: { passed: true },
    },
    csCode: 'old code',
    extraFiles: { 'GameFlowManagerMain.cs': 'old code' },
  });

  assert.deepStrictEqual(checkpoint.completedStages, ['clone', 'spec-extract', 'spec-validate', 'complexity-gate']);
  assert.ok(!Object.prototype.hasOwnProperty.call(checkpoint.stageResults, 'assembly-plan'));
  assert.ok(!Object.prototype.hasOwnProperty.call(checkpoint, 'csCode'));
  assert.ok(!Object.prototype.hasOwnProperty.call(checkpoint, 'extraFiles'));
}

{
  assert.deepStrictEqual(
    stageRerun.keptStagesFor('compile'),
    ['clone', 'spec-extract', 'spec-validate', 'complexity-gate', 'assembly-plan', 'assembly-complexity-gate', 'codegen', 'method-check', 'review']
  );
}

console.log('stage-rerun tests passed');
