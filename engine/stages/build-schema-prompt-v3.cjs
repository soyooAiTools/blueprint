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

var PROGRAM_ARCHITECTURE_CONTRACT = [
  '## 程序架构契约（下游 Unity 生成必须遵守）',
  '- 本段只约束当前默认 `gmp-v14` legacy prompt；显式 `unitycomponent-v1` profile 不使用 GMP 命名，必须走 UnityComponent(3) 原生 `Assets/SLGFrameWork/Scripts/{Base,Component,Entity,Manager,Prefab}`、`Entity` / `BaseComponent` / `EntityManager` / `GameEntry`、UnityDeliverySpec 和 v1 hardgate，不生成旧 `Blueprint.UnityComponent` namespace/asmdef。N=10 cold-export corpus 已作为文件级 gate 通过；默认切换仍需显式 cutover 决策，并保留 Editor hydration/final certification 边界。',
  '- 最终 `Assets/Scripts` 只允许 `Core` / `Tool` / `Game` 三个顶层目录；`Core`/`Tool` 保持跨项目通用，`Game` 承载本项目一次性业务逻辑。',
  '- `Core/Base` 放核心 enum、实体/角色/NPC 基类；管理器禁止继承 `MonoSingleton<T>`，统一用场景预挂实例里的 `private static <Type> mInstance` + 只读 `instance` getter，getter 缺实例返回 `null` 且不创建对象；`Core/Components` 放 Movement、Trigger、Interaction、Inventory、Skill 等可选组件；`Core/Modules` 放 MainManager、Pool、Audio、Level/Phase、Event、Drop/Item、UI、Economy、Npc 等核心模块。',
  '- Unity 程序员交付框架冲突以 `/nickTemp/UnityComponent(3).rar` / UnityComponent(3) 工程文档为准：按 `Entity` 持有 scene object 生命周期、`[Serializable] BaseComponent` 承载纯逻辑能力、`EntityManager` 注册并统一 Tick entity、模块间通信优先 EventModule 的理念落地。',
  '- 当前默认 `gmp-v14` legacy 落地到本工程必须使用 GMP 命名：`Core/Base` 至少包含 `GMP_BaseComponent` 与 `GMP_BaseGameFlowEntity`，`Core/Modules` 至少包含 `GMP_EntityManager`；实体必须提供 `AddEcsComponent`、`GetEcsComponent<T>`、`GetFirstEcsComponent<T>`、`HasEcsComponent<T>`，组件生命周期顺序为 `OnAwake -> OnEnable -> OnStart -> OnUpdate -> OnDisable -> OnDestroy`。',
  '- `GMP_MainManager` 是 blueprint 兼容的 GameEntry：集中缓存/初始化 Pool、Audio、Event、EntityManager、UI、Economy、Item/Npc、Phase/Level，并在唯一 Update 中调度 `GMP_EntityManager.Tick(dt)`；不要照搬 UnityComponent 的 Odin/DOTween/本地 Luna 路径，也不要 runtime 创建常驻管理器。确有多 scene 生命周期时可让场景预挂 Manager 持久化，但不能用代码临时 new 管理器。',
  '- UnityComponent(3) 只覆盖程序员 Unity 交付框架冲突；Storyboard2HTML/source HTML/SourceSceneIR/WebGL 的 phase、guideText、targetSequence、entity/resource/gate 一致性仍是最高红线，不得为了框架改造改写语义链路。',
  '- 核心管理层只能有一个主管理器：集中初始化对象池、音频、事件、UI、经济、物品/掉落、NPC、关卡/Phase 等模块，然后启动关卡；PhaseController/Level 不能绕过 MainManager 自启动。',
  '- 状态和步骤类型必须用 enum，例如 `GameState`、`EntityState`、`PhaseGateKind`、`PhaseStepKind`；禁止用 0/1/2 魔法数字或裸字符串表达跨层状态。',
  '- 简单项目自定义继承深度不得超过三层；角色、怪物、交互都属于 Game/Level 业务，禁止把具体项目实体名、资源名、关卡流程写进 Core。',
  '- Player/NPC/Entity 必须走“基类 + 可选组件”组合：Player 按项目真实需要选择 Movement、Trigger、Interaction、Inventory、Skill；不要把所有组件默认塞进 Player。背包能力用 InventoryComponent 扩展，不能把 CarryingType/Carrying 等业务字段散落在 Player 上作为唯一事实源。',
  '- 组件必须是真能力而不是装饰：`GMP_BaseComponent` 子类要拥有自己的状态、调参和语义 API，或通过 OnUpdate/事件订阅参与生命周期；禁止只 `new` 出来再 `AddEcsComponent`，但实际逻辑仍复制在 Entity/Manager 里。',
  '- `GMP_BaseGameFlowEntity` 只负责身份绑定、scene object 生命周期和组件生命周期转发；不要把可见性、位移、交互计数、完成状态、奖励结算等业务便利函数塞进 Entity 基类。位移归 Movement，触发归 Trigger/Interaction，进度归 Game/Level 规则或具体业务实体。',
  '- Tool 层要沉淀跨项目稳定工具：相机、UI 布局校正、视觉引导、primitive/表现辅助等；工具不得硬编码项目实体、资源、phase 文案；Canvas 和核心 UI 节点必须在场景中预创建，不要在业务脚本里 `CreateCanvas/CreateText/AddComponent<Canvas>`。',
  '- 音频必须复用集中式 `GMP_Audio` 管理器，Inspector 暴露 `mLoopSources` 与 `mOneShotSources` 多音源数组；业务只能调用 Audio module API，禁止每个业务对象私建单一 AudioSource。',
  '- 新增业务代码优先写入 `Game/Level`、`Game/Entities`、`Game/Player`；只有跨项目复用能力才允许下沉到 `Core/Components` 或 `Tool`。',
  '- 有 Unity Editor + AIBridge/MCP 时，程序员交付必须用真实场景信息做 Inspector/scene hydration；业务代码禁止靠 runtime `GameObject.Find`、`FindObjectOfType`、`.AddComponent(...)`、`new GameObject(...)` 补常驻场景结构。',
  '- AIBridge 证据必须来自实际运行 AIBridgeCLI，不允许只凭静态报告或项目内路径猜测：先用 `AIBRIDGE_CLI` 或 `command -v AIBridgeCLI` 记录真实 CLI 路径，再运行 `AIBridgeCLI harness status` 和 `AIBridgeCLI editor get_state --timeout <ms>`；把 stdout/stderr/exit code 写进 `MCP_HYDRATION_REPORT.json`、`AIBRIDGE_ATTEMPT_REPORT.json` 或 `AIBRIDGE_REAL_RUN_REPORT.json`。CLI 找到但 Unity Editor/AIBridge 会话超时时必须记录为 `editor-timeout`，不能写成 CLI not found。',
  '- Editor hydration 未完成时不能把 Unity 包标记为最终交付认证通过；static YAML / 文件级检查只能算文件级审计，不能替代 Unity Editor 打开工程、解析 Inspector 引用并完成 AIBridge editor get_state / scene hydration。',
  '- 管理器、HUD、相机、音频和实体引用优先用 `[SerializeField]` / Inspector 赋值；`GetComponent` 只用于当前对象或子对象的局部组件访问，且不要把它当依赖注入方案；场景层级中代码/管理器节点收纳到 `MainGame` 子级下，避免 `GMP_*` 根节点平铺。',
  '- Canvas 标准：场景预创建 `Canvas` + `CanvasScaler` + `GraphicRaycaster`，Render Mode = Screen Space - Overlay，Sort Order = 100，CanvasScaler = Scale With Screen Size，Reference Resolution = 1080x1920，Match = 0.5。',
  '- `GMP_SceneEntityRefs`/serialized refs 是程序员交付的人类可见关键场景实体引用入口，由 AIBridge/Editor 预先写入玩家、相机/HUD 目标、建筑、交互点、CTA 等持久对象；禁止生成通用 object binding 表、隐藏并行数组，也不要保留 `GameSceneCtrl` / `SceneObjectRegistry` 这类隐藏运行时对象表作为第二入口。',
  '- 子弹、金币、掉落物、飘字、命中特效、敌人波次小兵等短生命周期/大量重复对象不进入 `GMP_SceneEntityRefs`，也不要预写成 1000 个 serialized refs；它们必须走 `GMP_Pool` 的 prefab/pool archetype、`Preload`、`Get`、`Return/ReturnAfter`。业务层只向 Pool 请求对象，不直接 Instantiate 作为兜底。',
  '- 跨脚本调用要有明确通道：强所有权关系用 serialized refs/构造注入，广播和模块联动用 `GMP_EventModule.Subscribe/Publish/Unsubscribe`，不要把所有模块互相 `instance.` 直连成网状耦合。',
  '- 程序员可交付反馈规则：一节点一主脚本；只有需要 Unity 生命周期、Inspector 暴露或场景挂载的对象才继承 MonoBehaviour，Movement/Trigger/Interaction/Inventory 等无生命周期能力必须是继承 `GMP_BaseComponent` 的纯逻辑 C# 能力，不挂到场景节点。',
  '- 属性归属要贴组件：MoveSpeed 归 MovementComponent/移动能力，交互半径归 Trigger/Interaction，背包容量归 Inventory；Player/Manager 只编排，不复制每个实体的调参字段。',
  '- 代码要让人类程序员能直接接手：变量名要说明业务含义；只保留会被调用的方法；只有一个调用点且只包一两行的逻辑直接内联；不要为了“看起来分层”拆一堆函数和变量。',
  '- 生命周期入口必须唯一：Init/Configure/Setup 未被调用就删除；如果逻辑依赖 MonoBehaviour 的 Awake/Start，就不要再保留并行 Init；禁止静态 Init/Get/Return 工作流。',
  '- 场景问题优先由 AIBridge/MCP/Editor 处理：Missing Mono Script、Rigidbody、Collider、Animator 等配置不要在业务代码里反复 Find/AddComponent/修复。',
  '- 单例/管理器用场景预挂实例和 serialized refs；不要使用 `MonoSingleton<T>`，单例类里也不要再塞静态 Init/Get/Return 这类工作流方法。',
  '- `GMP_EventModule` 必须有显式 `Subscribe`、`Unsubscribe` 和 `UnSubScribe` 注销别名；禁止只有 Publish/Debug.Log 的假事件模块。',
  '- 性能和兜底：距离门槛用 `sqrMagnitude`；必要兜底只保留真实可进入且有价值的分支。Player、HUD、相机和关键实体必须走固定 Player 引用、`[SerializeField]`、`GMP_SceneEntityRefs` 或固定 addressable path，缺引用只允许短路 `Debug.LogError`，不能堆运行时扫描、创建、修组件的 fallback。',
  '- Phase/流程节点是连续试玩流程和代码/数据组织入口，不是独立关卡；程序员交付的流程资产用 `Flow01_<业务语义>.asset`，`mPhaseId` 用 `flow01_<业务语义>`，禁止只叫 `Phase1.asset` / `phase1`；进入 phase 不能清空资源、重建 Player、重置全场或制造重新开始一局的体验。',
  '- AIBridge 预水合后要清掉一次性临时脚本、通用 object binding 表和运行时场景生成/修复代码：primitive builder、source spec helper、临时生成脚本只允许用于 Editor 侧烘焙；最终交付要删除或下沉为正式 Tool。',
  '- 交付文档必须说明流程如何修改、删除、增加，并给一个具体例子；文档、代码关系图和实际 `FlowXX_<业务语义>.asset` / `GMP_PhaseController.mPhases` 必须一致。',
  '- 脚本尽量在场景开始前就挂好；一次性功能不要拆成一堆空壳类、空函数或只包一行代码的 helper。',
  '- 逻辑与表现分离：根节点挂逻辑和碰撞/交互，骨骼、动画、mesh、特效等美术资源放子节点；除动画事件外，业务逻辑不得依赖表现节点结构。',
  '- 注释只写关键且不容易看懂的地方，用中文大白话说明原因或坑点；不要给自解释字段、Start/Tick 这类常规方法补机械注释。',
  '- 复杂脚本参数说明要清楚：多参数 helper、系统级入口、跨 phase 状态函数要在声明、调用处或函数前说明参数用途、单位、边界和副作用。',
  '- 有意义的空行分块：用空行分隔字段、初始化、输入处理、状态推进、UI 更新、验证/兜底等不同代码块；同一连续逻辑内部不滥用空行，也不要把不同职责挤成一段。'
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
  lines.push('R7. entities 覆盖 assembly plan 全部运行时实体类型/模板；bullet、金币、掉落、特效等大量重复对象写成 pool archetype，不要展开成每个实例');
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
  lines.push(PROGRAM_ARCHITECTURE_CONTRACT);
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
