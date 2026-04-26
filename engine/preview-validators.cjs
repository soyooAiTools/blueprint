/**
 * 前端预览页 SHOT 推演校验纯函数（反馈 01，2026-04-26）。
 *
 * 这些函数不依赖 React / DOM，可在前端预览页运行时调用，也可在主仓 jest 中单测。
 * 反馈背景见 ~/.codex/skills/blueprint/INCIDENTS.md「2026-04-26 反馈 01」。
 *
 * 当前状态：non-blocking 警告版本。函数返回 issues 数组；调用方决定是 console.warn
 * 还是阻断。Phase B 之后才考虑升级为 blocking。
 */

'use strict';

/**
 * SHOT 进度推演必须按 1→2→3 单调连续递增，禁止跳号。
 *
 * @param {Array<{phase:number|string, timestamp?:number}>} sequence
 *   推演产生的 phase 时间序列；phase 字段为整数或可解析为整数的字符串。
 * @returns {Array<{kind:string, index:number, message:string}>} 问题清单；为空表示通过。
 */
function validateShotProgressionMonotonic(sequence) {
  const issues = [];
  if (!Array.isArray(sequence) || sequence.length === 0) return issues;
  let previous = null;
  for (let i = 0; i < sequence.length; i++) {
    const entry = sequence[i];
    if (!entry || entry.phase === undefined || entry.phase === null) {
      issues.push({ kind: 'missing-phase', index: i, message: `entry[${i}] 缺少 phase 字段` });
      continue;
    }
    const cur = Number(entry.phase);
    if (!Number.isFinite(cur)) {
      issues.push({ kind: 'invalid-phase', index: i, message: `entry[${i}].phase 不是数字: ${entry.phase}` });
      continue;
    }
    if (previous !== null) {
      if (cur < previous) {
        issues.push({ kind: 'regression', index: i, message: `phase ${previous} → ${cur} 反向回退` });
      } else if (cur > previous + 1) {
        issues.push({ kind: 'jump', index: i, message: `phase ${previous} → ${cur} 跳号（应连续 +1）` });
      }
    }
    previous = cur;
  }
  return issues;
}

/**
 * 实体在 SHOT 推演中的位移轨迹必须经过插值过程，禁止瞬移。
 * 用相邻采样点距离的中位数估计；中位数 < minSegmentLen 视为没插值或极少插值。
 *
 * @param {Array<{x:number,y:number,z:number}>} samples 实体位置采样序列。
 * @param {{minSegmentLen?:number, minSamples?:number}} [opts]
 *   minSegmentLen 默认 0.05（Unity 单位）：相邻采样点的距离下限。
 *   minSamples 默认 4：少于此数视为采样不足，跳过校验避免 false positive。
 * @returns {Array<{kind:string, message:string, value?:number}>}
 */
function validateEntityTrajectoryLength(samples, opts) {
  const issues = [];
  const minSegmentLen = (opts && opts.minSegmentLen) || 0.05;
  const minSamples = (opts && opts.minSamples) || 4;
  if (!Array.isArray(samples) || samples.length < minSamples) return issues;
  // 计算总移动距离;若整段几乎没动也视为非瞬移(本身静止),只在"有明显位移但只用 1 步完成"时报警。
  let totalDist = 0;
  let maxStep = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b) continue;
    const dx = (b.x || 0) - (a.x || 0);
    const dy = (b.y || 0) - (a.y || 0);
    const dz = (b.z || 0) - (a.z || 0);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    totalDist += d;
    if (d > maxStep) maxStep = d;
  }
  // 实体确实需要移动(总位移 > 0.5 单位),但 80% 的位移集中在单一一步内 → 瞬移特征。
  if (totalDist > 0.5 && maxStep / totalDist > 0.8) {
    issues.push({
      kind: 'teleport',
      message: `轨迹瞬移特征: 单步占总位移 ${((maxStep / totalDist) * 100).toFixed(1)}% > 80%`,
      value: maxStep / totalDist,
    });
  }
  // 平均段长 < minSegmentLen 但有少量大跨度,也算瞬移混入。
  const avgStep = totalDist / Math.max(1, samples.length - 1);
  if (totalDist > 0.5 && avgStep < minSegmentLen && maxStep > minSegmentLen * 4) {
    issues.push({
      kind: 'sparse-interp',
      message: `平均段长 ${avgStep.toFixed(4)} < ${minSegmentLen} 但出现单步 ${maxStep.toFixed(4)} — 插值不均匀`,
      value: avgStep,
    });
  }
  return issues;
}

/**
 * 镜头 Y 轴必须锁定（移动只在 X/Z），方差超过阈值视为镜头跳动。
 *
 * @param {Array<{x:number,y:number,z:number}>} cameraSamples 镜头位置采样。
 * @param {{maxYVariance?:number, maxYDelta?:number}} [opts]
 *   maxYVariance 默认 0.01：Y 轴方差上限。
 *   maxYDelta 默认 0.5：相邻采样间最大 Y 跳变。
 * @returns {Array<{kind:string, message:string, value?:number}>}
 */
function validateCameraYLock(cameraSamples, opts) {
  const issues = [];
  const maxYVariance = (opts && opts.maxYVariance) || 0.01;
  const maxYDelta = (opts && opts.maxYDelta) || 0.5;
  if (!Array.isArray(cameraSamples) || cameraSamples.length < 2) return issues;
  const ys = cameraSamples.map((s) => (s && typeof s.y === 'number') ? s.y : NaN).filter((v) => Number.isFinite(v));
  if (ys.length < 2) return issues;
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const variance = ys.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ys.length;
  if (variance > maxYVariance) {
    issues.push({ kind: 'y-variance', message: `镜头 Y 方差 ${variance.toFixed(4)} > ${maxYVariance}`, value: variance });
  }
  for (let i = 1; i < ys.length; i++) {
    const delta = Math.abs(ys[i] - ys[i - 1]);
    if (delta > maxYDelta) {
      issues.push({ kind: 'y-jump', message: `镜头 Y 单步跳变 ${delta.toFixed(4)} > ${maxYDelta}`, value: delta });
      break;
    }
  }
  return issues;
}

/**
 * 预览页"画面图例"区域必须为每个 entity 提供完整的视觉元数据。
 * 缺失意味着图例空白或残缺。
 *
 * @param {Array<{name:string, shape?:string, color?:string, displayName?:string}>} legendItems
 * @returns {Array<{kind:string, name:string, message:string}>}
 */
function validateLegendStructure(legendItems) {
  const issues = [];
  if (!Array.isArray(legendItems)) {
    issues.push({ kind: 'not-array', name: '', message: 'legendItems 不是数组（画面图例区域可能丢失）' });
    return issues;
  }
  if (legendItems.length === 0) {
    issues.push({ kind: 'empty', name: '', message: '画面图例为空 — 预览页左侧将显示空白区域' });
    return issues;
  }
  legendItems.forEach((item, index) => {
    const name = (item && item.name) || `<index ${index}>`;
    if (!item) {
      issues.push({ kind: 'null-item', name: '', message: `legend[${index}] 为空` });
      return;
    }
    if (!item.shape) issues.push({ kind: 'missing-shape', name, message: `legend "${name}" 缺 shape` });
    if (!item.color) issues.push({ kind: 'missing-color', name, message: `legend "${name}" 缺 color` });
  });
  return issues;
}

module.exports = {
  validateShotProgressionMonotonic,
  validateEntityTrajectoryLength,
  validateCameraYLock,
  validateLegendStructure,
};
