'use strict';
const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

function buildMinimalSpec() {
  return [
    {
      phaseId: 'p1',
      phaseName: 'Phase 1',
      chapterId: 1,
      duration: { min: 3, max: 3 },
      requiredInteractions: ['move_to:Target', 'collect:Metal'],
      triggerNext: { condition: 'p1InteractionDone', description: '' },
      entitiesRequired: [{ name: 'Target', terminalState: 1 }],
      playerMustAct: true,
      autoAllowed: false,
    },
  ];
}

describe('skeleton-generator — IsNear no sqrt (T1-5)', () => {
  const code = generateSkeleton(buildMinimalSpec(), { entityPoolMap: { Target: 'Pool_Target' } });
  const skeleton = typeof code === 'string' ? code : code.main;
  test('IsNear uses dx*dx + dz*dz < range*range, not Vector3.Distance', () => {
    const m = skeleton.match(/bool IsNear\(GameObject target, float range\)\s*[\s\S]*?\}/);
    expect(m).toBeTruthy();
    const body = m[0];
    expect(body).not.toMatch(/Vector3\.Distance/);
    expect(body).toMatch(/dx\s*\*\s*dx/);
    expect(body).toMatch(/range\s*\*\s*range/);
  });
});
