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

console.log('upload public preview tests passed');
