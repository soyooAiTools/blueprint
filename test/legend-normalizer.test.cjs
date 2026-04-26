const {
  LEGEND_COLORS,
  LEGEND_SHAPES,
  normalizeLegendShape,
  normalizeLegendColor,
} = require('../engine/legend-normalizer.cjs');

describe('legend-normalizer / LEGEND_SHAPES', () => {
  test('反馈 01 修正：第 4 项必须是 Plane,不是重复的 Cube', () => {
    expect(LEGEND_SHAPES).toEqual(['Cube', 'Sphere', 'Cylinder', 'Plane']);
    expect(LEGEND_SHAPES.filter((s) => s === 'Cube').length).toBe(1);
  });
});

describe('legend-normalizer / LEGEND_COLORS', () => {
  test('palette 必须覆盖 keyword 表能输出的颜色（避免 normalizer 输出后前端 fallback 丢失）', () => {
    expect(LEGEND_COLORS).toContain('Brown');
    expect(LEGEND_COLORS).toContain('Gray');
  });
});

describe('legend-normalizer / normalizeLegendShape', () => {
  test('英文关键词命中', () => {
    expect(normalizeLegendShape('Sphere', 0)).toBe('Sphere');
    expect(normalizeLegendShape('cylinder mesh', 0)).toBe('Cylinder');
    expect(normalizeLegendShape('plane01', 0)).toBe('Plane');
    expect(normalizeLegendShape('CubeRoot', 0)).toBe('Cube');
  });

  test('中文关键词命中', () => {
    expect(normalizeLegendShape('球体', 0)).toBe('Sphere');
    expect(normalizeLegendShape('圆柱', 0)).toBe('Cylinder');
    expect(normalizeLegendShape('平面', 0)).toBe('Plane');
    expect(normalizeLegendShape('方块', 0)).toBe('Cube');
  });

  test('空值落入 fallback 循环,不会卡在 Cube', () => {
    expect(normalizeLegendShape('', 0)).toBe('Cube');
    expect(normalizeLegendShape('', 1)).toBe('Sphere');
    expect(normalizeLegendShape('', 2)).toBe('Cylinder');
    expect(normalizeLegendShape('', 3)).toBe('Plane');
    expect(normalizeLegendShape('', 4)).toBe('Cube');
  });

  test('非整数 / 负数 index 退化为 0', () => {
    expect(normalizeLegendShape('', -1)).toBe('Cube');
    expect(normalizeLegendShape('', 1.5)).toBe('Cube');
    expect(normalizeLegendShape('', NaN)).toBe('Cube');
  });
});

describe('legend-normalizer / normalizeLegendColor', () => {
  test('关键词表命中（含 Brown/Gray）', () => {
    expect(normalizeLegendColor('深红色', 0)).toBe('Red');
    expect(normalizeLegendColor('Brown leather', 0)).toBe('Brown');
    expect(normalizeLegendColor('grey wall', 0)).toBe('Gray');
    expect(normalizeLegendColor('棕熊', 0)).toBe('Brown');
  });

  test('RGB 数字识别', () => {
    expect(normalizeLegendColor('(255,0,0)', 0)).toBe('Red');
    expect(normalizeLegendColor('1,0,0', 0)).toBe('Red');
    expect(normalizeLegendColor('(0.5,0.5,0.5)', 0)).toBe('Gray');
    expect(normalizeLegendColor('(255,255,255)', 0)).toBe('White');
  });

  test('空值 fallback 序列覆盖 11 色', () => {
    const collected = new Set();
    for (let i = 0; i < LEGEND_COLORS.length; i++) {
      collected.add(normalizeLegendColor('', i));
    }
    expect(collected.size).toBe(LEGEND_COLORS.length);
    expect(collected.has('Brown')).toBe(true);
    expect(collected.has('Gray')).toBe(true);
  });
});
