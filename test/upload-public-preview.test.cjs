const assert = require('assert');

const upload = require('../engine/stages/upload.cjs');

const internals = upload._internals;

{
  const frameA = {
    data: Buffer.from([0, 0, 0, 10, 10, 10, 20, 20, 20]),
    channels: 3,
  };
  const frameB = {
    data: Buffer.from([0, 0, 0, 80, 80, 80, 20, 20, 20]),
    channels: 3,
  };
  assert.strictEqual(internals.visualDiffRatio(frameA, frameB), 1 / 3);
}

{
  const state = {
    completedPhases: ['enemyAttackWarning', 'upgrade-our-base', 'unrelatedPhase'],
  };
  const specs = [
    { phaseId: 'enemyAttackWarning' },
    { phaseId: 'upgradeOurBase' },
    { phaseId: 'dispatchAstronautAttack' },
  ];
  assert.strictEqual(internals.getSpecCompletedCount(state, specs), 2);
}

{
  assert.throws(function() {
    internals.assertUploadVisualManifest({
      sourceHtmlPath: '/tmp/source.html',
      htmlOutput: '<script>window.__BLUEPRINT_VISUAL_ASSETS__ = null; window.__fidelityReady = false;</script>',
      blueprint: {},
    });
  }, /__BLUEPRINT_VISUAL_ASSETS__ is null/);
}

{
  assert.throws(function() {
    internals.assertUploadVisualManifest({
      sourceHtmlPath: '/tmp/source.html',
      htmlOutput: '<script>window.__BLUEPRINT_VISUAL_ASSETS__ = {"sourceEntityContract":{},"sourcePhaseContract":{},"entityBindings":{}}; window.__fidelityReady = false;</script>',
      blueprint: {},
    });
  }, /missing entityBindings, fidelityContract/);
}

{
  assert.throws(function() {
    internals.assertSourceVisualRenderableMetrics({
      sourceVisualActive: true,
      expectedEntityCount: 14,
      bindingCount: 14,
      sourceMeshOpsCount: 0,
      fidelityPrimitiveStyleCount: 14,
      storyboardGroups: 14,
      sourceVisualRenderable: 0,
      styledParts: 0,
      sourcePrims: 0,
      emptyStoryboardEntities: 14,
      allEnabledRenderable: 2,
      disabledVisiblePosPool: 7,
    }, {});
  }, /source visual has no renderable mesh parts/);
}

{
  assert.doesNotThrow(function() {
    internals.assertSourceVisualRenderableMetrics({
      sourceVisualActive: true,
      expectedEntityCount: 14,
      bindingCount: 14,
      sourceMeshOpsCount: 0,
      fidelityPrimitiveStyleCount: 14,
      storyboardGroups: 14,
      sourceVisualRenderable: 22,
      styledParts: 53,
      sourcePrims: 0,
      emptyStoryboardEntities: 14,
      allEnabledRenderable: 22,
    }, {});
  });
}

{
  assert.doesNotThrow(function() {
    internals.assertSourceVisualRenderableMetrics({ sourceVisualActive: false }, {});
  });
}

console.log('upload public preview tests passed');
