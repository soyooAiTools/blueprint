# 当前 Unity 代码生成 Prompts 整理

更新时间：2026-06-20
主仓版本：2026-06-20 Unity codegen prompt hydration / programmer-delivery maintainability 优化

本文整理当前 Blueprint Unity 代码生成相关 prompt。这里说的 “Unity 代码生成” 包含两层：

1. **Luna/WebGL staging 生成层**：为了 storyboard2html -> WebGL 稳定，仍允许使用骨架绑定、`GameSceneCtrl` 和受控对象池 literal。
2. **程序员 Unity 交付层**：最终交付给人类程序员的 Unity 工程，必须走 Core / Tool / Game 三层、AIBridge/MCP 场景 hydration、Inspector/scene 引用、`GMP_SceneEntityRefs`/serialized refs 和稀疏中文注释。

最高红线：storyboard2html 生成的 HTML 与最终 WebGL 的一致性是系统终极红线，千万不能碰。不要为了清理程序员交付代码，通过 WebGL 侧临时兜底、HTML 侧假状态或报告文字绕过 `source HTML -> SourceSceneIR/SourceIR -> playable-scene-ir -> WebGL` 的 phase、guideText、targetSequence、entity/resource/gate 语义一致性。

## Prompt 源文件总览

| 文件 | 入口/用途 | 当前作用 |
|---|---|---|
| `engine/stages/build-schema-prompt-v3.cjs` | `buildSchemaPromptV3(ctx)` | Source HTML / HTML slices -> schema prompt，带 Unity 程序架构契约 |
| `worker/prompt-v5-basetemplate.js` | `parseBlueprintToPromptV5(blueprint, opts)` | 当前主力 V5 Luna base-template 代码生成 prompt |
| `worker/prompt-v4.js` | `parseBlueprintToPromptV4(blueprint, opts)` | V4 legacy 兼容 prompt，仍可用于旧事件驱动路径 |
| `worker/luna-codex-code.md` | Codex markdown 指令 | Codex code runner 在 Luna partial 骨架里补逻辑时使用 |
| `worker/worker-coder.js` | `GENERATE_PROMPT` / `FIX_PROMPT` / V4/V5 system prompt | legacy worker/Claude 路径和 V5 system prompt |
| `worker/codex-code-coder.js` | incremental fix user prompt / append system prompt | Codex code runner 的增量修复约束 |
| `worker/behavior-templates.md` | 行为模板参考 | Luna staging 行为模板，明确不作为最终程序员交付结构 |
| `test/unity-codegen-prompt-contract.test.cjs` | 回归测试 | 防止 prompt 退回旧的 Find-heavy / GFM_Create-heavy / 注释-heavy 口径 |

## 统一架构契约

所有当前 Unity codegen prompt 都应携带这组规则：

- 最终 `Assets/Scripts` 只允许 `Core` / `Tool` / `Game` 三个顶层目录。
- `Core/Base` 放 `MonoSingleton`、核心 enum、实体/角色/NPC 基类。
- `Core/Components` 放 Movement、Trigger、Interaction、Inventory、Skill 等可复用能力。
- `Core/Modules` 放 MainManager、Pool、Audio、Level/Phase、Event、Drop/Item、UI、Economy、Npc 等核心模块。
- 核心管理层只能有一个主管理器，负责集中初始化模块后启动关卡。
- 状态和步骤类型必须用 enum，不用 0/1/2 魔法数字或裸字符串表达跨层状态。
- Player/NPC/Entity 走“基类 + 可选组件”组合，不把一次性业务字段散落在核心类型里。
- Movement、Trigger、Interaction、Inventory 这类没有 Unity 生命周期的能力默认是普通 C# 类，不因为名字叫 Component 就挂到同一个场景节点上。
- Tool 层沉淀跨项目稳定工具，不硬编码项目实体、资源和 phase 文案。
- 音频必须集中式多音源管理，业务只调用 Audio module API。
- 新增业务优先写进 `Game/Level`、`Game/Entities`、`Game/Player`。
- 有 Unity Editor + AIBridge/MCP 时，程序员交付必须用真实场景信息做 Inspector/scene hydration。
- 程序员交付业务代码禁止靠 runtime `GameObject.Find`、`FindObjectOfType`、`.AddComponent(...)`、`new GameObject(...)` 补场景。
- 管理器、HUD、相机、音频和实体引用优先用 `[SerializeField]` / Inspector 赋值。
- `GetComponent` 只用于当前对象或子对象的局部组件访问，不作为依赖注入方案。
- `GMP_SceneEntityRefs`/serialized refs 是程序员交付的人类可见实体引用入口，禁止回退到通用 object binding 表、`mEntityNames`、`mDefaultPositions`、`mDefaultScales` 这类隐藏并行数组，也不要保留 `GameSceneCtrl` / `SceneObjectRegistry` 这类隐藏运行时对象表作为第二入口。
- 属性归属贴近能力组件：`MoveSpeed` 归 MovementComponent/移动能力，交互半径归 Trigger/Interaction，背包容量归 Inventory；Player/Manager 只编排，不复制每个实体的调参字段。
- 生命周期入口必须唯一：`Init/Configure/Setup` 未被调用就删除；依赖 `Awake/Start` 时不保留并行 `Init`；禁止静态 `Init/Get/Return` 工作流。
- 脚本尽量在场景开始前就挂好；一次性功能不要拆成一堆空壳类、空函数或只包一行代码的 helper。
- 逻辑与表现分离：根节点挂逻辑和碰撞/交互，骨骼、动画、mesh、特效等美术资源放子节点。
- 注释只写关键且不容易看懂的地方，用中文大白话说明原因或坑点。
- 复杂脚本参数说明要清楚：多参数 helper、系统级入口、跨 phase 状态函数要在声明、调用处或函数前说明参数用途、单位、边界和副作用。
- 有意义的空行分块：用空行分隔字段、初始化、输入处理、状态推进、UI 更新、验证/兜底等不同代码块；同一连续逻辑内部不滥用空行，也不要把不同职责挤成一段。
- 距离门槛判断使用 `(a.position - b.position).sqrMagnitude < range * range`，不要把 `Vector3.Distance` 当正向示例。
- 兜底代码只在真实可进入、能解释风险的位置保留；不要为理论上进不去的分支堆十几行查找、创建或修复逻辑。
- Player、HUD、Camera 和关键实体必须走固定引用、serialized refs、`GMP_SceneEntityRefs` 或固定 addressable path；缺引用只允许短路 `Debug.LogError`，不能写 runtime 扫描、创建、修组件 fallback。
- Phase/流程节点是连续试玩流程和代码/数据组织入口，不是独立关卡；进入 phase 不能清空资源、重建 Player、重置全场或制造重新开始一局的体验。
- AIBridge 预水合后要删除 primitive builder、source spec helper、临时生成脚本、通用 object binding 表和运行时场景生成/修复代码；确实跨项目复用的能力下沉为正式 Tool。
- `GMP_SceneEntityRefs` 显式字段保留为 Inspector 中的人类可见数据入口；删除的是运行时生成/查找/修复绑定的代码、通用 object binding 表和隐藏 runtime registry。导出必须先写 `SCENE_BAKE_PLAN.json`，再由 AIBridge/Editor bake 写 `SCENE_BAKE_REPORT.json`，最终用 `PROGRAMMER_TEMP_CODE_AUDIT.json` 证明临时 primitive spec、primitive builder/source spec helper、通用绑定表没有留在交付包。

## DOCX 反馈汇总后的 Prompt 规则

来源：`/nickTemp/代码规范与优化建议.docx`。整理后不逐条照搬截图，而是合并成这组生成约束：

1. **场景和引用先交给 MCP/Editor**：Missing Mono Script、Rigidbody/Collider/Animator 等场景遗留或组件配置，由 AIBridge/MCP/Editor 修场景；业务代码不要再写一遍 Find/AddComponent/修复逻辑。
2. **节点挂载要克制**：一节点一主脚本；只有需要 Unity 生命周期、Inspector 暴露或场景挂载的对象才继承 `MonoBehaviour`。Movement/Trigger/Interaction/Inventory 这类无生命周期能力默认用普通 C# 类。
3. **代码要能交给人类程序员接手**：变量名说清业务含义；只保留会被调用的方法；只有一个调用点且只包一两行的 helper 直接内联；不要为了“看起来分层”拆一堆函数、变量和空壳类。
4. **单例和管理器少用静态工作流**：管理器从场景预挂实例启动，通过 serialized refs 拿依赖；单例类里不要再塞静态 `Init/Get/Return` 这类工作流方法。
5. **兜底必须有现实入口**：必要兜底才写。理论上进不去的分支不要堆十几行查找、创建、修复代码；这会让交付代码膨胀且更难维护。
6. **Unity 性能习惯写进正向示例**：距离门槛判断使用 `sqrMagnitude`，不要把 `Vector3.Distance(...) < range` 写成推荐样例。
7. **注释服务理解，不服务篇幅**：只在关键、难懂、容易踩坑的位置写中文大白话注释；字段名、普通生命周期方法、自解释 helper 不补机械注释。
8. **复杂脚本先解释参数和关键功能**：面对多参数 helper、系统级入口、跨 phase 状态函数，在声明或调用附近标明参数用途、单位、边界和副作用；复杂分支说明为什么存在，而不是只复述代码做了什么。
9. **空行用于分块，不用于装饰**：字段、初始化、输入处理、状态推进、UI 更新、验证/兜底之间用空行隔开；同一连续动作内部不乱插空行，不同职责也不要挤成一段。

## 2026-06-20 新反馈补充后的 Prompt 规则

来源：`/nickTemp/newadvice.docx`。这轮反馈不是新增特殊项目逻辑，而是把程序员可维护性收紧成跨项目规则：

1. **属性必须归属到能力组件**：`MoveSpeed` 归 MovementComponent/移动能力，交互半径归 Trigger/Interaction，背包容量归 Inventory。Player/Manager 只编排流程和依赖，不复制每个实体的调参字段。
2. **入口函数不能双轨**：`Init/Configure/Setup` 未被调用就删除；如果逻辑依赖 `Awake/Start`，不要再保留一条并行 `Init` 路径。
3. **兜底不能增加复杂度**：Player、HUD、Camera、关键实体使用固定引用、serialized refs、`GMP_SceneEntityRefs` 或固定 addressable path；缺引用只允许短路 `Debug.LogError`，不写 runtime 扫描、创建、修组件 fallback。
4. **phase 不是关卡重启**：Phase/流程节点是连续试玩流程和代码/数据组织入口，不是独立 level；进入 phase 不能清空资源、重建 Player、重置全场或制造重新开始一局的体验。
5. **AIBridge 先水合，临时脚本后清理**：primitive builder、source spec helper、临时生成脚本、通用 object binding 表只允许作为 Editor 侧过渡；最终交付要删除，或把确实可复用的能力下沉为正式 Tool。
6. **HTML/WebGL 一致性仍是最高红线**：任何 Unity/程序员交付清理都不能反向改变 SourceSceneIR/source HTML/WebGL 事实源；发现差异先修上游 source contract 或确定性投影规则。
7. **显式引用是数据入口，不是运行时补救入口**：`GMP_SceneEntityRefs` 应由 AIBridge/Inspector 预填，供程序员查看和扩展；业务代码不能通过 runtime `Find/AddComponent/new GameObject` 补绑定。
8. **不要保留隐藏运行时对象表**：程序员交付版不要把旧通用绑定表、`GameSceneCtrl`、`SceneObjectRegistry`、`mNames/mObjects` 这类 registry 当第二入口；自动播放、业务规则和维护文档都应直接指向 `GMP_SceneEntityRefs` 或 serialized refs。

## 两层 Prompt 口径

### Luna/WebGL Staging 层

这层服务自动构建和 CUA/WebGL 稳定性，当前仍依赖模板场景里的预制对象池和骨架绑定。

允许：

- 使用骨架已有字段。
- 使用 `RegisterEntityBindings()` 注册实体。
- 使用 `GameSceneCtrl.instance.Get("entityName")` 获取已注册对象。
- 在 staging 绑定表里保留 `__Pool_{Shape}_{Color}_{NN}` literal。
- 用 `transform.position = new Vector3(x,y,z)` 显示对象。
- 用 `transform.position = new Vector3(0,-999,0)` 隐藏对象。
- 使用数组满足 Luna 限制，但必须标明这是 staging，不是程序员交付结构。

不鼓励：

- 在业务 TODO 区重复写 `GameObject.Find("__Pool_*")`。
- 自己拼接 pool 名。
- 使用 `GFM_Create.Obj()` / `CreatePrimitive()` 生成可见对象。
- 使用 `SetActive()` 隐藏/显示对象。
- 把 phase-specific 逻辑塞回 `GameFlowManagerMain.cs` 主文件。

### 程序员交付层

这层是最终给人类程序员维护的 Unity 工程。

必须：

- 通过 AIBridge/MCP 读取真实场景信息并做 hydration。
- 把对象引用写进 Inspector/scene YAML。
- Manager、HUD、Camera、Audio、Entity 依赖用 `[SerializeField]`、`GMP_SceneEntityRefs` 或同类 serialized refs 表达。
- 根节点负责逻辑，表现资源挂子节点。
- 保留少量清晰脚本和清楚职责边界。
- 注释少而关键，中文大白话。
- 清理场景里的 Missing Mono Script；最终场景不应该带丢脚本的组件引用。
- 单例/管理器从场景预挂实例初始化，避免在单例类里继续塞静态 `Init/Get/Return` 工作流方法。

禁止：

- 业务脚本 runtime `GameObject.Find` / `FindObjectOfType`。
- 业务脚本 runtime `.AddComponent(...)` / `new GameObject(...)` 补结构。
- 为每个单独场景物体生成空壳实体类。
- 用隐藏并行数组作为主要可维护结构。
- 机械要求每个字段、每个方法都有详细注释。
- 把没有生命周期的能力类拆成一堆 MonoBehaviour 再全部挂到 Player 一个节点上。

## V5 Base Template Prompt

源文件：`worker/prompt-v5-basetemplate.js`

这是当前主力路径。它的 prompt 主要包括：

1. 任务说明：在 `GameFlowManagerMain` partial 系列文件里实现 Luna playable。
2. 程序架构硬规则：Core / Tool / Game、AIBridge/MCP hydration、`GMP_SceneEntityRefs`/serialized refs、逻辑/表现分离、稀疏中文注释。
3. 代码结构要求：主文件保持轻量，职责放到对应 partial。
4. 基础样例工程模式：场景已有预制对象，不创建对象。
5. 对象引用规则：优先使用骨架绑定字段 / `GameSceneCtrl.instance.Get("entityName")`。
6. 对象分配表：蓝图实体 -> `__Pool_*` 场景对象，用于 staging 绑定。
7. 未分配池对象：只允许 staging 绑定重分配，不允许复制对象补池。
8. Luna 限制：不用 `SetActive`、不用 `CreatePrimitive`、不用 LINQ/协程/泛型集合等。
9. 双模式架构：交互模式 + AutoPlay 模式。
10. Phase gate：必须由真实实体位移或交互结果推进，不能靠 timer。
11. 正确代码模式参考：示例已改成 `GameSceneCtrl.instance.Get(...)`，照抄结构，不照抄 Player/Target 等占位实体名。

关键当前规则：

```text
当前代码是 Luna/WebGL staging 层：对象池映射只用于稳定构建。
程序员交付版会通过 AIBridge/MCP 把引用写进 Inspector/scene，业务代码不能依赖运行时查找。
```

```text
优先使用骨架中已经绑定好的实体字段 / GameSceneCtrl.instance.Get("entityName")；
如果代码里有 RegisterEntityBindings()，不要再写 GameObject.Find("__Pool_*")。
```

```text
说明注释只写在关键且不容易看懂的位置。
不要给字段名和普通 lifecycle 方法堆机械注释。
```

## V4 Legacy Prompt

源文件：`worker/prompt-v4.js`

V4 是旧事件驱动路径，当前仍保留兼容。它已经补上新版程序员交付规则，但明确标记旧写法只属于 Luna/WebGL staging。

当前重点：

- V4 legacy 兼容层可以在 Start 的 staging 绑定代码里解析对象池。
- 如果已有绑定表或 `GameSceneCtrl`，优先使用绑定表，不在业务逻辑里重复 Find。
- V4 staging 可用 `eGo[]`、`eActive[]`、`eState[]`、`eTimer[]`、`eHP[]`。
- 程序员交付版必须收口到 `GMP_SceneEntityRefs` 或同类显式 serialized refs。
- 注释只写关键、难懂、容易踩坑的地方。

关键当前规则：

```text
V4 legacy 代码只作为 Luna/WebGL staging 兼容层；
旧数组/对象池写法不得泄漏成程序员交付版的业务结构。
```

## Schema Prompt V3

源文件：`engine/stages/build-schema-prompt-v3.cjs`

这个 prompt 不直接让模型写 C#，而是让模型根据 source HTML / HTML phase slices / specs / entities 输出 JSON schema。它也携带同一套 Unity 程序架构契约，保证下游生成 GameSchema/Unity 时不会忘记最终交付规则。

包含内容：

- HTML -> Unity GFM 翻译速查。
- 程序架构契约。
- Assembly Plan。
- HTML 参考切片。
- 分镜 specs。
- 实体列表。
- JSON-only 输出要求。

当前作用：把 Core / Tool / Game、AIBridge/MCP hydration、`GMP_SceneEntityRefs`/serialized refs、逻辑/表现分离、稀疏中文注释这些规则提前注入 schema 阶段。

## Codex Code Runner Prompt

源文件：

- `worker/luna-codex-code.md`
- `worker/codex-code-coder.js`

`luna-codex-code.md` 是 Codex code runner 看到的 markdown 指令，主要用于在 Luna partial 骨架里补逻辑。

当前重点：

- 当前 partial 骨架是 Luna/WebGL staging 层。
- 优先使用骨架已绑定字段 / `GameSceneCtrl.instance.Get("name")`。
- 不在业务 TODO 区重复写 `GameObject.Find("__Pool_*")`。
- GameSceneCtrl 可用 `.Get()` / `.Show()` / `.Hide()` / `.IsNear()`。
- 不改骨架 phase id / CUA hook / `UpdateGameState()`。
- 引导文案统一走 `SetGuideText("...")`，不直接写 `guideText.text = ...`。

`codex-code-coder.js` 的增量修复 prompt 重点是：

- 用 Edit，不用整文件重写。
- 只改 whitelist 里的 partial 文件。
- 先读所有 `GameFlowManagerMain*.cs` partial。
- 不直接加 `GameObject.Find("__Pool_*")`。
- 使用已有绑定字段、`GFM_ResourceIds` 和 `SetGuideText`。
- 后处理不再把 `FindObjectOfType<T>()` 自动改写成另一种查场景写法；这类代码应被 prompt/static-check 拦住。

## Worker Coder System Prompts

源文件：`worker/worker-coder.js`

这里有 legacy worker / Claude 路径和 V5 system prompt。当前已经从 “Find + Move” 改成 “绑定引用 + Move”。

当前 V5 approach：

```text
1. Use existing bound fields / RegisterEntityBindings() / GameSceneCtrl.instance.Get("Name") to get object references
2. transform.position = new Vector3(x,y,z) to show objects
3. transform.position = new Vector3(0,-999,0) to hide objects
4. Colors are pre-baked into pool names (__Pool_Cube_Red_01) — no SetColor() needed
5. Write game logic (interactions, collisions, flow control)
```

同时保留 legacy path 说明：

- legacy 生成路径可能仍先输出 `GameFlowManagerMain.cs` staging 文件。
- 最终程序员交付由 cleaner 拆成 Core / Tool / Game。
- V5 使用 pre-bound pool objects。
- 程序员交付用 AIBridge/MCP Inspector hydration。

## Behavior Templates

源文件：`worker/behavior-templates.md`

当前已在文件顶部明确：

```text
本文件只给 Luna/WebGL staging 代码参考。
程序员 Unity 交付版必须由 AIBridge/MCP 做 Inspector/scene hydration。
引用进入 GMP_SceneEntityRefs 或 [SerializeField] 字段。
不要把这里的平行数组、运行时 Find 或一次性模板拆法照搬成最终交付结构。
```

这份模板仍有 staging 示例，比如：

- `eGo[]` / `eActive[]` / `eState[]` 等数组。
- `UpdateBuildable`、`UpdateShooter`、`UpdateEnemy` 模板。
- 玩家操作触发 phase/rule。

但它现在明确要求：

- 获取对象优先用骨架绑定字段或 `GameSceneCtrl.instance.Get("entityName")`。
- 只有 staging 绑定表可以出现 `__Pool_*` literal。
- 程序员交付版额外禁止业务代码里的 `GameObject.Find`、`FindObjectOfType`、`.AddComponent(...)`、`new GameObject(...)`。

## 当前 Prompt 的主要变化点

相比旧版，当前 prompt 已经改掉这些倾向：

- 不再把 `GameObject.Find("__Pool_*")` 当业务代码默认写法。
- 不再要求“每个字段声明都必须有详细中文注释”。
- 不再要求“每个方法都必须有详细中文注释”。
- 不再把 V4 平行数组结构当最终程序员交付结构。
- 不再说“scene file 不会被修改，所有引用必须在代码里解析”。
- 不再用 `Find` 计数判断 V5 输出是否正常；binding refs 是正向信号，`Find` / `GFM_Create.Obj` 都记为 should be 0。
- 不再在修复 prompt 里建议“缺可见对象就用 `GFM_Create.Obj()` 补”。
- 不再把 `FindObjectOfType<T>()` 自动后处理成 `(T)FindObjectOfType(typeof(T))`。
- 不再把备用池描述成可以用 `Instantiate` 扩容；未分配池只给 staging 绑定重分配使用。
- static-check 的 blocking message 不再提示模型 “use GameObject.Find() from pool”。
- 不再把 `Vector3.Distance(...) < range` 写成距离门槛正向示例。
- 不再把 Player 的移动/背包/交互等无生命周期能力生成成一堆 scene-mounted MonoBehaviour。
- 不再为了分层生成只调用一次、只包一两行的 helper、空壳类、不会被调用的方法。
- 不再把单例/管理器写成场景实例之外的一组静态 `Init/Get/Return` 工作流方法。
- 不再为理论上进不去的分支堆大量查找、创建、修复式兜底代码。
- 不再为没有音频调用的项目强制生成 `PlayLoop` / `PlayOneShot` 等播放 API；音频播放接口只在项目真的调用音频时出现。
- 不再为同一个玩法状态生成多个 owner；简单 Player 只保留一个 `MoveSpeed`，Movement helper 不保存默认速度，HUD 目标提示只由 HudController 写。

当前仍保留的稳定性保护：

- Luna staging 仍保留受控对象池 literal，避免破坏 WebGL 稳定链路。
- source HTML / storyboard2html / guideText parity 仍是事实源红线。
- cleaner / hardgate / maintainability gate 继续负责最终交付收口，其中 strict maintainability 已经阻断未调用方法、重复状态 owner、`Vector3.Distance` 门槛和静态 `Init/Get/Return` 工作流；hardgate 会校验 summary 中“已删除脚本”与真实文件一致。

## 回归测试

新增测试：

```text
test/unity-codegen-prompt-contract.test.cjs
```

它检查：

- schema prompt、V5、V4、Codex markdown、worker prompt 都包含 AIBridge/MCP。
- prompt 中保留 Inspector hydration、`GMP_SceneEntityRefs`/serialized refs、逻辑/表现分离、稀疏中文注释规则。
- prompt 中保留 DOCX 反馈汇总后的可交付规则：一节点一主脚本、无生命周期能力用普通 C# 类、只保留会被调用的方法、必要兜底才写。
- V5 prompt 展示 binding-based object access。
- V4 prompt 明确 `__Pool_*` 只属于 staging 绑定层。
- behavior templates 标记为 staging-only。
- 不恢复旧的字段/方法机械注释要求。
- 不把 `GameObject.Find("名称")` 作为 Codex 默认对象获取方式。
- 不恢复 `GFM_Create.Obj()` 正向创建/修复示例。
- 不恢复 `Instantiate` 备用池扩容文案。
- 不恢复“没有 GFM_Create 就警告”的旧校验。
- 不恢复 `FindObjectOfType` 后处理成另一种 scene scan 的逻辑。
- 不恢复 static-check 里让模型改用 `GameObject.Find()` 的反馈。
- 不恢复 `Vector3.Distance(...) < range` 的正向距离门槛示例。

## 生成完整版 Prompt 的方法

V5 prompt 示例：

```bash
cd /opt/blueprint-editor
node - <<'NODE'
const promptV5 = require('./worker/prompt-v5-basetemplate.js');
const blueprint = {
  projectName: 'PromptPreview',
  entities: [
    { name: 'Player', template: 'PlayerController', visual: { position: '(0,0,0)' } },
    { name: 'Crate', template: 'Static', visual: { position: '(1,0,0)' } }
  ],
  specs: [
    {
      phaseId: 'collectCrate',
      phaseName: '收集箱子',
      playerInstruction: '拖动角色靠近箱子',
      requiredInteractions: ['move_to:Crate'],
      entitiesRequired: [{ entity: 'Crate' }]
    }
  ]
};
console.log(promptV5.parseBlueprintToPromptV5(blueprint));
NODE
```

V4 prompt 示例：

```bash
cd /opt/blueprint-editor
node - <<'NODE'
const promptV4 = require('./worker/prompt-v4.js');
const blueprint = {
  entities: [
    { name: 'Player', template: 'PlayerController', visual: { position: '(0,0,0)' } },
    { name: 'Crate', template: 'Static', visual: { position: '(1,0,0)' } }
  ],
  specs: [
    {
      phaseId: 'collectCrate',
      phaseName: '收集箱子',
      playerInstruction: '拖动角色靠近箱子',
      requiredInteractions: ['move_to:Crate'],
      entitiesRequired: [{ entity: 'Crate' }]
    }
  ]
};
console.log(promptV4.parseBlueprintToPromptV4(blueprint));
NODE
```

Schema prompt 示例：

```bash
cd /opt/blueprint-editor
node - <<'NODE'
const p = require('./engine/stages/build-schema-prompt-v3.cjs');
console.log(p.buildSchemaPromptV3({
  blueprint: {
    specs: [{ phaseId: 'phase1', requiredInteractions: ['move_to:Crate'] }],
    entities: [{ name: 'Crate', template: 'Static' }],
    htmlPhaseSlices: { phase1: 'function phase1(){ setTip("拖动角色靠近箱子"); }' }
  }
}));
NODE
```

## 人类程序员接手时看什么

程序员不需要读完整 Luna staging prompt。交付包应主要看：

- `Assets/Scripts/Core`
- `Assets/Scripts/Tool`
- `Assets/Scripts/Game`
- `PROGRAMMER_HANDOFF.md`
- `CODE_RELATION_GRAPH.md`
- `SCENE_BAKE_PLAN.json`
- `SCENE_BAKE_REPORT.json`
- `MCP_HYDRATION_REPORT.json`
- `PROGRAMMER_TEMP_CODE_AUDIT.json`
- `PROGRAMMER_MAINTAINABILITY_REPORT.json`
- `DELIVERY_VALIDATION.json`

如果程序员发现交付工程里还大量出现业务层 `GameObject.Find`、runtime `.AddComponent(...)`、Missing Mono Script、空壳实体类、并行数组主导业务状态，或 Player 一个节点挂了一排无生命周期脚本，说明 prompt / cleaner / hydration gate 至少有一个环节回归。
