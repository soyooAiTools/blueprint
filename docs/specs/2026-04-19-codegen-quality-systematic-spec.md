# Codegen 质量系统性改造 Spec

**日期**: 2026-04-19
**关联任务**: urbib0(太空捡垃圾)为基线样本
**作者**: Claude (依据用户 7 条反馈)

> 状态：历史方案，已被 2026-06-23 gmp-v14 legacy / unitycomponent-v1 双 profile 程序员交付口径取代。本文中“每个变量/方法有详细注释”、五系统 partial class、`Assets/Program/Script/Game` 等旧要求不再作为当前 prompt 或最终 Unity 交付约束。当前默认 `gmp-v14` legacy 口径要求稀疏关键中文注释、Core/Tool/Game 三层、`GMP_BaseComponent` + `GMP_BaseGameFlowEntity` + `GMP_EntityManager`、AIBridge/Editor hydration、`GMP_SceneEntityRefs` / serialized refs；显式 `unitycomponent-v1` 要求 UnityComponent(3) 原生 `Assets/SLGFrameWork/Scripts/{Base,Component,Entity,Manager,Prefab}`、`Entity` / `BaseComponent` / `EntityManager` / `GameEntry`、UnityDeliverySpec 和 v1 hardgate；不得为了框架改造破坏 storyboard2html/source HTML/WebGL 语义一致性。

---

## 摘要

用户审阅 urbib0 产物后提出 7 条质量诉求,本 spec 把它们系统性落到 pipeline 各环节(skeleton-generator / codegen-template-engine / codegen-schema / prompt / canonical 库 / 静态规则),**而不是靠 prompt 口头约束 AI**。

**一句话目标**: 让 codegen 产出的 `GameFlowManagerMain.cs` 自动满足「文档级注释 + 五系统分层 + 方法粒度拆分 + 直接调用」,违反则静态规则 blocking。

**不涉及**: Luna WebGL 引擎本身、spec 提取、CUA、美术资源。

---

## 1. 背景: urbib0 当前产物画像

| 项 | 值 | 期望 |
|---|---|---|
| `GameFlowManagerMain.cs` 行数 | 1604 | ≤ 800(主类),超出拆 partial |
| `GameFlowManagerMain.Systems.cs` 行数 | 22(空壳) | ≥ 300(真实承载 4 子系统) |
| `Update()` 行数 | ~130 行一坨 | 拆成 ≤5 个分类 Handler,每个 ≤30 行 |
| 点击 phase 分派 | 12 个平行 `if (currentPhaseName=="...")` | 查表 / per-phase method |
| 变量行内注释密度 | 块级有,行内 < 30% | 关键变量 100% 行内说明 |
| 条件分支行内注释 | 几乎无 | 非显而易见分支必须有 `// 为什么` |
| UI referenceResolution | 960×640 写死 | 见 §4.3(分歧点待决) |
| 方法调用方式 | 直接调用,零 UnityEvent | ✅ 已合规,需固化为静态规则 |

**pipeline 调研结论**: 当前所有问题根因都在 `/opt/blueprint-editor/` 这 4 个文件,而非 AI 生成质量:

- `adapters/skeleton-generator.cjs` — 骨架 TODO 粒度
- `adapters/codegen-template-engine.cjs` — 模板填充与方法切分
- `worker/prompt-v5-basetemplate.js` — AI fill 时的约束/示例
- `worker/promoted-rules.json` — 静态规则(目前 8 条,拆分规则缺失)

---

## 2. 七条诉求 → 改造点映射

| # | 诉求 | 落点 | 严重性 | 阶段 |
|---|-----|------|-------|------|
| 1 | 每个变量/方法有详细注释 | skeleton + prompt + 静态规则 `require-member-doc` | P0 | W1 |
| 2 | 每种条件有详细注释 | prompt 示例 + 静态规则 `require-branch-comment`(非琐碎分支) | P1 | W1 |
| 3 | UI 按 1920×1080 | 骨架 UI 建 Canvas + 设计稿换算(§4.3 待决) | P2 | W2 |
| 4 | 拆 5 个系统(Flow/Input/Resource/UI/Scene) | skeleton 生成 5 partial 文件 + type-dispatched flow | P0 | W1 |
| 5 | 方法按功能分脚本类型,不塞一起 | 配合 #4,每子系统独立 partial 文件,静态规则按文件名约束 | P0 | W1 |
| 6 | HandlePlayerInteractions 类方法不堆 if/else | skeleton 生成 per-phase handler 方法 + 查表调度 | P0 | W1 |
| 7 | 直接调用,不走事件系统 | 已合规,新增静态规则 `no-unityevent` / `no-action-invoke` 固化 | P0 | W1 |

---

## 3. 目标架构:五系统 Partial Class

### 3.1 文件布局(新生成产物)

```
Assets/Program/Script/Game/
├── GameFlowManagerMain.Flow.cs       # 流程控制(主入口) — 原 Main.cs 位置
├── GameFlowManagerMain.Input.cs       # 输入处理
├── GameFlowManagerMain.Resource.cs    # 资源系统
├── GameFlowManagerMain.UI.cs          # UI 表现
└── GameFlowManagerMain.Scene.cs       # 场景控制
```

全部是 `public partial class GameFlowManagerMain`,共享字段,编译为单一类。

**为什么 partial 而不是 5 个独立 Manager**:
- 现有 canonical 库已有 `GFM_EconomyManager` / `GFM_UIManager` 等,独立 Manager 层已存在 → 顶层业务代码走 partial 更合适,不重复造轮子
- Unity C# partial 天然支持,无需运行时注册
- skeleton-generator 已有 `Systems.cs` 占位机制,延续路径成本最低

### 3.2 五系统职责定义

| 系统 | 承载内容 | 关键方法 | 字段归属 |
|-----|---------|---------|---------|
| **Flow** | Start/Update/CheckEventRules 主循环、phase 状态机、type 分派 | `RunFlow()` / `EnterPhase(string type)` / `DispatchByType()` | `phaseTimer`, `currentPhaseName`, `ruleTriggered[]`, `completedPhases` |
| **Input** | 点击/触屏/摇杆/tap-to-move | `HandleTap()` / `HandleJoystick()` / `HandleTapToMove()` | `_autoPlayMode`, `joystickState` |
| **Resource** | 金币/库存/采集/消耗 | `Collect(entity)` / `Spend(resId, amount)` / `TransferToStash()` | `MetalShardCarried`, `gold`, entity 状态变量 |
| **UI** | Canvas/文字/引导/浮动提示 | `UpdateGuide(phase)` / `ShowGain(worldPos, text)` | `uiCanvas`, `guideText`, `scoreText` |
| **Scene** | 实体放置/隐藏/缩放/预烘焙绑定 | `PlacePhase1Objects()` / `HidePhase1Objects()` | 所有 `GameObject` 引用(SpaceJunk, ForgeWorkshop…) |

### 3.3 Flow 系统的 type 分派(对应需求 #4)

每个 phase 在 spec 里标 `flowType`,由 Flow 系统按 type 路由到只处理该 type 的逻辑:

```csharp
// GameFlowManagerMain.Flow.cs
void EnterPhase(PhaseDef phase) {
    switch (phase.flowType) {
        case "collect":   EnterCollectPhase(phase); break;   // 采集类(move + IsNear + addResource)
        case "build":     EnterBuildPhase(phase); break;     // 建造类(spend + 外观切换)
        case "deliver":   EnterDeliverPhase(phase); break;   // 交付类(到点 + 消耗库存)
        case "upgrade":   EnterUpgradePhase(phase); break;   // 升级类(cost-gated-click + 属性变化)
        case "defend":    EnterDefendPhase(phase); break;    // 防守类(spawner + damageable)
        // 5 类覆盖现有所有 phase;新增类型必须同步加 rule
    }
}
```

**好处**: 每个 `Enter*Phase` 方法只处理一种 flowType,新增 phase 不污染其他类型;可单独测试。

### 3.4 per-phase handler(对应需求 #6)

点击/交互分派从当前的「12 个平行 if」改为 per-phase method + 查表:

```csharp
// GameFlowManagerMain.Input.cs
Dictionary<string, Action> _tapHandlers;

void InitTapHandlers() {
    _tapHandlers = new Dictionary<string, Action> {
        { "initialCollectSpaceJunk", OnTap_InitialCollectSpaceJunk },
        { "sellShardsGetGold",       OnTap_SellShardsGetGold },
        // ...per phase 一行
    };
}

void HandleTap() {
    if (_autoPlayMode) return;
    if (!Input.GetMouseButtonDown(0) && Input.touchCount == 0) return;
    if (_tapHandlers.TryGetValue(currentPhaseName, out var h)) h();
}

// 每个 handler 独立小方法
void OnTap_InitialCollectSpaceJunk() {
    // 用户首次点击进入"采集"意图;仅标记交互发生,实际采集由 Resource.Collect 驱动
    initialCollectSpaceJunkInteractionDone = true;
}
```

---

## 4. 设计细则(逐条诉求)

### 4.1 注释(#1 + #2)

**原则**: 不强制 AI 写所有注释(会撞 token budget 和 5min 流超时),**由 skeleton-generator 自动写模板注释 + 静态规则兜底**。

**三层注释来源**:

1. **骨架自动注释**(占 70%): skeleton-generator 在生成字段/方法签名时直接带 `/// <summary>` XML doc
   ```csharp
   /// <summary>Phase 计时器;当前 phase 进入后累计秒数,用于强制最短停留。</summary>
   float phaseTimer = 0f;

   /// <summary>点击分派器;按 currentPhaseName 路由到 OnTap_{PhaseName} 处理器。</summary>
   void HandleTap() { ... }
   ```

2. **AI fill 注释**(占 20%): prompt 要求 AI 在 TODO_CUSTOM 内写逻辑时,对**非显而易见的数值常量**和**非直观条件**必须加行内 `// 为什么` 注释
   ```csharp
   // 带 3m 余量防 IsNear 误判(SpaceJunk 直径 ≈1m,漂浮幅度 ±1m)
   if (IsNear(SpaceJunk, 1.5f)) { ... }
   ```

3. **静态规则兜底**(占 10%): 扫描产物,对缺注释的变量/方法报 blocking warning
   - `require-member-doc`: public/protected 字段必须有 XML doc
   - `require-branch-comment`: 有魔数/字符串字面量的 if 条件必须有前置或行尾注释(琐碎条件如 `if (x > 0)` 豁免)

**琐碎豁免清单**(白名单):
- 循环计数 `for (int i=0; i<list.Count; i++)`
- null 检查 `if (obj == null) return;`
- 布尔状态 `if (isReady)` / `if (!isReady)`

### 4.2 五系统拆分(#4 + #5)

**修改位置**: `/opt/blueprint-editor/adapters/skeleton-generator.cjs`

**当前**: 单文件 `GameFlowManagerMain.cs` + 几乎空的 `Systems.cs`
**目标**: 始终产出 5 partial 文件,每文件有明确 TODO 标记位

**skeleton-generator 新增导出函数**(草案):
```js
generateFlowPartial(ctx)     // → GameFlowManagerMain.Flow.cs
generateInputPartial(ctx)    // → GameFlowManagerMain.Input.cs
generateResourcePartial(ctx) // → GameFlowManagerMain.Resource.cs
generateUIPartial(ctx)       // → GameFlowManagerMain.UI.cs
generateScenePartial(ctx)    // → GameFlowManagerMain.Scene.cs
```

**字段归属硬规则**(skeleton 侧决定,AI 不能动):
- 实体引用字段(`GameObject SpaceJunk`) → 只在 `Scene.cs` 声明
- 资源库存(`int MetalShardCarried`) → 只在 `Resource.cs` 声明
- UI 引用(`Text guideText`) → 只在 `UI.cs` 声明
- phase 状态(`float phaseTimer`) → 只在 `Flow.cs` 声明
- 输入状态(`bool _autoPlayMode`) → 只在 `Input.cs` 声明

**静态规则** `field-in-wrong-partial`: 扫描字段声明,与上表不符报 blocking。

### 4.3 UI 分辨率(#3)✅ **已决定: 方案 A,直接改 1920×1080**

**决议**(2026-04-19 用户): Canvas referenceResolution 统一改为 1920×1080,全部坐标/字号按 1:2 比例放大重算。

**改造动作**:

1. `worker/GFM_UI.cs`
   ```csharp
   // 默认参考分辨率 1920×1080(FHD 设计稿)
   public static Canvas CreateCanvas(int refWidth = 1920, int refHeight = 1080) { ... }
   ```
2. `adapters/skeleton-generator.cjs` — 骨架调用 `CreateCanvas()` 走默认,不再传 960/640
3. `adapters/codegen-template-engine.cjs` — UI 位置/字号模板全量 ×2:
   | 原值 (960×640) | 新值 (1920×1080) |
   |---|---|
   | `new Vector2(0, 270)` guide | `new Vector2(0, 450)` |
   | `new Vector2(340, 290)` score | `new Vector2(680, 480)` |
   | 字号 `26` | 字号 `52` |
   | 字号 `20` | 字号 `40` |
4. `docs/storyboard-writing-guide.md` — 补「分镜 UI 坐标以 1920×1080 标注」章节

**风险**:
- Luna WebGL 在低端设备 Canvas 填充率成本上升(UI 占屏幕更多像素)— 若出现性能回归,在 `CanvasScaler.matchWidthOrHeight` 侧调节,而非回退分辨率
- memory `feedback_luna_webgl_size.md` 已记录 Luna 体积不可避免,此处同样只能接受

**工期**: 0.5 天(模板坐标改写 + 回归验证)。

### 4.4 方法拆分与 Phase 分派设计(#6)✅ **深度调研后决议: 两阶段方案 1→2**

**调研背景**: 9 个候选模式(State / Strategy+Dict / switch expression / Command / ScriptableObject / JSON-driven / NodeCanvas / ECS / Component-per-Phase),经 Luna WebGL 约束过滤后**6 个被直接排除**:

| 被排除模式 | 硬约束 |
|---|---|
| State Pattern(abstract+virtual) | Bridge.NET 虚方法 strip 风险,GFM_*.cs 零使用证据 |
| Strategy+`Dictionary<string,IPhaseHandler>` | `dict-generic` blocking + 复合泛型 Bridge IR 易炸 |
| ScriptableObject 驱动 | Luna 不走标准 WebGL pipeline,.asset 加密路径断 |
| 反射自动注册 | Runtime Analysis 默认剥除 `System.Reflection` |
| Behavior Tree 第三方库 | 二进制资产 + AI codegen 不兼容 |
| ECS/DOTS | 与 Luna 渲染管线完全冲突 |

**W1 落地: 方案 1 — Switch + per-phase method(Luna-safe Strategy)**

每个 phase 在 skeleton 里静态生成 3 个具名小方法:
```csharp
// GameFlowManagerMain.Flow.cs
void EnterPhase(string phaseId) {
    switch (phaseId) {
        case "initialCollectSpaceJunk": OnEnter_InitialCollectSpaceJunk(); break;
        case "sellShardsGetGold":       OnEnter_SellShardsGetGold(); break;
        // ...一行一 phase,与 spec 同构
    }
}

// GameFlowManagerMain.Input.cs
void HandleTap() {
    if (_autoPlayMode) return;
    if (!Input.GetMouseButtonDown(0) && Input.touchCount == 0) return;
    switch (currentPhaseName) {
        case "initialCollectSpaceJunk": OnTap_InitialCollectSpaceJunk(); break;
        // ...
    }
}

// 各 phase 独立小方法(≤30 行),放入对应 partial 文件
void OnTap_InitialCollectSpaceJunk() {
    // 首次点击进入采集意图
    initialCollectSpaceJunkInteractionDone = true;
}
```

**为何方案 1 而不是 Dictionary 查表**:
- `Dictionary<string, Action>` 被 Luna `dict-generic` blocking 规则拦
- `delegate void PhaseHandler()` + `new PhaseHandler[]` 平行数组虽可行,但 skeleton 生成复杂度高于 switch
- switch-case 在 Bridge.NET 编译稳定,GFM_Event.cs 同款范式已验证

**W2-W3 升级: 方案 2 — JSON Schema + Interpreter**

把 phase 行为从 C# 代码升级到 schema 数据(扩展现有 8 trigger / 6 action):
```csharp
// skeleton 机械生成的中央解释器(AI 不碰)
bool CheckTrigger(Trigger t) {
    switch (t.type) {
        case "entity_state_reached": return entityStates[t.entityIdx] >= t.value;
        case "resource_collected":   return eco.GetResource(t.id) >= t.amount;
        // ... 8 种全在一处
    }
}
void ExecuteAction(PhaseAction a) {
    switch (a.type) {
        case "add_resource":     eco.AddResource(a.id, a.amount); break;
        case "set_entity_state": entityStates[a.entityIdx] = a.value; break;
        // ... 6 种全在一处
    }
}
// phase 数据是 skeleton 烘焙到 C# 源码的平行数组(非 JSON 运行时解析,避 Newtonsoft 坑)
```

W2 目标: TODO_CUSTOM 中 ~170 行 AI fill 逻辑里,把可数据化的(采集/兑换/升级/CTA)全部下放到 schema,AI 只产 JSON,不再填 C# 函数体。memory `project_schema_driven_codegen_20260416.md` 的 3-step pipeline 是铺垫。

**三方案对比(Luna-safe 候选)**:

| 维度 | 方案 1 Switch+method | 方案 2 JSON+Interpreter | 方案 3 Component-per-Phase |
|---|---|---|---|
| AI 生成难度 | 低 | **最低**(只扩 JSON) | 中(产 13 独立文件) |
| Luna 兼容 | **已验证** | **已验证** | 未验证(预烘焙 MB enabled 切换无先例) |
| 调试 | 堆栈直达 `OnTap_X` | 需看 JSON+解释器 | Inspector 可视化最清晰 |
| 改造成本 | **6-8h** | 16-24h | 20-30h + Luna 风险 |
| urbib0 行数 | 900-1100 | **700-850** | 1100-1400 |
| if 消除度 | 中(仍有分派 switch) | **高**(分支都在数据里) | 高(多态) |
| W1 可行性 | ✅ 立刻 | ❌ 工期超 W1 | ❌ Luna 风险 |

**方案 3(Component-per-Phase) 明确不采用**: 预烘焙 MonoBehaviour enabled 切换在 Luna 运行时路径无先例(ScriptActivator 是孤例),调试优势被 codegen 模式削弱。

**禁令补充**: 任何子方法 ≥ 60 行(`method-too-long` blocking,白名单 exempt 见 §6);除 `EnterPhase` / `HandleTap` / `CheckTrigger` / `ExecuteAction` 4 个**顶层分派器** switch 可长之外,其它业务代码 `if/else` 链 ≥ 4 分支一律 blocking(`long-if-chain`)。

### 4.5 直接调用,禁事件系统(#7)

**现状**: 已零 UnityEvent,零 `event Action`,零 `.AddListener`。
**改造**: **不改代码,只固化规则**,防止将来 AI 或人为回退。

**静态规则** `no-unityevent-in-flow`:
- 禁止 `UnityEvent` 字段声明(Resource/Scene 层,除非来自 GFM_* 库)
- 禁止 `public event Action ...`
- 禁止 `.AddListener(` / `.RemoveListener(`
- 禁止 `.Invoke()` 在非 Delegate 上(保留 `SendMessage` 等 Unity API)

---

## 5. 改动清单(文件级)

### 5.1 修改

| 文件 | 改动 | 工作量 |
|---|---|---|
| `adapters/skeleton-generator.cjs` | 拆出 `generate{Flow,Input,Resource,UI,Scene}Partial`;字段按归属表生成;XML doc 自动化 | L |
| `adapters/codegen-template-engine.cjs` | TODO 标记从 `TODO_CUSTOM_N` 改为 `TODO_FLOW_N / TODO_INPUT_N / ...`,定向 fill | M |
| `engine/stages/codegen-schema.cjs` | phase 必填 `flowType` 枚举;校验 | S |
| `worker/prompt-v5-basetemplate.js` | 新增「每个 TODO 属于哪个系统」章节;注释要求示例 | M |
| `worker/promoted-rules.json` | 新增 5 条规则(见 §6) | S |
| `worker/GFM_UI.cs` | `CreateCanvas` 默认 1920×1080;注释标明 FHD 基准 | XS |
| `adapters/codegen-template-engine.cjs`(UI 段) | 所有 UI 坐标/字号 ×2 重写模板常量 | S |
| `docs/storyboard-writing-guide.md` | 补「分镜 UI 坐标以 1920×1080 标注」章节 | S |

### 5.2 新增

| 文件 | 用途 |
|---|---|
| `engine/stages/static-check/require-member-doc.cjs` | 规则 #1 实现 |
| `engine/stages/static-check/require-branch-comment.cjs` | 规则 #2 实现 |
| `engine/stages/static-check/partial-split-enforce.cjs` | 规则 #4#5 实现(字段归属+文件存在) |
| `engine/stages/static-check/method-too-long.cjs` | 规则 #6a |
| `engine/stages/static-check/long-if-chain.cjs` | 规则 #6b |
| `engine/stages/static-check/no-unityevent.cjs` | 规则 #7 |

---

## 6. 新增静态规则(promoted-rules.json 追加)

**分档上线策略**(选项 B,2026-04-19 决议):
- **结构性规则**(skeleton 控输出,违规即 bug): day 1 直接 blocking
- **质量性规则**(阈值/白名单需实测调): day 1 warning,W2 末按分布转 blocking

```json
{
  "partial-split-enforce": {
    "severity": "blocking",
    "phase": "W1 day1",
    "desc": "必须存在 5 个 partial 文件;字段声明必须在归属文件",
    "rationale": "skeleton-generator 确定性输出,违规 = skeleton bug"
  },
  "long-if-chain": {
    "severity": "blocking",
    "phase": "W1 day1",
    "threshold": 4,
    "desc": "连续 if/else-if ≥4 条必须改查表或 switch",
    "rationale": "本次重构核心目标,W1 重构后归零,再出现 = AI 越权"
  },
  "no-unityevent-in-flow": {
    "severity": "blocking",
    "phase": "W1 day1",
    "desc": "禁止 UnityEvent / event Action / AddListener 在业务代码",
    "rationale": "现状已零违规(grep 确认),护栏防回退"
  },
  "method-too-long": {
    "severity": "warning",
    "phase": "W1 warning → W2 末评估转 blocking",
    "threshold": 60,
    "exempt": ["Update", "Start", "EnterPhase", "HandleTap", "CheckTrigger", "ExecuteAction"],
    "rationale": "阈值主观,需收集真实分布(urbib0 基线 5-8 方法超标),W2 末按 95 分位调到稳定值再转 blocking"
  },
  "require-member-doc": {
    "severity": "warning",
    "phase": "W1 warning → W3 skeleton 升级完成后转 blocking",
    "scope": ["GameFlowManagerMain.*.cs"],
    "desc": "public/protected 字段和方法必须有 XML doc 或 /// 注释",
    "exempt": ["private 常量", "override", "Unity 生命周期方法已内联注释"],
    "rationale": "skeleton-generator 升级前 blocking 会炸 60% 任务;W3 skeleton 自动生成 XML doc 稳定后再转"
  },
  "require-branch-comment": {
    "severity": "warning",
    "phase": "可能永久 warning",
    "scope": ["GameFlowManagerMain.*.cs"],
    "desc": "含字面量魔数或字符串字面量的 if 条件必须有注释",
    "exempt": ["if (x == null)", "if (!flag)", "循环边界"],
    "rationale": "豁免白名单主观性最强,实测一周后才能判断是否可转 blocking"
  }
}
```

---

## 7. 验证判据

用 urbib0 作回归样本,重跑 pipeline,产物必须全部满足:

1. 产出 5 个 partial 文件,每个 > 100 行(真拆,不是空壳)
2. 主 Flow 文件 ≤ 800 行
3. 每个字段有 XML doc(100% 覆盖,不含局部变量)
4. `HandleTap` / `HandlePlayerInteractions` 类方法 ≤ 30 行
5. 零 UnityEvent / AddListener(grep 验证)
6. CUA 一次性通过(不劣化 2026-04-17 首次通过基线)
7. 6 条新静态规则 0 violation
8. 代码行数总量允许 +15%(拆分引入额外结构)

**失败即 rollback**,memory 存 project 记录作为案例库。

---

## 8. 分期与风险

### 8.1 分期(三周)

| 阶段 | 内容 | 依赖 |
|-----|-----|-----|
| **W1**(本周) | #1#4#5#6#7 落地(注释+拆分+方法粒度+规则固化)。跑 urbib0 回归 | - |
| **W2** | #2(条件注释规则调优,过严会烦)+ #3(UI 方案 B 实施) | W1 规则稳定 |
| **W3** | 全量推广到所有新项目;case 库累积 5 个验证样本 | W2 通过 |

### 8.2 风险

| 风险 | 概率 | 缓解 |
|-----|-----|-----|
| 5 partial 拆分后 AI 不知道往哪个 TODO 填 | 中 | prompt 明确 TODO 定向 + AI 填错靠 `field-in-wrong-partial` 阻止 |
| XML doc 自动生成文本泛化,AI 加工时去掉 | 低 | 静态规则检查 `<summary>` 存在即可,不审文本质量 |
| method-too-long 把合法的 CheckEventRules 误报 | 高 | exempt 白名单(见 §6) |
| 规则过严 blocking,urbib0 回归不过 | 中 | 先全 warning 跑一轮,看违规分布再决定 severity |
| 用户否决方案 B,选 A/C | 中 | UI 改造工作量独立,不影响 W1 |

### 8.3 用户已决事项

- ✅ **D1**: UI 方案 A,直接改 1920×1080(§4.3)
- ✅ **D3**: Scene 保持独立,不合并进 Resource。Scene 管 transform/visibility/预烘焙绑定,Resource 管库存/消耗/采集逻辑
- ✅ **D2(重定义)**: phase 分派设计 — W1 方案 1(switch+per-phase method),W2-W3 升级到方案 2(JSON+Interpreter),方案 3 不采用(§4.4)。9 候选模式深度调研经 Luna 约束过滤结论详见 §4.4
- ✅ **D2-rules**: 静态规则挡位选项 B(分档上线,§6) — 3 条结构性规则 day 1 blocking,3 条质量性规则先 warning,按实测分布逐步转 blocking

---

## 9. 非目标

- 不动 canonical 库(`GFM_EconomyManager` 等)结构
- 不改 spec 提取 / CUA / 视觉审核
- 不引入 DI 容器(partial class 已足够)
- 不重写已归档项目(只影响今日之后新生成)
- 不做单元测试框架(Luna 运行时无 NUnit)

---

## 10. 关联 memory

- `project_manager_architecture_20260419.md`(7 Manager canonical)
- `project_complexity_control_20260416.md`(复杂度三层防御)
- `feedback_skeleton_protection.md`(关键常量三层防护)
- `feedback_canonical_lib_static_exclude.md`(静态规则加新规则时要排除 canonical 库)
- `project_space_junk_first_pass_20260417.md`(urbib0 首次通过基线)
