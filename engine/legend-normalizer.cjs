/**
 * 画面图例 shape/color 归一化共享模块（反馈 01，2026-04-26）。
 *
 * 之前 frontend/src/App.jsx 与 api/projects.cjs 各自维护一份几乎逐字相同的实现,
 * 导致关键词表 / fallback 序列长期偏移（详见 INCIDENTS.md「2026-04-26 反馈 01」）。
 * 本模块为 CJS,api 直接 require,frontend 通过 Vite 的 CJS interop 以 ESM 风格 import。
 *
 * 关于 LEGEND_SHAPES：
 *   反馈 01 之前误把 ['Cube','Sphere','Cylinder','Cube'] 写死,导致 fallback 序列每 4/8/...
 *   位永远是 Cube,Plane 永不出现。已修正为 ['Cube','Sphere','Cylinder','Plane']。
 *
 * 关于 LEGEND_COLORS：
 *   关键词表能识别 Brown / Gray,fallback 调色板必须同样包含,避免输出 'Brown' 后前端
 *   降级到 9 色循环把它丢掉。
 */

'use strict';

const LEGEND_COLORS = [
  'Blue', 'Cyan', 'Purple', 'Yellow', 'Green',
  'Orange', 'Red', 'Pink', 'White', 'Brown', 'Gray',
];

const LEGEND_SHAPES = ['Cube', 'Sphere', 'Cylinder', 'Plane'];

const COLOR_KEYWORDS = [
  ['red', 'Red'], ['红', 'Red'],
  ['blue', 'Blue'], ['蓝', 'Blue'],
  ['green', 'Green'], ['绿', 'Green'],
  ['yellow', 'Yellow'], ['黄', 'Yellow'],
  ['orange', 'Orange'], ['橙', 'Orange'],
  ['purple', 'Purple'], ['紫', 'Purple'],
  ['cyan', 'Cyan'], ['青', 'Cyan'],
  ['pink', 'Pink'], ['粉', 'Pink'],
  ['brown', 'Brown'], ['棕', 'Brown'],
  ['gray', 'Gray'], ['grey', 'Gray'], ['灰', 'Gray'],
  ['white', 'White'], ['白', 'White'],
];

function normalizeLegendShape(value, index) {
  const text = String(value || '').trim().toLowerCase();
  if (text.indexOf('sphere') >= 0 || text.indexOf('球') >= 0) return 'Sphere';
  if (text.indexOf('cylinder') >= 0 || text.indexOf('柱') >= 0) return 'Cylinder';
  if (text.indexOf('plane') >= 0 || text.indexOf('平面') >= 0) return 'Plane';
  if (text.indexOf('cube') >= 0 || text.indexOf('方') >= 0) return 'Cube';
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  return LEGEND_SHAPES[i % LEGEND_SHAPES.length];
}

function normalizeLegendColor(value, index) {
  const text = String(value || '').trim();
  const lower = text.toLowerCase();
  for (let i = 0; i < COLOR_KEYWORDS.length; i++) {
    if (lower.indexOf(COLOR_KEYWORDS[i][0]) >= 0) return COLOR_KEYWORDS[i][1];
  }
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (nums && nums.length >= 3) {
    let r = Number(nums[0]);
    let g = Number(nums[1]);
    let b = Number(nums[2]);
    if (r > 1 || g > 1 || b > 1) {
      r /= 255;
      g /= 255;
      b /= 255;
    }
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 0.12 && max > 0.75) return 'White';
    if (max - min < 0.12) return 'Gray';
    if (r >= max && g > 0.55) return 'Yellow';
    if (r >= max) return 'Red';
    if (g >= max) return 'Green';
    if (b >= max && r > 0.45) return 'Purple';
    if (b >= max) return 'Blue';
  }
  const idx = Number.isInteger(index) && index >= 0 ? index : 0;
  return LEGEND_COLORS[idx % LEGEND_COLORS.length];
}

module.exports = {
  LEGEND_COLORS,
  LEGEND_SHAPES,
  normalizeLegendShape,
  normalizeLegendColor,
};
