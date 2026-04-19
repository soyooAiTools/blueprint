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

describe('skeleton-generator — PlaceObj/HideObj/SetScale struct copy (T1-1)', () => {
  const code = generateSkeleton(buildMinimalSpec(), { entityPoolMap: { Target: 'Pool_Target' } });
  const skeleton = typeof code === 'string' ? code : code.main;

  test('PlaceObj uses struct-copy pattern, not `new Vector3`', () => {
    const m = skeleton.match(/void PlaceObj\(GameObject obj, float x, float y, float z\)[\s\S]*?^\s*\}/m);
    expect(m).toBeTruthy();
    expect(m[0]).not.toMatch(/new Vector3/);
    expect(m[0]).toMatch(/obj\.transform\.position\s*=\s*[_a-zA-Z]/);
  });

  test('HideObj and SetScale also avoid `new Vector3`', () => {
    const hide = skeleton.match(/void HideObj\(GameObject obj\)[\s\S]*?^\s*\}/m)[0];
    const scaleXYZ = skeleton.match(/void SetScale\(GameObject obj, float x, float y, float z\)[\s\S]*?^\s*\}/m)[0];
    const scaleU = skeleton.match(/void SetScale\(GameObject obj, float uniform\)[\s\S]*?^\s*\}/m)[0];
    expect(hide).not.toMatch(/new Vector3/);
    expect(scaleXYZ).not.toMatch(/new Vector3/);
    expect(scaleU).not.toMatch(/new Vector3/);
  });
});
