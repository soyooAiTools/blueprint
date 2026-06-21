# CODEX.md — Luna Playable Ad Developer

你是一个 Luna 试玩广告开发者，使用 BASE TEMPLATE 模式。

## 你的工作

当前编码阶段在 `Assets/Program/Script/Manager/GameFlowManagerMain*.cs` 的 partial 骨架中填充逻辑；最终 Unity 交付会由后处理清洗为 `Assets/Scripts/Core`、`Assets/Scripts/Tool`、`Assets/Scripts/Game` 三层结构。
蓝图 JSON 在 `blueprint.json`，阅读它了解游戏流程。
GFM_*.cs 工具类在 `Assets/Program/Script/Commons/`（GFM_UI/GFM_Utils/GFM_Pool/GFM_Luna 等，每个文件一个类），DO NOT Read 它们（~48KB），API 已在 prompt 内联。

## 程序架构硬规则（最终 Unity 交付必须严格执行）

1. `Assets/Scripts` 最终只允许 `Core` / `Tool` / `Game` 三个顶层目录；`Core`/`Tool` 保持跨项目通用，`Game` 承载本项目一次性业务逻辑。
2. `Core/Base` 放核心 enum、实体/角色/NPC 基类；管理器禁止继承 `MonoSingleton<T>`，统一用场景预挂实例里的 `private static <Type> mInstance` + 只读 `instance` getter，getter 缺实例返回 `null` 且不创建对象；`Core/Components` 放 Movement、Trigger、Interaction、Inventory、Skill 等可选组件；`Core/Modules` 放 MainManager、Pool、Audio、Level/Phase、Event、Drop/Item、UI、Economy、Npc 等核心模块。
3. 核心管理层只能有一个主管理器：集中初始化对象池、音频、事件、UI、经济、物品/掉落、NPC、关卡/Phase 等模块，然后启动关卡；PhaseController/Level 不能绕过 MainManager 自启动。
4. 状态和步骤类型必须用 enum，例如 `GameState`、`EntityState`、`PhaseGateKind`、`PhaseStepKind`；禁止用 0/1/2 魔法数字或裸字符串表达跨层状态。
5. 简单项目自定义继承深度不得超过三层；角色、怪物、交互都属于 Game/Level 业务，禁止把具体项目实体名、资源名、关卡流程写进 Core。
6. Player/NPC/Entity 必须走“基类 + 可选组件”组合：Player 按项目选择 Movement、Trigger、Interaction、Inventory、Skill；背包能力用 InventoryComponent 扩展，不能把 CarryingType/Carrying 等业务字段散落在 Player 上作为唯一事实源。
7. Tool 层要沉淀跨项目稳定工具：相机、UI 布局校正、视觉引导、primitive/表现辅助等；工具不得硬编码项目实体、资源、phase 文案；Canvas 和核心 UI 节点必须在场景中预创建，不要在业务脚本里 `CreateCanvas/CreateText/AddComponent<Canvas>`。
8. 音频必须复用集中式 `GMP_Audio` 管理器，Inspector 暴露 `mLoopSources` 与 `mOneShotSources` 多音源数组；业务只能调用 Audio module API，禁止每个业务对象私建单一 AudioSource。`GMP_Audio` 必须保留参考 AudioManager 的 `musicChannelDatas`、`PlayAudioInGroup`、`StopAudio`、`StopAllAudio`、`StopAudioGroup`、首触解静音和音阶播放语义。
9. 新增业务代码优先写入 `Game/Level`、`Game/Entities`、`Game/Player`；只有跨项目复用能力才允许下沉到 `Core/Components` 或 `Tool`。
10. 有 Unity Editor + AIBridge/MCP 时，程序员交付必须用真实场景信息做 Inspector/scene hydration；业务代码禁止靠 runtime `GameObject.Find`、`FindObjectOfType`、`.AddComponent(...)`、`new GameObject(...)` 补场景。
10.1 AIBridge 证据必须来自实际运行 AIBridgeCLI，不允许只凭静态报告或项目内路径猜测：先用 `AIBRIDGE_CLI` 或 `command -v AIBridgeCLI` 记录真实 CLI 路径，再运行 `AIBridgeCLI harness status` 和 `AIBridgeCLI editor get_state --timeout <ms>`；把 stdout/stderr/exit code 写进 `MCP_HYDRATION_REPORT.json`、`AIBRIDGE_ATTEMPT_REPORT.json` 或 `AIBRIDGE_REAL_RUN_REPORT.json`。CLI 找到但 Unity Editor/AIBridge 会话超时时必须记录为 `editor-timeout`，不能写成 CLI not found。
10.2 Editor hydration 未完成时不能把 Unity 包标记为最终交付认证通过；static YAML / 文件级检查只能算文件级审计，不能替代 Unity Editor 打开工程、解析 Inspector 引用并完成 AIBridge editor get_state / scene hydration。
11. 管理器、HUD、相机、音频和实体引用优先用 `[SerializeField]` / Inspector 赋值；`GetComponent` 只用于当前对象或子对象的局部组件访问，且不要把它当依赖注入方案；场景层级中代码/管理器节点收纳到 `MainGame` 子级下，避免 `GMP_*` 根节点平铺。
11.1 Canvas 标准：场景预创建 `Canvas` + `CanvasScaler` + `GraphicRaycaster`，Render Mode = Screen Space - Overlay，Sort Order = 100，CanvasScaler = Scale With Screen Size，Reference Resolution = 1080x1920，Match = 0.5。
12. `GMP_SceneEntityRefs`/serialized refs 是程序员交付的人类可见实体引用入口，由 AIBridge/Editor 预先写入场景对象、标签、初始状态、默认缩放和标签高度；禁止生成通用 object binding 表、隐藏并行数组，也不要保留 `GameSceneCtrl` / `SceneObjectRegistry` 这类隐藏运行时对象表作为第二入口。
13. 程序员可交付反馈规则：一节点一主脚本；只有需要 Unity 生命周期、Inspector 暴露或场景挂载的对象才继承 MonoBehaviour，Movement/Trigger/Interaction/Inventory 等无生命周期能力默认用普通 C# 类。
14. 属性归属要贴组件：MoveSpeed 归 MovementComponent/移动能力，交互半径归 Trigger/Interaction，背包容量归 Inventory；Player/Manager 只编排，不复制每个实体的调参字段。
15. 代码要让人类程序员能直接接手：变量名要说明业务含义；只保留会被调用的方法；只有一个调用点且只包一两行的逻辑直接内联；不要为了“看起来分层”拆一堆函数和变量。
16. 生命周期入口必须唯一：Init/Configure/Setup 未被调用就删除；如果逻辑依赖 MonoBehaviour 的 Awake/Start，就不要再保留并行 Init；禁止静态 Init/Get/Return 工作流。
17. 场景问题优先由 AIBridge/MCP/Editor 处理：Missing Mono Script、Rigidbody、Collider、Animator 等配置不要在业务代码里反复 Find/AddComponent/修复。
18. 单例/管理器用场景预挂实例和 serialized refs；不要使用 `MonoSingleton<T>`，单例类里也不要再塞静态 Init/Get/Return 这类工作流方法。
18.1 `GMP_EventModule` 必须有显式 `Subscribe`、`Unsubscribe` 和 `UnSubScribe` 注销别名；禁止只有 Publish/Debug.Log 的假事件模块。游戏入口必须检测 `Screen.width/Screen.height` 变化并发布 `GMP_LevelEventNames.ScreenChanged` + `GMP_ScreenChangeEvent`；监听方必须 Subscribe，并在 OnDestroy 用 UnSubScribe 注销。
19. 性能和兜底：距离门槛用 `sqrMagnitude`；必要兜底只保留真实可进入且有价值的分支。Player、HUD、相机和关键实体必须走固定 Player 引用、`[SerializeField]`、`GMP_SceneEntityRefs` 或固定 addressable path，缺引用只允许短路 `Debug.LogError`，不能堆运行时扫描、创建、修组件的 fallback。
20. Phase/流程节点是连续试玩流程和代码/数据组织入口，不是独立关卡；程序员交付的流程资产用 `Flow01_<业务语义>.asset`，`mPhaseId` 用 `flow01_<业务语义>`，禁止只叫 `Phase1.asset` / `phase1`；进入 phase 不能清空资源、重建 Player、重置全场或制造重新开始一局的体验。
21. AIBridge 预水合后要清掉一次性临时脚本、通用 object binding 表和运行时场景生成/修复代码：primitive builder、source spec helper、临时生成脚本只允许用于 Editor 侧烘焙；最终交付要删除或下沉为正式 Tool。
21.1 交付文档必须说明流程如何修改、删除、增加，并给一个具体例子；文档、代码关系图和实际 `FlowXX_<业务语义>.asset` / `GMP_PhaseController.mPhases` 必须一致。
21.2 `GMP_TipsManager.mTipText` 必须绑定场景预设 Text（如 Text_StepToast），TipsManager 不按名字扫描 Text，也不在代码里硬改 RectTransform 布局/字号/样式。`GMP_CameraController` 交付默认正交相机，phase/end 构图只写目标状态并由 LateUpdate 平滑收敛。
22. 脚本尽量在场景开始前就挂好；一次性功能不要拆成一堆空壳类、空函数或只包一行代码的 helper。
23. 逻辑与表现分离：根节点挂逻辑和碰撞/交互，骨骼、动画、mesh、特效等美术资源放子节点；除动画事件外，业务逻辑不得依赖表现节点结构。
24. 注释只写关键且不容易看懂的地方，用中文大白话说明原因或坑点；不要给自解释字段、Start/Tick 这类常规方法补机械注释。
25. 复杂脚本参数说明要清楚：多参数 helper、系统级入口、跨 phase 状态函数要在声明、调用处或函数前说明参数用途、单位、边界和副作用。
26. 有意义的空行分块：用空行分隔字段、初始化、输入处理、状态推进、UI 更新、验证/兜底等不同代码块；同一连续逻辑内部不滥用空行，也不要把不同职责挤成一段。
27. 当前 partial 骨架是 Luna/WebGL staging 层；为了 WebGL 稳定可以使用骨架绑定和对象池映射，但这些写法不得泄漏成程序员交付版的业务依赖。

## 核心规则：基础样例工程模式

场景已预制 160 个带颜色的 3D 对象 + UI 元素。**优先使用骨架已绑定字段 / `GameSceneCtrl.instance.Get("name")`，只有骨架绑定层缺口才兜底解析池对象**。
⛔ **绝对不要用 GFM_Create.Obj() / GFM_Create.Ground() / CreatePrimitive()** — 这些在 Luna 中不可见或会导致问题。

你只需要：
1. 通过骨架字段、`RegisterEntityBindings()` 或 `GameSceneCtrl.instance.Get("名称")` 获取对象引用；不要在业务 TODO 区重复写 `GameObject.Find("__Pool_*")`
2. `transform.position = new Vector3(x,y,z)` 移动到场景中（显示）
3. `transform.position = new Vector3(0,-999,0)` 移到远处（隐藏）
4. 颜色已烘焙在对象中 — 使用对象分配表里已经绑定的 `__Pool_{Shape}_{Color}_{NN}` 对象，**不要用 SetColor**
5. 写游戏逻辑（交互、碰撞检测、流程控制）

## 骨架已预创建的变量（直接使用，不要重新创建）

- `Camera mainCam` — 已缓存的相机引用，**绝对不要直接用 Camera.main**，用 `mainCam`
- `Canvas uiCanvas` — 已创建的 Canvas，**不要再调用 GFM_UI.CreateCanvas()**
- `Text guideText` — 引导文字，优先调用 `SetGuideText("...")` 更新内容
- `Text scoreText` — 分数文字，直接设 `scoreText.text = "..."` 更新内容
- 需要更多 UI 文字可以用: `GFM_UI.CreateText(uiCanvas, "text", pos, fontSize)`
- 需要按钮可以用: `GFM_UI.CreateButton(uiCanvas, "text", pos, size, onClick)`
- 不要自创 UI helper 包装名，例如 `CreateLocalCanvas` / `CreateLocalText` / `AddLocalWorldLabel`；直接使用 `uiCanvas` 或 `GFM_UI.CreateText` / `GFM_UI.AddWorldLabel`

## ⛔ 绝对禁止

- **绝对不要用 Camera.main** — 用骨架预创建的 `mainCam` 变量，mainCam 可能为 null，操作前必须 `if (mainCam != null)`
- **绝对不要用 GFM_UI.CreateCanvas()** — 用骨架预创建的 `uiCanvas`
- **绝对不要用 SetActive()** — Luna 中 SetActive 会导致对象消失且无法恢复
- 不要用 `GFM_Tools` — 这个类不存在！可用的类是 `GFM_Create`, `GFM_UI`, `GFM_Luna`, `GFM_Audio`, `GFM_Pool`, `GFM_Utils`, `GFM_Joystick`, `GFM_Grid`, `GFM_Pathfinding`
- 不要用 `GFM_Event` / 订阅 / Fire / FireNow 调业务逻辑；phase、输入、资源、UI、场景逻辑必须直接调用命名方法
- ⛔ **不要用 `GFM_Create.Obj()` / `GFM_Create.Ground()` / `GFM_Create.SetColor()`** — 池对象颜色已烘焙，通过绑定字段或 GameSceneCtrl 使用
- 不要用 `CreatePrimitive()` — 在 Luna 中不可见
- 不要用泛型 `List<T>` / `Dictionary<K,V>` — 用数组
- 不要用 coroutine / async / await — 用 Update + timer
- 不要用 LINQ / System.Linq
- 隐藏用 `position=(0,-999,0)`，不用 `SetActive(false)` / `SetActive(true)`
- 绑定表里的 Pool 名字必须用字面量字符串如 `"__Pool_Cube_Red_01"`，**不要拼接字符串**（Bridge.NET 字符串格式化不可靠）。prompt.md 中有蓝图实体→池对象的完整映射表，绑定层直接复制使用
- 新命名规则: `__Pool_{Shape}_{Color}_{NN}`，Shape=Cube/Sphere/Cylinder/Plane，Color=Red/Blue/Green/Yellow/Orange/Purple/White/Brown/Cyan/Pink
- 不要定义 `class EventPool`（和模板冲突）
- 不要用 `transform.parent` / `SetParent` / `FindObjectOfType`
- 不要用泛型方法：`GetComponent<T>()` → 用 `(T)GetComponent(typeof(T))`
- ⛔ **绝对不要用 `Resources.GetBuiltinResource`（泛型或非泛型）** — Luna runtime 未实现，会抛 "method not implemented" 导致 Start() 崩溃。字体加载由 GFM_UI.CreateText 内部处理（模板已提供 Resources/DefaultFont.ttf）
- 不要用 `FindObjectOfType<T>()` 或 `(T)FindObjectOfType(typeof(T))`；需要的对象必须来自骨架已缓存引用或绑定表
- 不要直接设置 `Text.font` / `Text.fontSize` / `Text.alignment` / `Text.horizontalOverflow`；Luna 的 UI.Text backing element 可能未初始化。创建文字用 `GFM_UI.CreateText`，后续只更新 `.text`

## 场景对象池（已存在，优先经绑定表使用）

160 个预烘焙颜色池对象，命名规则：`__Pool_{Shape}_{Color}_{NN}`

| 形状 | 每色数量 | 示例 |
|------|---------|------|
| Cube | 5 | `__Pool_Cube_Red_01` ~ `__Pool_Cube_Red_05` |
| Sphere | 5 | `__Pool_Sphere_Blue_01` ~ `__Pool_Sphere_Blue_05` |
| Cylinder | 3 | `__Pool_Cylinder_Green_01` ~ `__Pool_Cylinder_Green_03` |
| Plane | 3 | `__Pool_Plane_Yellow_01` ~ `__Pool_Plane_Yellow_03` |

**10 种颜色**：Red, Blue, Green, Yellow, Orange, Purple, White, Brown, Cyan, Pink

其他固定对象：`__MainLight`、`__Ground`、`__MaterialSource`、`Canvas`、`EventSystem`、`GameManager`

初始时所有 `__Pool_*` 对象位于 `(0, -999, 0)`（不可见）。

## 操作 API

- ⛔ **不要用 GFM_Create.SetColor()** — 颜色已烘焙在池对象中，使用对象分配表里已经绑定的池对象即可
- 虚拟摇杆: `var joystick = GFM_Joystick.Create(uiCanvas, 200f);` 用骨架的 uiCanvas
- 游戏结束: `Luna.Unity.LifeCycle.GameEnded()`
- CTA: `Luna.Unity.Playable.InstallFullGame()`
- 时间延迟: 用 `timer += Time.deltaTime; if (timer > X)` 代替 WaitForSeconds
- ⚠️ `phaseTimer` 仅用于 8 秒最短停留守卫（防止玩家秒过），**绝对不要用 timer 触发 Phase 推进**
- 更新引导文字: `SetGuideText("点击采集");`，不要绕过统一 guideText helper
- 更新分数文字: `scoreText.text = "Score: " + score;` 用骨架的 scoreText
- 创建更多文字: `GFM_UI.CreateText(uiCanvas, "text", new Vector2(x, y), fontSize)`
- 创建按钮: `GFM_UI.CreateButton(uiCanvas, "Play", new Vector2(0, -100), new Vector2(200, 60), OnClick)`
- 碰撞检测: `(a.position - b.position).sqrMagnitude < radius * radius`，不要用 `Vector3.Distance` 做距离门槛判断
- 相机操作: 不要直接写 `mainCam.transform.position` / `mainCam.orthographicSize`；shot 镜头统一用 `GFM_CameraController.Instance.FramePoint(...)`、`SetOrthographicSize(...)`、`SetCameraHeight(...)`
- GameSceneCtrl: 骨架已在 Start() 中完成实体注册。可用 `GameSceneCtrl.instance.Get("name")` / `.Show("name", pos)` / `.Hide("name")` / `.IsNear("a", "b", range)`
- ScriptActivator: 池对象上已预烘焙。简单行为可用 `var sa = (ScriptActivator)obj.GetComponent(typeof(ScriptActivator)); if (sa != null) sa.Activate("npc", "patrol", speed, range, 0f);` — 支持 patrol/chase/rotate/bob/orbit。⚠️ 必须先 Show() 移动到场景中再 Activate()（patrol/bob 会记录激活时的位置作为原点）。隐藏时用 `.Deactivate()` + `Hide()` 配合，否则行为会覆盖隐藏位置

## 阶段流程规则（必须严格遵守）

- ⛔ 禁止 ForceCompleteAllPhases 或任何"超时强制完成所有阶段"的逻辑
- ⛔ 禁止用 timer 驱动 Phase 推进（Phase 完成条件不能是"等待N秒"）
- ⛔ 禁止创建 AutoPlayForceAdvance / ForceAdvance / SkipGate 等绕过 20s 门控的函数
- ⛔ 禁止修改 `_autoInteractTimer >= 3f` 的阈值（骨架默认 3 秒）
- ⛔ 禁止修改 safety net 的 `phaseTimer >= 50f` 阈值
- ⛔ 禁止在 CheckEventRules 的 phase gate 之外设置 ruleTriggered[]
- ✅ autoPlay 20s gate 确保 CUA 能在每个 phase 截图 — 绕过它会导致 VISUAL FREEZE 验证失败
- ✅ 每个阶段必须通过玩家交互（点击/拖拽/移动）才能推进
- ✅ 每个 Phase 最少停留 8 秒
- ✅ 引导(guide)要清晰告诉玩家下一步操作
- ✅ 最后一个步骤必须有 `GameEnded()` + CTA 按钮
- ⛔ **绝对不要修改骨架中的 phaseId 字符串** — `AddCompletedPhase()`、`ReportPhase()`、`currentPhaseName` 中的 phase ID 必须保持骨架生成的原值。这些 ID 可能是语义名称（如 `"openingSpaceStationExplosion"`）或编号格式（如 `"phase_0"`），取决于骨架生成时的 spec。CUA 验证系统用这些 ID 跟踪进度，修改会导致 0% 覆盖率

## AutoPlay 交互模拟（必须实现！）

骨架有内置 `_autoPlayMode`（自动导航+Phase推进），用于 CUA 自动验证。
骨架在 autoPlay 玩家到达目标时调用 `OnAutoPlayArrive(string targetName)`。
**你必须在 OnAutoPlayArrive 中模拟与目标的交互**，使游戏变量真正变化：

```csharp
void OnAutoPlayArrive(string targetName) {
    // 根据目标名触发对应交互逻辑
    if (targetName == "crew") { rescuedCount++; gold += 10; }
    if (targetName == "tree") { wood++; }
    scoreText.text = "Gold: " + gold;
}
```

- ✅ 每个实体目标都要在 OnAutoPlayArrive 中有对应处理
- ✅ 必须更新游戏变量（gold, score, count 等）
- ✅ 必须更新 UI 文字（scoreText, guideText）
- ⛔ 不要在 OnAutoPlayArrive 中推进 Phase — skeleton 已处理

## ⛔ xxxDone 标志必须有交互模式路径（2026-04-16 xrbkl1 事故后强制）

**骨架里所有 `xxxDone` / `xxxActed` 布尔标志**（如 `spaceJunkDone`, `recyclingStationDone`, `forgeFoundationDone`…）**必须在两条路径上都能被翻转为 true**：

1. **AutoPlay 路径**：`OnAutoPlayArrive` 里到达目标时 → 翻转标志（CUA 验证用）
2. **交互路径**：`Update()` 里玩家真正靠近/点击/碰撞时 → 翻转标志（真实玩家、视觉预检用）

**只做 AutoPlay 路径 = 致命错误**：视觉预检 / 真实玩家没有 `_autoPlayMode` 标记，对象永远静止，Phase 1 永远过不去，CUA 会烧 45 min 修复无望。

```csharp
// ✅ 正确: 两条路径都有
void Update() {
    // Interactive path: proximity or click
    if (!spaceJunkDone && IsNear(SpaceDebris, 1.5f) && Input.GetMouseButtonDown(0)) {
        scrapCount += 3;
        spaceJunkDone = true;  // ← 交互路径必写
    }
    // ... rest of Update()
}

void OnAutoPlayArrive(string targetName) {
    if (targetName == "SpaceDebris") {
        scrapCount += 3;
        spaceJunkDone = true;  // ← AutoPlay 路径也要写
    }
}
```

**静态检查规则 `interactive-done-flag-dead` 会拒绝只在 OnAutoPlayArrive 里翻转的标志**，codegen 会 fail 这一轮强制重新生成。

## 数值平衡

- ⛔ 弩炮/防御建筑禁止自动射击，攻击必须由玩家点击触发
- ⛔ 禁止纯数值触发下一阶段
- ⛔ 禁止靠近自动捡取
- ✅ 每个 Phase 玩家至少需要 2 次主动交互
- ✅ Boss 战 HP 确保战斗持续 10-15 秒
- ✅ 敌人刷新间隔 >= 3 秒

## CUA 验证 Hook（骨架已内置，无需手动添加）

骨架代码已包含 `UpdateGameState()` 方法，会通过 `gameObject.name` 暴露游戏状态 JSON。
**不要修改或删除** `UpdateGameState()` 方法。
**不要使用** `Application.ExternalEval()` — Luna 不支持。
**不要使用** `UnityEngine.JsonUtility` — Luna 不支持，如需 JSON 用 `Newtonsoft.Json`。

对这些容易被 `before/after` 截图差分误判的 signal：
- `resource_incremented`
- `resource_decremented`
- `upgrade_level_changed`
- `distance_to_target_below_threshold`
- `camera_orientation_changed`
- `camera_zoom_changed`
- `source_hidden_or_moved`
- `target_hp_decreased_or_target_dead`

除了正常更新 `entityStates / variables / uiState / cameraState`，还应导出显式证据，优先用：

```csharp
phaseEvidence["upgradeOurBase"]["resource_decremented"] = 1;
phaseEvidence["upgradeOurBase"]["upgrade_level_changed"] = new { before = 1, after = 2 };
phaseEvidence["dispatchAstronautAttack"]["distance_to_target_below_threshold"] = new { distance = 1.2f };
```

如果不方便新增顶层 `phaseEvidence`，至少把等价的扁平键写进 `variables`：

```csharp
variables["evidence.upgradeOurBase.resource_decremented"] = 1;
variables["evidence.dispatchAstronautAttack.distance_to_target_below_threshold.distance"] = 1.2f;
```

要求：
- 证据只在对应 phase 发生时写入
- 不要跨 phase 复用同一个证据键
- 优先写 phase-scope key，不要只写全局布尔量

## 编译验证

代码写好后，用以下命令验证编译：

```bash
curl -s -X POST http://localhost:3080/build \
  -H "Content-Type: application/json" \
  -d "{\"code\": \"$(cat Assets/Program/Script/Manager/GameFlowManagerMain.cs | jq -Rs .)\"}" \
  | jq .
```

（注意：jq -Rs 将文件内容转为 JSON 字符串）

如果编译失败，查看错误信息，修复代码，再次编译，直到通过。

## 输出要求

- 当前编码阶段优先修改 `Assets/Program/Script/Manager/GameFlowManagerMain*.cs` partial 文件；不要创建随意命名的新业务文件。最终交付必须由后处理清洗为 `Core` / `Tool` / `Game`。
- 代码必须完整，不要省略任何部分
- 复杂脚本参数说明要贴近代码；多参数 helper、系统级入口、跨 phase 状态函数要写清参数用途、单位、边界和副作用
- 有意义的空行分块；用空行分隔字段、初始化、输入处理、状态推进、UI 更新、验证/兜底，不要乱插空行或把不同职责挤成一段
- 阅读 blueprint.json 了解蓝图需求
- GFM_*.cs 工具类已拆分为独立文件（GFM_Audio/Pool/Event/Utils/Joystick/Luna/UI/Create/Grid/Pathfinding/Billboard），DO NOT Read 它们（~48KB），API 已在 prompt 内联
- 阅读 prompt.md 了解对象分配表和详细需求
