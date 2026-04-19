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

describe('skeleton-generator — MovePlayer buf reuse (T1-2)', () => {
  const code = generateSkeleton(buildMinimalSpec(), { entityPoolMap: { Target: 'Pool_Target' } });
  const skeleton = typeof code === 'string' ? code : code.main;

  test('MovePlayer body has zero `new Vector3(` calls', () => {
    const m = skeleton.match(/void MovePlayer\(\)[\s\S]*?^\s*\}\s*$/m);
    expect(m).toBeTruthy();
    const body = m[0];
    const newVecCount = (body.match(/new\s+Vector3\s*\(/g) || []).length;
    expect(newVecCount).toBe(0);
  });

  test('class declares `Vector3 _moveBuf` field for reuse', () => {
    expect(skeleton).toMatch(/Vector3\s+_moveBuf\s*(=|;)/);
  });
});

describe('skeleton-generator — world labels (2026-04-19)', () => {
  test('entities with chineseName emit GFM_UI.AddWorldLabel after Register', () => {
    const specs = buildMinimalSpec();
    const entities = [
      { name: 'Target', chineseName: '目标', pool: 'Pool_Target', scale: 1 },
    ];
    const code = generateSkeleton(specs, {
      entityPoolMap: { Target: 'Pool_Target' },
      entities: entities,
    });
    const out = typeof code === 'string' ? code : code.main;
    expect(out).toMatch(/GFM_UI\.AddWorldLabel\(Target,\s*"目标",/);
    const registerIdx = out.indexOf('GameSceneCtrl.instance.Register("Target"');
    const labelIdx = out.indexOf('AddWorldLabel(Target');
    expect(registerIdx).toBeGreaterThan(-1);
    expect(labelIdx).toBeGreaterThan(registerIdx);
  });

  test('showLabel:false suppresses label emission', () => {
    const specs = buildMinimalSpec();
    const entities = [
      { name: 'Target', chineseName: '玩家载具', pool: 'Pool_Target', scale: 1, showLabel: false },
    ];
    const code = generateSkeleton(specs, {
      entityPoolMap: { Target: 'Pool_Target' },
      entities: entities,
    });
    const out = typeof code === 'string' ? code : code.main;
    expect(out).not.toMatch(/AddWorldLabel\(Target/);
  });

  test('missing chineseName → no label (graceful)', () => {
    const specs = buildMinimalSpec();
    const code = generateSkeleton(specs, {
      entityPoolMap: { Target: 'Pool_Target' },
      entities: [{ name: 'Target', pool: 'Pool_Target' }],
    });
    const out = typeof code === 'string' ? code : code.main;
    expect(out).not.toMatch(/AddWorldLabel\(Target/);
  });

  test('no opts.entities → no labels, no crash', () => {
    const specs = buildMinimalSpec();
    const code = generateSkeleton(specs, { entityPoolMap: { Target: 'Pool_Target' } });
    const out = typeof code === 'string' ? code : code.main;
    expect(out).not.toMatch(/AddWorldLabel\(/);
  });
});
