'use strict';

var DEFAULT_SLICE_MAX_CHARS = 1800;

var MAPPING_CHEATSHEET = [
  '## three.js HTML -> Unity GFM 翻译速查',
  '',
  '总原则: 逻辑 1:1, API 全替换; 不抄具体数值, 抄关系; 观察性位移走 SmoothMover; 禁止直写相机/玩家位置。',
  '',
  '| HTML pattern | Unity GFM API | 备注 |',
  '|---|---|---|',
  '| `obj.position.x += dx` (非相机) | `GFM_SmoothMover.MoveTo(go, target, duration)` | 直接 += 是 player-teleport 风险, phase-exit 走 Bobble |',
  '| `camera.position.lerp/copy/set` | `GFM_CameraController.Instance.FramePoint/SetCameraHeight` | 不准直接赋 camera.transform.position |',
  '| `cameraFlyTo(target, dur)` | `GFM_CameraController.Instance.FramePoint(target, orthoSize)` | 镜头拉远/聚焦统一走 controller |',
  '| `camera.position.x += rand()` 屏幕震动 | `GFM_CameraController.Shake(intensity, duration)` | GFM 缺口时进 customLogic |',
  '| `state.X += N` | `GFM_EconomyManager.Instance.AddResource("X", N)` | currency 类可映射 Gold |',
  '| `state.X -= N` | `AddResource("X", -N)` | 同一 resource id 必须一致 |',
  '| `if (state.X >= N) advancePhase()` | `resource_collected:{resource:X, amount:N}` | phase trigger 优先绑定可观察资源/状态 |',
  '| `setTimeout(advancePhase, ms)` | `compound(timer + resource_collected/near_entity)` | timer 不能裸用 |',
  '| `setTip("...", ms)` | `guideText` + `GFM_TipsManager.Show("...", sec)` | guideText 写入 phase |',
  '| `SFX.pickIce/win/boss()` | `GFM_Audio.Instance.PlaySFX(AudioClips.PickupSparkle/Victory/BossRoar)` | 未知音效进 customLogic |',
  '| `spawnShockwave(pos, color, r)` | `GFM_VisualGuide.Shockwave(pos, color, r)` | GFM 缺口时进 customLogic |',
  '| `spawnFloatText(pos, text, color)` | `GFM_UIManager.Instance.ShowFloatingText(...)` | 已有 UI API |',
  '| `scene.remove(go)` | `GFM_Pool.Return(go)` 或 `Destroy(go)` | 优先 pool |',
  '| `makePerson/makeHero/spawnHelper(...)` | `GFM_NpcManager.SpawnNpc("templateId", pos)` | NPC 走 NpcManager |',
  '| `new THREE.BoxGeometry` | `PrimitiveType.Cube` | 必须命名, 禁默认名 |',
  '| `new THREE.CylinderGeometry` | `PrimitiveType.Cylinder` | 必须命名 |',
  '| `new THREE.{Sphere,Icosahedron,Octahedron}Geometry` | `PrimitiveType.Sphere` | 多面体 demo 阶段统一近似 |',
  '| `new THREE.ConeGeometry` | imported `Cone.fbx` | luna-base-template 已有 |',
  '| `new THREE.MeshLambertMaterial({color})` | `GFM_Create.SetColor(obj, ColorFromHex)` | 仅初始化/创建期使用 |',
  '| `audioCtx.createOscillator()` synth | 不可直译 | 改成预生成 clip 的 PlaySFX |',
  '| `DOM #topbar` resource HUD | `GFM_UIManager` 默认 HUD | 不手写重叠 UI |',
  '| `DOM #endcard` | `Luna.Unity.Playable.InstallFullGame()` | 最终 CTA 必须落 InstallFullGame |',
  '',
  '资源 ID 标准化: `state.ice -> Ice` / `state.coin -> Gold` / `state.popcorn -> Popcorn` / `state.wood -> Wood` / `state.hp -> HomeHp`。`state.phase`/`state.shot`/`state.time` 是 flag, 不进 resources[]。',
  '',
  'GFM 缺口清单: Shake / SetWarningOverlay / Shockwave / Lightning / SpawnQueue / MachineAnimator / MechArmController / BlueprintOutline。出现时只能写入 customLogic 占位, 不要编造不存在 API。',
  '',
  '禁止反规则:',
  '- 不要在 Update/phase runtime 内直接 `transform.position = ...` 移动 Player',
  '- 不要输出 `Cube`/`Cylinder`/`Sphere` 默认名',
  '- 不要把 HTML 相机绝对偏移数值硬塞 Unity, 用 FramePoint/SetCameraHeight 关系式',
].join('\n');

function countHtmlPhaseSlices(ctx) {
  var slices = ctx && ctx.blueprint && ctx.blueprint.htmlPhaseSlices;
  if (!slices || typeof slices !== 'object') return 0;
  return Object.keys(slices).filter(function(key) {
    return String(slices[key] || '').trim().length > 0;
  }).length;
}

function shouldUseSchemaPromptV3(ctx) {
  var override = String(process.env.SCHEMA_PROMPT_VERSION || '').trim().toLowerCase();
  if (override === 'legacy' || override === 'v2') return false;
  if (override === 'v3') return true;
  return countHtmlPhaseSlices(ctx) > 0;
}

function resolveSliceMaxChars() {
  var n = Number(process.env.SCHEMA_PROMPT_V3_SLICE_MAX_CHARS || DEFAULT_SLICE_MAX_CHARS);
  return Number.isFinite(n) && n > 200 ? Math.floor(n) : DEFAULT_SLICE_MAX_CHARS;
}

function truncateSlice(text, maxChars) {
  text = String(text || '').trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n// ... truncated by schema prompt v3 slice budget ...';
}

function sortedKeys(obj) {
  return Object.keys(obj || {}).filter(function(key) {
    return String(obj[key] || '').trim().length > 0;
  }).sort();
}

function buildSchemaPromptV3(ctx, opts) {
  opts = opts || {};
  var blueprint = ctx && ctx.blueprint ? ctx.blueprint : {};
  var specs = JSON.stringify(blueprint.specs || [], null, 2);
  var entities = JSON.stringify(blueprint.entities || [], null, 2);
  var plansSummary = opts.plansSummary || '';
  var htmlSlices = blueprint.htmlPhaseSlices || {};
  var htmlSliceKeys = sortedKeys(htmlSlices);
  var sliceMaxChars = resolveSliceMaxChars();

  var lines = [];
  lines.push('根据分镜 specs + 可选 HTML 参考切片输出完整 JSON 配置对象。严格遵守以下字段定义,不添加额外字段:');
  lines.push('');
  lines.push('gameConfig (必填): { "cameraBackground": [r,g,b], "groundColor": [r,g,b], "moveSpeed": 5.0, "collectRange": 2.0, "maxCarry": 10 }');
  lines.push('entities[]: { "name": "PascalCaseName", "chineseName": "中文名", "showLabel": true, "pool": "__Pool_Shape_Color_NN", "initPos": [x,y,z], "scale": 1.0 }');
  lines.push('resources[]: { "name": "资源名", "entity": "关联实体名", "convertRatio": 1 }');
  lines.push('phases[]: { "phaseId": "阶段ID", "showEntities": [...], "hideEntities": [], "guideText": "...", "trigger": {...}, "onEnter": [{...}] }');
  lines.push('phases[].onEnter[].action 只能是: "set_entity_state" | "add_resource" | "switch_form" | "show_floating_text" | "set_guide" | "spawn_enemies"');
  lines.push('trigger.state 必须是整数(不是字符串)');
  lines.push('npcs[]: { "entity": "实体名", "template": "patrol|chase_attack|ranged_shooter|spawner|...", "params": {...} }');
  lines.push('customLogic[]: 字符串数组, 只写模板/GFM API 无法覆盖的逻辑, 越少越好');
  lines.push('');
  lines.push('## Trigger 类型(strict enum)');
  lines.push('- resource_collected: {resource, amount}');
  lines.push('- entity_state_reached: {entity, state}');
  lines.push('- near_entity: {entity, range}');
  lines.push('- click_entity: {entity}');
  lines.push('- all_built: {}');
  lines.push('- enemy_defeated: {count}');
  lines.push('- timer: {seconds} — 必须包在 compound');
  lines.push('- compound: {triggers[], operator: "and"|"or"}');
  lines.push('');
  lines.push('## NPC 行为模板(template enum)');
  lines.push('patrol / chase_attack / static_target / ranged_shooter / spawner / wander / evade / defend / circle / group_attack / flee_on_hit / boss_multiphase');
  lines.push('');
  lines.push('## 硬规则(违反会导致 schema 校验或 runtime gate 失败)');
  lines.push('R1. phases 数量 = specs 数量');
  lines.push('R2. 第一个 phase 的 showEntities >= 3');
  lines.push('R3. 最后一个 phase 的 trigger 必须包含 click_entity');
  lines.push('R4. timer 不能裸用, 必须 compound and 配 resource_collected/near_entity');
  lines.push('R5. pool 格式: `__Pool_<Word>_<Word>_NN`');
  lines.push('R6. entities[].initPos x∈±6 z∈±4 y>0; scale >= 0.3');
  lines.push('R7. entities 覆盖 assembly plan 全部运行时实体, 含 bullet/helper machine/spawner 产物');
  lines.push('R8. 每个 entity 必须有 chineseName(中文), 不能复制 name 字段');
  lines.push('R9. showLabel 默认 true; Ship/Avatar/Vehicle/Gold/Coin/Gem/Currency/CTAButton/Button/UI 为 false; Player 必须 true 且 chineseName="玩家"');
  lines.push('R10. 相邻 phase 的 showEntities 不能完全相同');
  lines.push('R11. 相邻 phase 的 guideText 不能相同');
  lines.push('R12. showEntities 在不同 phase 的 initPos 至少差 2 单位');
  lines.push('R13. 至少 50% 的 phase 用 entity_state_reached/resource_collected, 不能全 timer');
  lines.push('R14. 禁止把 Player 写入任何 phase.showEntities');
  lines.push('R15. 已被玩家移动过的实体(载具/NPC/可拖动)不再次进 showEntities');
  if (plansSummary) {
    lines.push('R16. 必须优先遵守下面的 Assembly Plan, 不重新发明实体模块组合、状态 owner、phase 顺序');
    lines.push('R17. 优先把 module 实现映射为 phases/onEnter/resources/npcs; 只有 unresolved 项才允许落入 customLogic');
    lines.push('R18. 对每个 moduleContracts/cuaSteps 的 phaseEvidenceSignals 声明的 signal, 必须在对应 phase 写入 evidence');
  }
  lines.push('');
  lines.push(MAPPING_CHEATSHEET);
  lines.push('');

  if (plansSummary) {
    lines.push('## Assembly Plan（必须遵守）');
    lines.push(plansSummary);
    lines.push('');
  }

  if (htmlSliceKeys.length > 0) {
    lines.push('## HTML 参考切片(AI 生成 demo, 每 phase 一段 JS)');
    lines.push('用这些 JS 推导 onEnter actions / trigger 类型 / showEntities 列表; 逻辑 1:1, API 换 GFM 等价物。');
    lines.push('');
    htmlSliceKeys.forEach(function(phaseId) {
      lines.push('### ' + phaseId);
      lines.push('```javascript');
      lines.push(truncateSlice(htmlSlices[phaseId], sliceMaxChars));
      lines.push('```');
      lines.push('');
    });
  }

  lines.push('## 分镜 Specs');
  lines.push(specs);
  lines.push('');
  lines.push('## 实体列表');
  lines.push(entities);
  lines.push('');
  lines.push('只输出 JSON 对象,不要 markdown 包裹,不要解释。');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_SLICE_MAX_CHARS: DEFAULT_SLICE_MAX_CHARS,
  MAPPING_CHEATSHEET: MAPPING_CHEATSHEET,
  buildSchemaPromptV3: buildSchemaPromptV3,
  countHtmlPhaseSlices: countHtmlPhaseSlices,
  shouldUseSchemaPromptV3: shouldUseSchemaPromptV3,
};
