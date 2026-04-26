const {
  validateShotProgressionMonotonic,
  validateEntityTrajectoryLength,
  validateCameraYLock,
  validateLegendStructure,
} = require('../engine/preview-validators.cjs');

describe('preview-validators / validateShotProgressionMonotonic', () => {
  test('连续 1→2→3→4→5 通过', () => {
    const seq = [{ phase: 1 }, { phase: 2 }, { phase: 3 }, { phase: 4 }, { phase: 5 }];
    expect(validateShotProgressionMonotonic(seq)).toEqual([]);
  });

  test('跳号 4→5→7 命中 jump', () => {
    const seq = [{ phase: 4 }, { phase: 5 }, { phase: 7 }];
    const issues = validateShotProgressionMonotonic(seq);
    expect(issues.length).toBe(1);
    expect(issues[0].kind).toBe('jump');
    expect(issues[0].index).toBe(2);
  });

  test('反向回退 3→2 命中 regression', () => {
    const seq = [{ phase: 1 }, { phase: 2 }, { phase: 3 }, { phase: 2 }];
    const issues = validateShotProgressionMonotonic(seq);
    expect(issues.find((i) => i.kind === 'regression')).toBeDefined();
  });

  test('空数组直接返回空 issues', () => {
    expect(validateShotProgressionMonotonic([])).toEqual([]);
  });

  test('phase 字段缺失被记录', () => {
    const seq = [{ phase: 1 }, {}, { phase: 3 }];
    const issues = validateShotProgressionMonotonic(seq);
    expect(issues.find((i) => i.kind === 'missing-phase')).toBeDefined();
  });

  test('phase 字符串数字也接受', () => {
    const seq = [{ phase: '1' }, { phase: '2' }, { phase: '3' }];
    expect(validateShotProgressionMonotonic(seq)).toEqual([]);
  });

  test('反馈 01 截图重现: 1→2→3→5→7→8 跳号叠加', () => {
    // 反馈截图 Data_2.png 红箭头指 5/7/8,推演从 3 跳 5、再从 5 跳 7。
    const seq = [{ phase: 1 }, { phase: 2 }, { phase: 3 }, { phase: 5 }, { phase: 7 }, { phase: 8 }];
    const issues = validateShotProgressionMonotonic(seq);
    const jumps = issues.filter((i) => i.kind === 'jump');
    expect(jumps.length).toBe(2); // 3→5, 5→7
  });

  test('浮点 phase 命中 non-integer-phase', () => {
    const seq = [{ phase: 1 }, { phase: 1.5 }, { phase: 2 }];
    const issues = validateShotProgressionMonotonic(seq);
    expect(issues.find((i) => i.kind === 'non-integer-phase')).toBeDefined();
  });
});

describe('preview-validators / validateEntityTrajectoryLength', () => {
  test('平滑插值轨迹通过', () => {
    const samples = [];
    for (let t = 0; t <= 1; t += 0.05) {
      samples.push({ x: t * 5, y: 0, z: 0 });
    }
    expect(validateEntityTrajectoryLength(samples)).toEqual([]);
  });

  test('瞬移特征命中 teleport', () => {
    const samples = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 },
    ];
    const issues = validateEntityTrajectoryLength(samples);
    expect(issues.find((i) => i.kind === 'teleport')).toBeDefined();
  });

  test('采样不足时跳过校验', () => {
    expect(validateEntityTrajectoryLength([{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }])).toEqual([]);
  });

  test('完全静止不报错', () => {
    const samples = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
    expect(validateEntityTrajectoryLength(samples)).toEqual([]);
  });
});

describe('preview-validators / validateCameraYLock', () => {
  test('镜头 Y 锁定通过', () => {
    const samples = [
      { x: 0, y: 5, z: 0 },
      { x: 1, y: 5, z: 0 },
      { x: 2, y: 5.001, z: 0 },
      { x: 3, y: 4.999, z: 0 },
    ];
    expect(validateCameraYLock(samples)).toEqual([]);
  });

  test('Y 方差超阈值命中 y-variance', () => {
    const samples = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 3, y: 1, z: 0 },
    ];
    const issues = validateCameraYLock(samples);
    expect(issues.find((i) => i.kind === 'y-variance')).toBeDefined();
  });

  test('Y 单步跳变命中 y-jump', () => {
    const samples = [
      { x: 0, y: 5, z: 0 },
      { x: 1, y: 5, z: 0 },
      { x: 2, y: 8, z: 0 }, // 3 单位 Y 跳
      { x: 3, y: 8, z: 0 },
    ];
    const issues = validateCameraYLock(samples);
    expect(issues.find((i) => i.kind === 'y-jump')).toBeDefined();
  });
});

describe('preview-validators / validateLegendStructure', () => {
  test('完整 legend 通过', () => {
    const items = [
      { name: '我方基地', shape: 'cube', color: 'Blue' },
      { name: '敌方基地', shape: 'cube', color: 'Red' },
    ];
    expect(validateLegendStructure(items)).toEqual([]);
  });

  test('空数组命中 empty（反馈 01 截图: 画面图例丢失）', () => {
    const issues = validateLegendStructure([]);
    expect(issues.length).toBe(1);
    expect(issues[0].kind).toBe('empty');
  });

  test('非数组命中 not-array', () => {
    const issues = validateLegendStructure(null);
    expect(issues.find((i) => i.kind === 'not-array')).toBeDefined();
  });

  test('缺 shape/color 命中 missing-*', () => {
    const items = [{ name: '我方基地' }];
    const issues = validateLegendStructure(items);
    expect(issues.find((i) => i.kind === 'missing-shape')).toBeDefined();
    expect(issues.find((i) => i.kind === 'missing-color')).toBeDefined();
  });
});
