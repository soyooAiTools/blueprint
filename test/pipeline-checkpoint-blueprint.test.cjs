var assert = require('assert');

var pipeline = require('../engine/pipeline.cjs');

var ctx = new pipeline.PipelineContext(
  {
    id: 'checkpoint_blueprint_test',
    blueprint_json: JSON.stringify({
      projectName: 'TaskBlueprint',
      entities: [{ name: 'TaskOnlyEntity' }],
      specs: []
    })
  },
  {
    completedStages: ['spec-extract', 'spec-validate', 'complexity-gate', 'assembly-plan'],
    blueprint: {
      projectName: 'CheckpointBlueprint',
      sourceHtmlPath: '/tmp/source.html',
      sourceHtmlSha256: 'abc123',
      entities: [{ name: 'CheckpointEntity' }],
      specs: [{ phaseId: 'intro', requiredInteractions: ['move_to:CheckpointEntity'] }],
      plans: {
        registryVersion: 'registry-pack-v1',
        storyboardAtomPlan: { items: [{ id: 'atom_001', atomId: 'move_to', phaseId: 'intro' }] },
        entityPlan: { entities: [], systemModules: [] },
        assemblyPlan: { moduleInstances: [], unresolved: [], phaseBindings: [] },
        cuaPlan: { steps: [] }
      }
    }
  },
  {}
);

assert.strictEqual(ctx.blueprint.projectName, 'CheckpointBlueprint');
assert.strictEqual(ctx.blueprint.entities[0].name, 'CheckpointEntity');
assert.strictEqual(ctx.completedStages.indexOf('assembly-plan') >= 0, true);
assert.strictEqual(ctx.sourceHtmlPath, '/tmp/source.html');
assert.strictEqual(ctx.sourceHtmlSha256, 'abc123');

var saved = ctx.saveCheckpointData();
assert.strictEqual(saved.blueprint.projectName, 'CheckpointBlueprint');
assert.strictEqual(saved.blueprint.entities[0].name, 'CheckpointEntity');
assert.ok(saved.blueprint.plans, 'checkpoint payload should preserve plans');
assert.strictEqual(saved.blueprint.sourceHtmlPath, '/tmp/source.html');
assert.strictEqual(saved.blueprint.sourceHtmlSha256, 'abc123');

console.log('pipeline-checkpoint-blueprint tests passed');
