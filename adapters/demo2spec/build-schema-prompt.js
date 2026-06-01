#!/usr/bin/env node
// codegen-schema buildSchemaPrompt v3 提案
// 改动点(相对 codegen-schema.cjs:607 原版):
//   1. 顶部 inline mapping cheatsheet(40 行,从 THREEJS-TO-UNITY-MAPPING.md 提炼)
//   2. 新增 `## HTML 参考切片`,把 PHASES[i] 的 JS body 按 phaseId 内联
//   3. 静态规则前置(命中 prompt cache),动态片段后置
//
// 用法:
//   const { buildSchemaPromptV3 } = require('./build-schema-prompt-v3.js');
//   const text = buildSchemaPromptV3(ctx);
//
// ctx 新增字段:
//   ctx.blueprint.htmlPhaseSlices: { [phaseId]: jsSnippetString }
//   (上游 spec-extract 阶段从 AI 生成的 HTML demo 切片,见 extract-v3.js)

const MAPPING_CHEATSHEET = [
  '## three.js HTML → Unity GFM 翻译速查',
  '',
  '**总原则**: 逻辑 1:1,API 全替换;不抄具体数值,抄关系;观察性位移走 SmoothMover;禁止直写相机/玩家位置。',
  '',
  '| HTML pattern | Unity GFM API | 备注 |',
  '|---|---|---|',
  '| `obj.position.x += dx` (非相机) | `GFM_SmoothMover.MoveTo(go, target, duration)` | 直接 += 是 player-teleport 风险,phase-exit 走 Bobble |',
  '| `camera.position.lerp/copy/set` | `GFM_CameraController.Instance.MoveTo / SetCameraHeight` | 不准直接赋 camera.transform.position |',
  '| `cameraFlyTo(target, dur)` | `GFM_CameraController.Instance.FramePoint(target, orthoSize)` | "镜头拉远"翻译 |',
  '| `camera.position.x += rand()` 屏幕震动 | `GFM_CameraController.Shake(intensity, duration)` | **GFM 缺口**, codegen 补 stub |',
  '| `state.X += N` (X=ice/coin/...) | `GFM_EconomyManager.Instance.AddResource("X", N)` | currency 类用 AddGold |',
  '| `state.X -= N` | `AddResource("X", -N)` | 同上 |',
  '| `if (state.X >= N) advancePhase()` | phase trigger `resource_collected:{resource:X, amount:N}` | inventory 名漂移规则:resource id 与 collect atom 一致 |',
  '| `setTimeout(advancePhase, ms)` | phase trigger `timer:{seconds:ms/1000}` 包 compound | timer 不能裸用,必须 + resource_collected and |',
  '| `setTip("...", ms)` | `GFM_TipsManager.Show("...", sec)` | guideText 写入 phase |',
  '| `SFX.pickIce/win/boss()` | `GFM_Audio.Instance.PlaySFX(AudioClips.PickupSparkle/Victory/BossRoar)` | 见 Audio Asset Map |',
  '| `spawnShockwave(pos, color, r)` | `GFM_VisualGuide.Shockwave(pos, color, r)` | **GFM 缺口**, codegen 补 stub |',
  '| `spawnFloatText(pos, text, color)` | `GFM_UIManager.Instance.ShowFloatingText(...)` | 已有 API |',
  '| `scene.remove(go)` | `GFM_Pool.Return(go)` 或 `Destroy(go)` | 优先 pool |',
  '| `makePerson/makeHero/spawnHelper(...)` | `GFM_NpcManager.SpawnNpc("templateId", pos)` | NPC 走 NpcManager |',
  '| `makeWall(...)` | `GFM_Create.Obj(PrimitiveType.Cube, pos, scale, "Wall")` | 必须命名 |',
  '| `new THREE.BoxGeometry` | `PrimitiveType.Cube` | 必须命名,禁默认名 |',
  '| `new THREE.CylinderGeometry` | `PrimitiveType.Cylinder` | |',
  '| `new THREE.{Sphere,Icosahedron,Octahedron}Geometry` | `PrimitiveType.Sphere` (近似) | 多面体 demo 阶段统一近似 |',
  '| `new THREE.ConeGeometry` | imported `Cone.fbx`(luna-base-template 已有) | |',
  '| `new THREE.MeshLambertMaterial({color})` | `GFM_Create.SetColor(obj, ColorFromHex)` | |',
  '| `audioCtx.createOscillator()` synth | **❌ 不可翻译**,改 `PlaySFX(预生成 clip)` | WebAudio synth 不能直译 |',
  '| `DOM #topbar 资源条` | `GFM_UIManager.Instance` 默认 HUD | luna template 已有 prefab |',
  '| `DOM #endcard` | `GFM_UIManager.ShowEndCard()` → `Luna.Unity.Playable.InstallFullGame()` | blueprint 高优先级规则 |',
  '',
  '**资源 ID 标准化**: `state.ice→Ice` / `state.coin→Gold` / `state.popcorn→Popcorn` / `state.wood→Wood` / `state.hp→HomeHp`。`state.phase`/`state.shot`/`state.time` 是 flag 不是 resource,不要写入 resources[]。',
  '',
  '**GFM 缺口清单**(出现时 codegen 必须落 customLogic 占位): Shake / SetWarningOverlay / Shockwave / Lightning / SpawnQueue / MachineAnimator / MechArmController / BlueprintOutline。',
  '',
  '**禁止反规则**:',
  '- `transform.position = ...` 在 Update 内对 Player → player-teleport-in-update 静态规则会熔断',
  '- `Cube`/`Cylinder` 这种默认名 → blueprint 静态规则禁止',
  '- HTML 里的 `7.6, 18, 16.3` 等具体相机偏移数值不要硬塞 Unity,用 `FramePoint`/`SetCameraHeight` 关系式',
].join('\n');

function buildSchemaPromptV3(ctx) {
  const blueprint = ctx.blueprint || {};
  const specs = JSON.stringify(blueprint.specs || [], null, 2);
  const entities = JSON.stringify(blueprint.entities || [], null, 2);
  const htmlSlices = blueprint.htmlPhaseSlices || {};

  const lines = [];

  // ===== 静态部分(prompt cache hit 友好,放前) =====
  lines.push('根据分镜 specs + AI 生成的 HTML 参考片段输出完整 JSON 配置对象。严格遵守以下字段定义,不添加额外字段:');
  lines.push('');
  lines.push('gameConfig (必填): { "cameraBackground": [r,g,b], "groundColor": [r,g,b], "moveSpeed": 5.0, "collectRange": 2.0, "maxCarry": 10 }');
  lines.push('entities[]: { "name": "PascalCaseName", "chineseName": "中文名", "showLabel": true, "pool": "__Pool_Shape_Color_NN", "initPos": [x,y,z], "scale": 1.0 }');
  lines.push('resources[]: { "name": "资源名", "entity": "关联实体名", "convertRatio": 1 }');
  lines.push('phases[]: { "phaseId": "阶段ID", "showEntities": [...], "hideEntities": [], "guideText": "...", "trigger": {...}, "onEnter": [{...}] }');
  lines.push('phases[].onEnter[].action ∈ { set_entity_state | add_resource | switch_form | show_floating_text | set_guide | spawn_enemies }');
  lines.push('npcs[]: { "entity": "实体名", "template": "patrol|chase_attack|ranged_shooter|spawner|...", "params": {...} }');
  lines.push('customLogic[]: 字符串数组,GFM 无 API 的部分写这里');
  lines.push('');
  lines.push('## Trigger 类型(strict enum)');
  lines.push('- resource_collected: {resource, amount}');
  lines.push('- entity_state_reached: {entity, state}  ← state 是 integer');
  lines.push('- near_entity: {entity, range}');
  lines.push('- click_entity: {entity}');
  lines.push('- all_built: {}');
  lines.push('- enemy_defeated: {count}');
  lines.push('- timer: {seconds}  ← 必须包在 compound');
  lines.push('- compound: {triggers[], operator: "and"|"or"}');
  lines.push('');
  lines.push('## NPC 行为模板(template enum)');
  lines.push('patrol / chase_attack / static_target / ranged_shooter / spawner / wander / evade / defend / circle / group_attack / flee_on_hit / boss_multiphase');
  lines.push('');
  lines.push('## 硬规则(违反 → schema 校验失败)');
  lines.push('R1. phases 数量 = specs 数量');
  lines.push('R2. 第一个 phase 的 showEntities >= 3');
  lines.push('R3. 最后一个 phase 的 trigger 必须 click_entity');
  lines.push('R4. timer 不能裸用,必须 compound and 配 resource_collected/near_entity');
  lines.push('R5. pool 格式: `__Pool_<Word>_<Word>_NN`(每段首字母大写其余小写,无内部驼峰)');
  lines.push('R6. entities[].initPos x∈±6 z∈±4 y>0;scale >= 0.3');
  lines.push('R7. entities 覆盖 assembly plan 全部运行时实体(含 bullet/helper machine/spawner 产物)');
  lines.push('R8. 每个 entity 必须有 chineseName(中文),不能复制 name 字段');
  lines.push('R9. showLabel 默认 true;以下 false: 含 Ship/Avatar/Vehicle/Gold/Coin/Gem/Currency/CTAButton/Button/UI;Player 必须 true 且 chineseName="玩家"');
  lines.push('R10. 相邻 phase 的 showEntities 不能完全相同');
  lines.push('R11. 相邻 phase 的 guideText 不能相同');
  lines.push('R12. showEntities 在不同 phase 的 initPos 至少差 2 单位');
  lines.push('R13. 至少 50% 的 phase 用 entity_state_reached/resource_collected,不能全 timer');
  lines.push('R14. **禁止把 Player 写入任何 phase.showEntities**(Start() 已摆好,再 PlaceObj 会瞬移)');
  lines.push('R15. 已被玩家移动过的实体(载具/NPC/可拖动)不再次进 showEntities');
  lines.push('');
  lines.push(MAPPING_CHEATSHEET);
  lines.push('');

  // ===== 动态部分(每次不同,放后) =====
  if (blueprint.plans && blueprint.plans.assemblyPlan) {
    const moduleCount = (blueprint.plans.assemblyPlan.moduleInstances || []).length;
    const cuaSteps = ((blueprint.plans.cuaPlan && blueprint.plans.cuaPlan.steps) || []).length;
    lines.push(`## Assembly Plan 摘要(${moduleCount} modules, ${cuaSteps} CUA steps)`);
    lines.push('优先映射到 phases/onEnter/resources/npcs;unresolved 才进 customLogic。');
    lines.push('');
  }

  // ===== 新增: 每 phase HTML 切片 =====
  if (Object.keys(htmlSlices).length > 0) {
    lines.push('## HTML 参考切片(AI 生成 demo,每 phase 一段 JS)');
    lines.push('用这些 JS 推导 onEnter actions / trigger 类型 / showEntities 列表;**逻辑 1:1,API 换 GFM 等价物**。');
    lines.push('');
    for (const phaseId of Object.keys(htmlSlices)) {
      const slice = htmlSlices[phaseId];
      lines.push(`### ${phaseId}`);
      lines.push('```javascript');
      lines.push(slice.trim());
      lines.push('```');
      lines.push('');
    }
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

module.exports = { buildSchemaPromptV3, MAPPING_CHEATSHEET };

// ===== CLI demo: 跑一遍 守护家园 输入,产出 assembled prompt =====
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const SPEC_PATH = process.argv[2];
  const GS_PATH   = process.argv[3];
  const HTML_PATH = process.argv[4];
  if (!SPEC_PATH || !GS_PATH || !HTML_PATH) {
    console.error('用法: node build-schema-prompt.js <spec.json> <gameschema.json> <src.html> [out.txt]');
    process.exit(1);
  }
  const OUT_PATH  = process.argv[5] || path.join(path.dirname(SPEC_PATH), 'assembled-prompt.txt');
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const gameschema = JSON.parse(fs.readFileSync(GS_PATH, 'utf8'));

  // 从 HTML 抽 PHASES[i] 的 onEnter body 作 phaseSlice
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const htmlPhaseSlices = {};
  // 简化:用 spec-v3.phases[i].body 已切好的 phase block
  for (let i = 0; i < spec.phases.length; i++) {
    const p = spec.phases[i];
    // body 在 spec-v3.json 已被剥离,从 extractor 重新切一次
    const phasesIdx = html.indexOf('const PHASES');
    const phasesArrStart = html.indexOf('[', phasesIdx);
    // 找第 i 个 top-level {} block
    let depth = 0, start = -1, count = 0, block = null;
    for (let k = phasesArrStart + 1; k < html.length; k++) {
      const c = html[k];
      if (c === '[' || c === '{') { if (depth === 0 && c === '{') start = k; depth++; }
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0 && start >= 0) {
          if (count === i) { block = html.slice(start, k + 1); break; }
          count++; start = -1;
        }
        if (c === ']' && depth === 0) break;
      }
    }
    if (block) htmlPhaseSlices[`phase${i + 1}`] = block;
  }

  // 把 spec-v3.phases 改造成 "specs" 字段(模拟上游 spec-extract 输出)
  const specsAsMarkdown = spec.phases.map((p, i) => ({
    id: `phase${i + 1}`,
    tip: p.tip,
    derivedTriggers: p.derivedTriggers,
    patterns_count: (p.patterns || []).length,
  }));

  const ctx = {
    blueprint: {
      specs: specsAsMarkdown,
      entities: gameschema.entities,
      plans: null,
      htmlPhaseSlices,
    },
  };

  const prompt = buildSchemaPromptV3(ctx);
  fs.writeFileSync(OUT_PATH, prompt);
  console.log(`📝 wrote ${OUT_PATH}`);
  console.log(`   size: ${prompt.length} chars (~${Math.ceil(prompt.length / 4)} tokens)`);
  console.log(`   sections:`);
  console.log(`     - 静态规则 + mapping cheatsheet: ~${MAPPING_CHEATSHEET.length} chars`);
  console.log(`     - HTML phase slices: ${Object.keys(htmlPhaseSlices).length} phases, ${Object.values(htmlPhaseSlices).reduce((a, b) => a + b.length, 0)} chars`);
  console.log(`     - specs: ${JSON.stringify(specsAsMarkdown).length} chars`);
  console.log(`     - entities: ${JSON.stringify(gameschema.entities).length} chars`);
}
