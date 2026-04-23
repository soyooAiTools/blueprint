# Assembly-First 实体模块化流水线改造 Spec

**Date**: 2026-04-23  
**Status**: Draft — 待讨论确认  
**Author**: Codex  
**Branch**: `spec/entity-assembly-pipeline`

---

## 摘要

当前 Blueprint 主链已经有 V4 `entities/phases`、schema-driven codegen、模板引擎、split-partial skeleton、method-check/review deterministic repair，但生产 happy path 仍然是：

`storyboard -> specs -> schema -> template fill -> custom logic codegen -> method-check -> review -> compile`

这条链路的问题，不再主要是“AI 会不会写出 C#”，而是：

1. 真实业务语义仍然被拆成多个不一致的中间表示：`storyboardFrames`、`specs`、`V4 entities/phases`、`gameSchema`、生成后的 partial C#。
2. “组合”需求已经出现，但仍被塞在 `template` 字符串和生成代码里，没有成为显式、可验证的装配图。
3. 大部分稳定性工作仍发生在 `method-check / review` 之后，属于后置修锅，而不是前置约束。

本 spec 提议把主方向从“AI 写代码”切到“AI 只做规划，运行时由 deterministic assembler 落盘”：

`storyboard -> StoryboardAtomPlan -> EntityPlan -> AssemblyPlan -> deterministic emitter -> CUAPlan -> verify`

其中：

- `StoryboardAtomPlan` 定义“分镜里的交互、状态变化、镜头/表现动作由哪些原子积木组成”
- `EntityPlan` 定义“实体由哪些能力模块组装而成”
- `AssemblyPlan` 定义“这些实体/模块如何在 phase、事件、文件、状态层面装配”
- `CUAPlan` 定义“CUA 应如何基于模块合同执行操作、观察反馈、判断完成”
- `fallback codegen` 只允许处理显式 `unresolved` 的局部缺口，不能再重写整份主代码

**核心判断**:

- 方向正确，且比继续扩大自由 codegen 更有长期价值。
- 现在不适合“一刀切删除 codegen”，因为当前模板覆盖、module registry、验证规则还不足以支撑纯装配主链。
- 正确路径是 `assembly-first, codegen-fallback`，先把开放式 codegen 从 happy path 降级为兜底能力。

---

## 1. 背景与现状

### 1.1 当前提交与生成主链

仓库当前生产链路仍然明确以 `spec-extract` 和 `codegen` 为主轴：

- `engine/pipeline.cjs:459`  
  `clone -> spec-extract -> spec-validate -> complexity-gate -> codegen -> method-check -> review -> compile -> visual-check -> cua-verify -> upload`
- `engine/project-service.cjs:85`  
  项目提交时，只要存在 `storyboardFrames`，就优先进入 `spec_extracting`，异步提 specs，再转 `submitted`

也就是说，虽然系统已经具备 V4 `entities/phases` 能力，真正的提交入口仍然把“分镜 -> 体验 specs”当作 canonical production input。

### 1.2 当前 V4 能力并未成为主输入

以下能力已经存在，但尚未升格为主路径：

- `api/storyboard.cjs:827`  
  `parse-and-blueprint` 已经会把解析结果直接保存为 `project.entities / project.phases / project.globalSettings / version=4`
- `worker/worker-coder.js:1114`  
  worker 已明确把 blueprint 视为 “V4 entity-driven blueprint”
- `docs/entity-architecture-proposal.md`  
  已提出“从按镜头状态机转为实体驱动 + 事件触发链”
- `docs/v4-schema.json:17`  
  已定义 `template: Static | Buildable | Shooter | Mover | ...`

但目前这些 V4 数据主要还是“旁路资产”，没有替代 `specs` 成为主提交工件。

### 1.3 当前 schema-driven codegen 的真实形态

当前 codegen 已经不是纯文本生成，但也还不是纯装配：

- `engine/stages/codegen-schema.cjs:1`
  - Step 1: LLM 生成 JSON schema
  - Step 2: template engine fill skeleton
  - Step 3: custom logic text runner 补剩余逻辑
- `adapters/codegen-template-engine.cjs:41`
  - 通过 `TODO_*` marker 把 schema 映射到 skeleton
  - 但 `TODO_CUSTOM` 仍会落入 interaction templates + `customLogic[]`

这代表当前链路本质上是：

- 先用结构化 schema 降低复杂度
- 再用模板产出 50%-90% 代码
- 再靠局部/全局生成补尾巴

它已经“向装配走了一半”，但尚未把装配图显式化。

---

## 2. 真实问题诊断

### 2.1 近期 metrics 说明，问题不在 codegen stage 本身

基于 `node engine/metrics.cjs 120` 和最近 120 条 `server-data/metrics/pipeline-metrics.jsonl`：

| 指标 | 结果 | 解释 |
|---|---:|---|
| 总样本 | 120 | 最近一批真实流水线运行 |
| 成功率 | 0% (0/120) | 当前链路未形成稳定收口 |
| codegen stage pass rate | 100% (119/119) | 生成阶段本身并不是主要挂点 |
| method-check hotspot | 76 次 (63%) | 主要死在 contract / structure drift |
| review hotspot | 42 次 (35%) | 后置 fix-loop 仍不收敛 |
| customLogicUsed | 103/120 = 85.8% | 大多数任务仍依赖自由逻辑补全 |
| avgTemplateCoverage | 0.576 | 模板覆盖平均只有中等水平 |
| 高 coverage 样本 (`>=0.85`) | 6 个，全部失败 | 覆盖率高也不等于结构稳定 |

高 coverage 样本的典型失败原因：

- `duplicate-state-fields`
- `player-alias-drift`
- `forbidden-generic-api`
- review fix-loop 不收敛

**结论**: 当前主问题不是“模板填得不够多”，而是“状态所有权、实体别名、跨文件约束、交互 contract 没被前置成强约束”。

### 2.2 事故文档说明，现有系统在用后置修复弥补装配问题

从 `docs/INCIDENTS.md` 和 `docs/_archived/2026-04-23-rerun-phase-gate-hardening.md` 看，近期高频问题包括：

- `phase-entity-init-only`
- `phase-entity-unbound`
- split-partial 下跨文件 phase gate 漏修
- 低 coverage 样本静默跳过 custom logic

这些问题的共同特征是：

1. **实体/phase 的运行时责任没有在生成前固定下来**
2. **跨 partial 的依赖关系没有显式建模**
3. **repair 是围绕 C# 结构补洞，而不是围绕业务装配图做验证**

这也是本改造要解决的核心。

### 2.3 当前 V4 schema 已经暴露出“组合需求 > schema 表达能力”

目前的 V4 schema 只有单一 `template` 字段：

- `docs/v4-schema.json:17`

但样例蓝图中已经出现：

- `template: "Mover+Damageable"`
- `template: "Buildable+Shooter"`

见：

- `docs/qmjs-v4-blueprint.json`
- `docs/entity-architecture-proposal.md`

这说明系统已经在表达“组合实体”，只是做法仍然是把组合语义编码进字符串里。这种方式的问题是：

- schema 无法校验模块边界
- emitter 无法知道状态属于谁
- review 只能在代码层事后猜测组合结构

---

## 3. 目标与非目标

### 3.1 目标

1. 把 `V4 entities/phases` 升级为可执行的装配输入，而不是辅助描述。
2. 把“实体搭积木”做成一等公民：实体由能力模块显式组合，不再依赖复合 template 字符串。
3. 引入严格中间表示 `AssemblyPlan`，在落代码前完成：
   - 状态所有权校验
   - 事件图校验
   - phase 绑定校验
   - 文件写入 ownership 校验
4. 把主 happy path 从“自由 codegen”切到“deterministic assembly emitter”。
5. 让 `method-check / review` 从“修结构”转为“查漏和少量 fallback 风险”。
6. 把分镜里的“移动 / 收集 / 变色 / 攻击 / 镜头拉高 / 高亮 / 飘字”等重复语义，统一抽成可复用原子模块。
7. 让 CUA 从“读代码猜玩法”切到“读模块合同执行与断言”。

### 3.2 非目标

1. 本期不重写 Luna 运行时基础库。
2. 本期不一次性消灭所有 LLM 使用；只把其角色降级为 planner / fallback。
3. 本期不要求所有玩法都能纯模块化覆盖；允许有限 `unresolved`。
4. 本期不在第一版就替换 CUA / visual-check。

---

## 4. 核心设计判断

### 4.1 实体不再是业务对象，而是模块容器

目标形态不是：

- `ConveyorBelt` 是一个 `Buildable`
- `Crossbow` 是一个 `Shooter`

而是：

- `ConveyorBelt = Visual + SpawnRule + ProximityTrigger + CostGate + BuildProgress + OnBuiltActivate`
- `Crossbow = Visual + ClickTrigger + TargetAcquire + ProjectileEmitter + Cooldown`
- `Enemy = Visual + RuntimeSpawned + MoveToTarget + Damageable + OnDeathDrop`

这意味着：

- `template` 只能作为 archetype shortcut，不能再是唯一语义来源
- 真正可执行的是 `modules[]`

### 4.2 Phase 只保留激活与转场职责

目前 phase/spec 同时混着：

- 引导文案
- 玩家必须做什么
- 哪些实体出现/隐藏
- 触发条件
- 运行时交互处理逻辑

目标态里 phase 应只保留：

1. 当前激活哪些实体或 capability
2. 当前 guide / camera / autoplay policy
3. 何时转到下一阶段

实体行为本身由模块组合驱动，而不是每个 phase 单独发明一套 handler。

### 4.3 “第二轮解析”必须输出严格 IR，而不是自然语言建议

如果在分镜解析后只多加一轮“把语言翻译成模块顺序的文字描述”，本质仍然是把 codegen 前移，并没有消除自由发挥。

因此第二轮解析必须输出严格 JSON IR：

- 能被 schema 校验
- 能做 deterministic validation
- 能明确列出 `unresolved`
- 能直接喂给 assembler

### 4.4 分镜描述本身也要模块化

这次改造不能只把“实体行为”做成积木，分镜描述里的高频语义也要被剥离成标准原子，否则 parser 仍然会把同一种动作反复写成不同自然语言，后续 planner 依旧要猜。

建议把分镜语义拆成 3 类原子：

1. **交互原子**
   - `move_to`
   - `tap_target`
   - `drag_to_target`
   - `collect_nearby`
   - `deliver_to`
   - `attack_target`
2. **状态变化原子**
   - `activate_entity`
   - `deactivate_entity`
   - `set_state`
   - `add_resource`
   - `change_color`
   - `spawn_entity`
   - `apply_damage`
3. **表现原子**
   - `camera_focus`
   - `camera_lift`
   - `camera_zoom`
   - `highlight_target`
   - `show_guide`
   - `show_floating_text`
   - `play_pop_animation`

这里有一个关键边界：

- **不是所有分镜文案都要模块化**
- 只有那些能稳定复用、能产生 runtime 或验证价值的语义，才值得进入 registry

例如：

- “镜头从全景缓慢拉高并对准炮塔”  
  应该落成 `camera_lift + camera_focus`
- “玩家靠近木材后收集，木材变金色并弹出 +1”  
  应该落成 `move_to + collect_nearby + change_color + show_floating_text`

---

## 5. 新中间表示设计

### 5.1 总体结构

目标主链：

`StoryboardParse -> StoryboardAtomPlan -> EntityPlan -> AssemblyPlan -> AssemblyValidate -> Emit -> CUAPlan -> Verify`

其中：

- `StoryboardParse`  
  从脚本/图片/PDF 得到 `storyboardFrames`
- `StoryboardAtomPlan`  
  把分镜里“玩家做什么 / 世界发生什么 / 镜头如何表现”压成标准原子积木
- `EntityPlan`  
  把分镜中涉及的对象抽成实体，并表达其 `archetype + modules + params`
- `AssemblyPlan`  
  把实体、phase、事件、状态、文件写入责任拼成一张可执行装配图
- `AssemblyValidate`  
  校验组合合法性、依赖闭包、状态唯一性
- `Emit`  
  只按 registry 和 plan 落确定性代码
- `CUAPlan`  
  生成模块感知的测试路径、操作脚本、反馈断言和完成条件

### 5.2 StoryboardAtomPlan

建议新增一层更靠近分镜语义的 IR：

```json
{
  "version": "storyboard-atom-plan-v1",
  "beats": [
    {
      "beatId": "beat_01_build_belt",
      "chapterId": 1,
      "interactionAtoms": [
        { "type": "move_to", "actor": "Player", "target": "ConveyorBeltGhost" },
        { "type": "spend_resource", "resource": "gold", "amount": 1 }
      ],
      "stateAtoms": [
        { "type": "set_state", "entity": "ConveyorBelt", "field": "buildState", "value": "building" },
        { "type": "activate_entity", "entity": "WoodLogSpawner" }
      ],
      "presentationAtoms": [
        { "type": "camera_focus", "target": "ConveyorBelt" },
        { "type": "camera_lift", "amount": 1.5, "duration": 0.8 },
        { "type": "show_guide", "text": "移动到传送带位置建造它" }
      ]
    }
  ]
}
```

#### StoryboardAtomPlan 的作用

1. 让分镜语义先被标准化，再进入 Entity/Assembly 设计。
2. 把“镜头语言”和“玩法语言”都从自然语言里剥出来。
3. 为 CUA 提供天然的操作路径和观察点。
4. 为后续 parser / planner prompt 提供统一词汇表。

### 5.3 EntityPlan

建议新增 schema：

```json
{
  "version": "entity-plan-v1",
  "entities": [
    {
      "id": "ConveyorBelt",
      "label": "传送带",
      "archetype": "buildable_station",
      "visual": {
        "pool": "__Pool_Cube_Gray_01",
        "position": [0, 0, 2],
        "scale": [4, 0.3, 1]
      },
      "modules": [
        { "type": "spawn_rule", "params": { "condition": "phase:build_belt", "style": "blueprint" } },
        { "type": "proximity_trigger", "params": { "radius": 2.0 } },
        { "type": "cost_gate", "params": { "gold": 1 } },
        { "type": "build_progress", "params": { "buildTime": 1.5 } },
        { "type": "activate_targets", "params": { "targets": ["WoodLogSpawner"] } }
      ]
    }
  ]
}
```

#### EntityPlan 约束

1. `modules[].type` 必须来自 registry，不能临时造新名字。
2. 单个实体允许：
   - L1 capability modules
   - L2 archetype shortcut
3. 不允许：
   - `template: "Mover+Damageable"` 这种字符串拼接继续作为主表达
   - 模块参数里内嵌自然语言 code snippet

### 5.4 AssemblyPlan

建议新增更严格的装配 IR：

```json
{
  "version": "assembly-plan-v1",
  "phaseBindings": [
    {
      "id": "build_belt",
      "activateEntities": ["Player", "ConveyorBelt"],
      "guide": "移动到传送带位置建造它",
      "camera": { "lookAt": "ConveyorBelt", "zoom": 8 },
      "advanceWhen": {
        "type": "entity_state",
        "entity": "ConveyorBelt",
        "field": "buildState",
        "equals": "built"
      }
    }
  ],
  "moduleInstances": [
    {
      "instanceId": "ConveyorBelt.cost_gate",
      "entityId": "ConveyorBelt",
      "moduleType": "cost_gate",
      "writesState": ["economy.gold"],
      "readsState": ["player.position"],
      "emits": ["build_requested"],
      "consumes": ["player_near"]
    },
    {
      "instanceId": "ConveyorBelt.build_progress",
      "entityId": "ConveyorBelt",
      "moduleType": "build_progress",
      "writesState": ["ConveyorBelt.buildState", "ConveyorBelt.buildTimer"],
      "readsState": ["economy.gold"],
      "emits": ["build_completed"],
      "consumes": ["build_requested"]
    }
  ],
  "eventGraph": [
    { "event": "player_near", "from": "ConveyorBelt.proximity_trigger", "to": ["ConveyorBelt.cost_gate"] },
    { "event": "build_requested", "from": "ConveyorBelt.cost_gate", "to": ["ConveyorBelt.build_progress"] },
    { "event": "build_completed", "from": "ConveyorBelt.build_progress", "to": ["phase.build_belt.advance"] }
  ],
  "stateOwners": {
    "ConveyorBelt.buildState": "ConveyorBelt.build_progress",
    "ConveyorBelt.buildTimer": "ConveyorBelt.build_progress",
    "economy.gold": "global.economy_wallet"
  },
  "fileOwners": {
    "GameFlowManagerMain.Flow.cs": ["phase_runtime", "phase_dispatch"],
    "GameFlowManagerMain.Input.cs": ["player_input", "tap_dispatch"],
    "GameFlowManagerMain.Resource.cs": ["economy_wallet", "inventory_runtime"],
    "GameFlowManagerMain.Scene.cs": ["entity_registry", "placement_runtime"],
    "GameFlowManagerMain.UI.cs": ["guide_ui", "feedback_ui"]
  },
  "unresolved": []
}
```

#### AssemblyPlan 必须显式回答 6 个问题

1. **moduleInstances**  
   这次运行到底实例化了哪些模块？
2. **stateOwners**  
   每个状态字段究竟归谁写？
3. **eventGraph**  
   谁 emit，谁 consume，是否闭环可达？
4. **phaseBindings**  
   phase 负责激活什么、依赖什么条件推进？
5. **fileOwners**  
   哪个模块可以写哪个 partial？
6. **unresolved**  
   哪些能力当前 registry 不支持，必须 fallback？

### 5.5 Module Registry

为支撑 deterministic emitter，需引入 registry：

```json
{
  "type": "build_progress",
  "level": "L1",
  "paramsSchema": {
    "buildTime": "number"
  },
  "requires": ["spawn_rule"],
  "providesState": ["<entity>.buildState", "<entity>.buildTimer"],
  "allowedTriggers": ["proximity_trigger", "click_trigger", "deliver_count_trigger"],
  "writesFiles": ["GameFlowManagerMain.Flow.cs", "GameFlowManagerMain.Scene.cs"],
  "runtimeHooks": ["on_enter", "on_update", "on_autoplay_arrive"],
  "validator": "validateBuildProgressModule"
}
```

建议模块层级：

| 层级 | 作用 | 例子 |
|---|---|---|
| L1 capability | 最小行为单元 | `proximity_trigger`, `damageable`, `move_to_target`, `cooldown`, `drop_on_death` |
| L2 archetype | 常见玩法组合 | `buildable_station`, `basic_enemy`, `tap_shooter`, `carry_deliver_loop` |
| L3 project preset | 业务级便捷入口 | `idle_upgrade_loop`, `tower_defense_lane` |

**建议**: 第一版只做 L1 + 少量 L2，不要直接上太多 L3。

### 5.6 Storyboard Atom Registry

除了 runtime module registry，还需要一套分镜原子 registry：

```json
{
  "type": "camera_lift",
  "category": "presentation",
  "paramsSchema": {
    "amount": "number",
    "duration": "number"
  },
  "mapsToModules": ["camera_controller"],
  "cuaAssertions": [
    "camera_height_changed",
    "target_remains_in_view"
  ]
}
```

建议 registry 字段：

- `type`
- `category` (`interaction | state | presentation`)
- `paramsSchema`
- `mapsToModules`
- `phaseHints`
- `cuaAssertions`
- `autoplaySupport`

### 5.7 CUAPlan

新增一层验证 IR：

```json
{
  "version": "cua-plan-v1",
  "steps": [
    {
      "stepId": "step_01_build_belt",
      "fromBeat": "beat_01_build_belt",
      "requiredActions": [
        { "type": "move_to", "actor": "player", "target": "ConveyorBeltGhost" }
      ],
      "expectedFeedback": [
        { "type": "guide_visible", "text": "移动到传送带位置建造它" },
        { "type": "entity_state", "entity": "ConveyorBelt", "field": "buildState", "equals": "built" },
        { "type": "camera_focus_changed", "target": "ConveyorBelt" }
      ],
      "completionSignal": {
        "type": "phase_advanced",
        "phaseId": "build_belt"
      }
    }
  ]
}
```

#### CUAPlan 的目的

1. 不再依赖 CUA 从代码结构反推“用户下一步该做什么”。
2. 由模块与原子直接暴露：
   - 可操作 affordance
   - 预期反馈
   - 完成信号
3. 让 CUA 验证从“黑盒试玩”升级为“黑盒操作 + 白盒模块合同”混合校验。

---

## 6. 对当前链路的逐环节分析与改造建议

### 6.1 Storyboard Parse

现状：

- `adapters/storyboard-parser.cjs` 负责把脚本/图片/PDF 解析成 `storyboardFrames`
- 输出面向画面和交互描述，重点是 narrative completeness，不是 runtime composition

问题：

1. 输出对“镜头表现”描述很强，但对“模块能力”没有稳定结构。
2. 后续 `spec-extractor` 不得不再次把自然语言压缩成 phase spec。

建议：

- 保留当前 `storyboardFrames` 作为视觉和叙事输入
- 新增 `storyboard-to-atom-plan` 阶段
- 再由 atom plan 驱动 `entity-plan` 和 `assembly-plan`
- 这一步不直接产代码，也不直接产传统 `specs`

### 6.2 Parse-and-Blueprint / Convert-to-V4

现状：

- `api/storyboard.cjs:827` 已能把解析结果保存到项目
- 当前 V4 仍以 `entity + template + trigger + behavior` 为主

问题：

1. `template` 颗粒度过粗
2. 复合模板没有 schema 地位
3. phase/endCondition 多为描述性字段，未与 runtime file ownership 对齐
4. 镜头/表现语义与实体语义仍然混在自然语言里

建议：

1. 把 V4 升级为 `EntityPlan v1`
2. `template` 改为：
   - `archetype`
   - `modules[]`
3. `trigger / behavior / actions` 拆进各模块参数
4. 新增 `storyboardAtoms / presentationAtoms` 与实体模块并列存储，避免镜头语义丢失

### 6.3 Submit Path

现状：

- `engine/project-service.cjs:85`
- 只要有 storyboard，就自动触发 spec extraction

问题：

- 即使项目已经有有效 V4，也会被重新拉回 `storyboard -> specs`

建议：

新增提交流程分叉：

1. 如果 `project.version >= 4` 且 `EntityPlan/AssemblyPlan` 校验通过  
   直接进入 `submitted`
2. 如果只有 storyboard，没有结构化实体计划  
   才进入 `spec_extracting`

即：

- `V4 valid -> assembly path`
- `storyboard only -> extraction path`

### 6.4 Spec Extract

现状：

- `adapters/spec-extractor.cjs` 以 chapter 为单位提取：
  - duration
  - requiredInteractions
  - triggerNext
  - entitiesRequired

价值：

- 对 CUA timing、用户路径、章节完整性仍有意义

局限：

1. spec 关注“体验节奏”，不关注代码装配边界
2. 一个 chapter 一个 phase 的抽象，对复杂实体复用和跨 phase 持续行为表达不足

建议：

- 不立即删除 `spec-extract`
- 但把它从“代码生成主输入”降级为：
  - `experience contract`
  - `CUA expectation`
  - `timing/autoplay metadata`

即 spec 继续存在，但不再驱动 runtime code structure。

### 6.5 Complexity Gate

现状：

- complexity gate 主要按 phase/spec/codegen 风险控制

建议：

未来拆成两层：

1. `assembly-complexity-gate`
   - 模块实例数
   - unresolved 数量
   - event graph 深度
   - phase fan-out
2. `fallback-complexity-gate`
   - 允许 fallback 的 slot 数量
   - 单次 fallback 可写文件范围

同时引入：

3. `cua-complexity-gate`
   - 单任务 CUA step 数
   - 可观察反馈点数量
   - 是否存在无法从模块合同验证的黑盒行为

### 6.6 Codegen Schema + Template Engine

现状：

- `engine/stages/codegen-schema.cjs:1`
- `adapters/codegen-template-engine.cjs:41`

问题：

1. schema 仍是给 C# TODO 填空服务，不是 runtime 装配 IR
2. `TODO_CUSTOM` 仍允许自由逻辑扩散
3. coverage 指标不能反映“模块组合是否完整”

建议：

#### 6.6.1 把当前 `gameSchema` 让位给 `AssemblyPlan`

从：

- `gameConfig / entities / resources / forms / phases / npcs / customLogic`

改为：

- `entityPlan`
- `assemblyPlan`
- `unresolved`

#### 6.6.2 emitter 代替大部分 template fill

当前 template engine 的职责要拆分：

| 现职责 | 目标归宿 |
|---|---|
| skeleton TODO 填空 | deterministic emitter |
| interaction templates | module emitter |
| custom todos | unresolved fallback plan |
| coverage 统计 | assembly coverage 统计 |

此外要补两类 emitter：

| 新职责 | 目标归宿 |
|---|---|
| camera/highlight/guide/floating text 等表现积木 | presentation emitter |
| beat/step → 可执行验证动作 | CUA plan emitter |

### 6.7 Method Check / Review

现状：

- 大量结构问题在 `method-check / review` 才暴露
- `docs/INCIDENTS.md` 已记录多个 deterministic repair

建议：

把它们从“结构修复”转成“装配验证补充层”：

1. `method-check`
   - 检查 emitter 输出是否违反 contract
   - 不再承担主结构修复职责
2. `review`
   - 关注行为合理性、性能热点、少量 unresolved 结果
   - 不再承担 phase gate 救火职责

这要求前面必须有更强的 `AssemblyValidate`。

### 6.8 Compile / Visual / CUA

这些阶段本身可以保留，但验证口径要调整：

1. compile  
   验证 emitter 的静态正确性
2. visual-check  
   验证 phase 激活、对象显隐、镜头/表现模块是否符合计划
3. CUA  
   验证体验闭环是否符合 `spec-extract` 输出的用户路径和 timing，并且符合 `StoryboardAtomPlan + CUAPlan` 的模块合同

换句话说，后段验证仍保留，但其输入应该从“生成的 C# 猜出来的行为”变成“EntityPlan/AssemblyPlan 的明示意图”。

#### 6.8.1 CUA 需要怎样适配模块化

当前 CUA 更偏黑盒验证。改造后应增加 module-aware 能力：

1. **操作生成**
   - 根据 `interactionAtoms` 生成点击、拖拽、移动、等待、攻击等动作
2. **反馈断言**
   - 根据 `presentationAtoms` 断言 guide、镜头变化、高亮、飘字、颜色变化
3. **状态断言**
   - 根据 `stateAtoms` / `stateOwners` 断言资源变化、实体状态推进、phase 切换
4. **autoplay 适配**
   - 每个模块声明是否支持 autoplay mirror，CUA 不再用统一 heuristics 猜
5. **失败归因**
   - 失败时输出：
     - 哪个 atom 没被触发
     - 哪个 module 没产出预期反馈
     - 哪个 completion signal 没到

建议为每个模块补充以下 CUA 元数据：

- `affordances`
- `expectedSignals`
- `observableFeedback`
- `autoplayMirror`
- `failureFingerprints`

---

## 7. 目标架构

### 7.1 新 happy path

```text
Storyboard / Docs / Images
        ↓
Storyboard Parser
        ↓
StoryboardAtomPlan Builder
        ↓
EntityPlan Builder
        ↓
Assembly Planner
        ↓
Assembly Validate
        ├─ pass → Deterministic Emitter → Compile/Visual/CUA
        └─ unresolved → Localized Fallback Generator → Contract Scrub → Compile/Visual/CUA
                               ↓
                            CUAPlan Emitter
```

### 7.2 Fallback 设计原则

fallback 必须被严格关住：

1. 只允许处理 `AssemblyPlan.unresolved[]`
2. 只允许写预定义 slot，不允许改主骨架
3. 只允许改有限文件：
   - 指定 partial
   - 指定 region
4. fallback 后必须立即做 contract scrub

示例：

```json
{
  "unresolved": [
    {
      "slot": "GameFlowManagerMain.Flow.cs::Phase_bossFight_OnTap",
      "reason": "module combo not registered: tap_target_select + cone_aoe_attack",
      "allowedWrites": ["GameFlowManagerMain.Flow.cs"],
      "forbiddenWrites": ["GameFlowManagerMain.Scene.cs", "GameFlowManagerMain.Resource.cs"]
    }
  ]
}
```

---

## 8. 为什么这条路线更可靠

### 8.1 把不确定性从代码层降到配置层

当前系统的不稳定点主要来自：

- 变量重复声明
- 别名漂移
- phase gate 与 handler 不一致
- partial 间责任模糊

这些问题都是“代码层面才暴露”的。  
如果在装配前就知道：

- 谁拥有 `buildState`
- 谁可以写 `gold`
- 哪个 module 负责 `OnTap`
- 哪个 partial 可以落哪些逻辑

那么很多问题会在 emit 前被拦下，而不是进 review 后再补。

### 8.2 与现有 deterministic 资产方向一致

当前仓库已经有以下基础：

- split-partial skeleton
- template engine
- interaction templates
- behavior templates
- contract checks
- deterministic repair

Assembly-first 不是推倒重来，而是把这些资产从“补 AI 生成的不确定性”升级为“直接驱动 assembly 输出”。

### 8.3 更适合实体复用与能力复合

当前复合实体通过：

- 复合 template 字符串
- 生成代码中的隐式状态

这种方式难以扩展。

模块化之后，同一个实体可自然复用：

- `Mover`
- `Damageable`
- `ProjectileEmitter`
- `CostGate`
- `InventorySource`

新玩法优先表现为“模块组合变化”，而不是 prompt 重新发明代码结构。

### 8.4 更适合把“镜头语言”和“验证语言”统一起来

如果 `camera_lift / camera_focus / highlight_target / change_color` 仍停留在自然语言：

- parser 要猜
- emitter 要猜
- CUA 也要猜

它们一旦进入 StoryboardAtom registry：

- parser 输出稳定
- emitter 有明确落点
- CUA 有明确断言项

这会明显减少“玩法做对了，但镜头/引导/反馈不稳定”这类灰区问题。

---

## 9. 主要风险与控制策略

### 9.1 风险：模块切得过细，装配图爆炸

表现：

- registry 数量失控
- planner 输出过长
- 组合验证难度上升

策略：

1. 先只做高频 L1 模块
2. 对高频组合引入 L2 archetype
3. 限制单实体最大 module 数

### 9.2 风险：模块切得过粗，重新退回 template 黑盒

表现：

- `buildable_station` 里又塞进太多隐式行为
- unresolved 继续靠文字描述补洞

策略：

1. 每个 archetype 必须能降解为显式 modules
2. archetype 只做 shortcut，不做独占逻辑容器

### 9.3 风险：现有验证和修复链条与新 IR 不兼容

表现：

- method-check 仍按旧代码形态检查
- review/fix recipe 找不到新结构锚点

策略：

1. 先做 dual path
2. 给 emitter 输出保留兼容锚点
3. 逐步把 contract 迁到 AssemblyValidate

### 9.4 风险：覆盖率不足，fallback 比例过高

表现：

- 虽然引入了 AssemblyPlan，但大部分任务仍走 fallback

策略：

1. 第一阶段只覆盖高频玩法簇
2. 新增 fallback rate 指标
3. 只有 fallback rate 降到阈值以下，才考虑进一步下线旧 codegen

### 9.5 风险：体验 spec 被弱化后，CUA 失去预期输入

策略：

- 保留 `spec-extract`，但将其定位为 experience contract，而不是 runtime code source

### 9.6 风险：分镜原子过多，parser 和 CUA 成本一起膨胀

策略：

1. 只收录高复用、高验证价值原子
2. 先限定原子库规模
3. 无稳定收益的镜头修辞不进入 registry

---

## 10. 分阶段落地建议

### Phase 0: 规格冻结与口径统一

目标：

- 定义 `StoryboardAtomPlan v1`
- 定义 `EntityPlan v1`
- 定义 `AssemblyPlan v1`
- 定义 `CUAPlan v1`
- 定义 module registry 草案
- 定义 storyboard atom registry 草案
- 明确 phase、state、file ownership 的术语

产物：

- schema 文档
- 样例 plan
- validator 接口约定

### Phase 1: V4 schema 升级，不改主 pipeline

目标：

- 支持 `storyboardAtoms / presentationAtoms`
- `template` 升级为 `archetype + modules[]`
- 编辑器和 parser 仍可继续保存现有项目
- 老项目可自动映射到新 schema

说明：

- 这一步只升级输入表达能力，不切生产主链

### Phase 2: 新增 `EntityPlan -> AssemblyPlan` 生成器

目标：

- 在 storyboard 基础上先生成 `StoryboardAtomPlan`
- 在 storyboard/V4 基础上生成可校验 `AssemblyPlan`
- 引入 AssemblyValidate
- 引入 CUAPlan builder

说明：

- 这一步仍允许继续走旧 codegen，只做旁路验证

### Phase 3: 引入 deterministic emitter

目标：

- 先覆盖高频玩法：
  - `PlayerController`
  - `Buildable`
  - `Collectible`
  - `Deliver`
  - `Upgrade`
  - `Spawner`
  - `Shooter`
  - `Damageable`
  - `CTA`
- 先覆盖高频表现：
  - `camera_focus`
  - `camera_lift`
  - `highlight_target`
  - `show_guide`
  - `show_floating_text`
  - `change_color`

说明：

- 只要 plan 可全量解析，就优先 emitter
- unresolved 才进入 fallback

### Phase 4: 提交主链切换为 assembly-first

目标：

- `project.version >= 4 && assembly valid` 时跳过 `spec-extract -> codegen-schema`
- 旧路径保留为 fallback

### Phase 5: 缩小旧 codegen 职责

目标：

- 旧 `codegen-schema` 不再负责主 C# 产出
- 只负责 unresolved slot 生成
- CUA 默认优先消费 `CUAPlan`，不再只靠黑盒 heuristics

---

## 11. 指标与验收标准

当前 `templateCoverage` 不足以衡量 assembly 稳定性。  
建议新增：

| 指标 | 定义 | 目标 |
|---|---|---|
| `assemblyCoverage` | 已被 registry/emitter 覆盖的 module instance 比例 | 持续上升 |
| `fallbackRate` | 触发 unresolved fallback 的任务比例 | 持续下降 |
| `unresolvedCount` | 单任务 unresolved module 数 | 越低越好 |
| `stateOwnerConflicts` | 多模块声明同一状态字段写权限的次数 | 必须为 0 |
| `illegalCrossModuleWrites` | 模块写入未授权 partial/field 的次数 | 必须为 0 |
| `phaseBindingViolations` | phase advance 依赖不存在/不可达状态的次数 | 必须为 0 |
| `storyboardAtomCoverage` | 分镜语义中被 atom registry 成功标准化的比例 | 持续上升 |
| `methodCheckStructuralFailRate` | method-check 因结构问题失败比例 | 显著下降 |
| `reviewRoundAvg` | review 平均轮数 | 显著下降 |
| `compilePassRate` | 编译通过率 | 显著上升 |
| `cuaPassRate` | 最终可玩通过率 | 最终目标指标 |
| `cuaPlanUsageRate` | 使用模块化 CUAPlan 执行的任务比例 | 持续上升 |
| `cuaAssertionMissRate` | CUA 按模块合同执行时的断言失败比例 | 持续下降 |

建议切换阈值：

1. `assemblyCoverage >= 0.8`
2. `fallbackRate <= 0.2`
3. `stateOwnerConflicts == 0`
4. `illegalCrossModuleWrites == 0`
5. `storyboardAtomCoverage` 稳定上升
6. `cuaPlanUsageRate` 稳定上升
7. method-check 结构类失败占比明显低于当前基线

在达到这些阈值之前，不建议彻底移除旧 codegen。

---

## 12. 推荐的第一批模块清单

更细的 v1 注册表、参数口径和 `atom -> module -> CUA assertion` 映射，见 companion 文档：

- `docs/specs/2026-04-23-assembly-registry-pack-v1.md`

优先覆盖当前最常见、最稳定、最容易 deterministic 的能力：

| 模块 | 说明 |
|---|---|
| `visual_binding` | pool/position/scale/show-hide |
| `player_input_joystick` | 摇杆移动 |
| `player_input_tap` | 点击输入 |
| `proximity_trigger` | 距离触发 |
| `click_trigger` | 点击触发 |
| `drag_trigger` | 拖拽触发 |
| `cost_gate` | 资源扣费 |
| `build_progress` | 建造状态推进 |
| `collect_on_near` | 靠近采集 |
| `deliver_to_target` | 交付/售卖 |
| `spawn_interval` | 定时刷出 |
| `move_to_target` | 向目标移动 |
| `damageable` | 血量/受击/死亡 |
| `projectile_emit` | 发射投射物 |
| `cooldown` | 冷却 |
| `on_death_drop` | 死亡掉落 |
| `guide_ui` | guide 文案 |
| `score_feedback` | 飘字/分数 |
| `cta_finish` | 结束 CTA |
| `camera_focus` | 镜头看向目标 |
| `camera_lift` | 镜头抬高/拉远 |
| `change_color` | 颜色变化反馈 |
| `highlight_target` | 高亮目标 |

这批模块足以覆盖大部分当前 SLG / TD / idle-lite 样本的主环。

同时建议第一批分镜原子清单：

| 原子 | 说明 |
|---|---|
| `move_to` | 角色/镜头移动到目标 |
| `tap_target` | 点击目标 |
| `drag_to_target` | 拖拽目标 |
| `collect_nearby` | 靠近采集 |
| `attack_target` | 攻击目标 |
| `change_color` | 颜色切换 |
| `camera_focus` | 镜头对准 |
| `camera_lift` | 镜头拉高 |
| `camera_zoom` | 镜头拉近/拉远 |
| `show_guide` | 引导出现 |
| `show_floating_text` | 飘字反馈 |

---

## 13. 第二轮审视后的遗漏环节

按“积木化”方案再过一遍现有系统后，以下环节必须补进实施范围，否则设计成立但链路跑不通。

### 13.1 编辑器与项目存储层

当前缺口：

- `api/projects.cjs:187` 的 `saveBlueprint` 只保存 `nodes / edges / projectName / globalSettings / entities`
- `frontend/src/App.jsx:533` 自动保存也只传这些字段
- `frontend/src/App.jsx:756` 提交前保存同样没有 `phases / storyboardAtoms / plans`
- `api/projects.cjs:52` 的 `exportBlueprintForAgent()` 目前只导出 `entities / phases / specs / storyboard`

因此要补：

1. 项目 JSON schema 扩容，显式保存：
   - `storyboardAtomPlan`
   - `entityPlan`
   - `assemblyPlan`
   - `cuaPlan`
2. `saveBlueprint` / `getProject` / `exportBlueprintForAgent` 全链路透传这些字段
3. 版本迁移器：
   - 老项目 `template` 自动迁到 `archetype + modules[]`
   - 无 atom 的项目允许按需懒生成

### 13.2 人审与确认流

当前缺口：

- 现有系统有 `spec_review / confirmSpecs` 流程
- `api/projects.cjs:401` 会把确认后的 specs 保存给 CUA
- 但没有任何对应的 `atom/assembly/cua plan review` 环节

因此要补：

1. 新的人工确认点：
   - `atom_review`
   - `assembly_review`
   - 或合并成 `plan_review`
2. UI 里要能查看和编辑：
   - atom 列表
   - entity modules
   - phase bindings
   - unresolved 列表
3. 提交前要允许“确认 plan，而不是只确认 specs”

### 13.3 分镜原子到运行时能力的映射层

这是当前 spec 里最容易被低估的缺口。

`StoryboardAtom` 不是 runtime module，本质上它是更高层的语义。  
因此必须补一张明确映射表：

`atom -> module combo -> emitter slots -> CUA assertions`

例如：

- `attack_target`
  - 不等于一个模块
  - 可能映射为 `target_acquire + projectile_emit + apply_damage`
- `camera_lift`
  - 可能映射为 `camera_controller.adjust_height`
- `change_color`
  - 在 Luna 里通常不能直接改 material，需要走可替代实现

如果没有这张映射层，atom registry 会沦为另一套自然语言标签。

### 13.4 表现与资产绑定层

这里有一个明确的技术约束：

- `engine/static-check.cjs` 明确禁止：
  - `GFM_Create.SetColor()`
  - `.material.color =`
  - `new Material()`

这意味着很多看上去简单的表现原子，其实不能直接写成运行时代码：

- `change_color`
- `highlight_target`
- 某些“发光/换色”反馈

因此必须补：

1. **表现实现策略表**
   - 哪些效果可直接 runtime 控制
   - 哪些效果必须通过 pool variant / object swap / UI overlay 实现
2. **资产变体注册表**
   - 同一个实体是否有不同颜色/高亮/建造态 pool variant
3. **镜头控制模块**
   - 例如 `camera_focus / camera_lift / camera_zoom` 对应的 canonical runtime API

否则 parser 能产出 atom，但 emitter 无法合法落地。

### 13.5 校验层

当前缺口：

- `adapters/schema/validate-schema.cjs` 只校验旧 `gameSchema`
- `engine/stages/spec-validate.cjs` 校验的是 `specs`
- `engine/stages/complexity-gate.cjs` 评分也是按 `specs + entities`

因此要补四类 validator：

1. `StoryboardAtomPlan` validator
2. `EntityPlan` validator
3. `AssemblyPlan` validator
4. `CUAPlan` validator

以及三类 cross-plan validator：

1. atom 是否都能映射到 module
2. assembly state ownership 是否唯一
3. CUA assertion 是否都能从 atom/module 找到观察点

同时要把 complexity gate 重做成：

- `assembly-complexity-gate`
- `cua-complexity-gate`
- `fallback-complexity-gate`

### 13.6 Emitter 与 partial ownership 层

当前缺口：

- `adapters/skeleton-generator.cjs` 仍然是按 `specs` 生成 skeleton
- 它的相位、interaction flag、phase gate 都围绕旧 spec 模型设计

因此要补：

1. `assembly emitter`
   - 按 `fileOwners` 写入 partial
2. `presentation emitter`
   - 专门落镜头、高亮、引导、飘字
3. `fallback slot system`
   - 先定义 slot，再允许 fallback 写入
4. `emit manifest`
   - 记录每个 module/atom 最终写到了哪个文件和哪个锚点

没有 `emit manifest`，后面的 review / metrics / archive 都不好做归因。

### 13.7 Static-check / Method-check / Review 适配层

当前缺口：

- `engine/static-check.cjs` 是 regex-based C# 规则
- `engine/stages/method-check.cjs` 也是基于方法扫描和少量 deterministic repair
- 它们目前完全不知道 atom/module/assembly plan 的存在

因此要补：

1. plan-aware contract checks
   - 非法跨 module 写状态
   - 非法跨 partial 落代码
   - atom 未被实现
2. review 输入升级
   - reviewer 不只看代码，还要看 `assemblyPlan / emit manifest / unresolved`
3. fix recipe 升级
   - 失败指纹从“代码症状”扩展到“哪个 atom/module/plan binding 出错”

### 13.8 Visual-check / CUA 接口层

当前缺口非常明确：

- `engine/stages/visual-check.cjs` 当前只参考：
  - screenshot
  - entities
  - storyboard/globalSettings
- `worker/worker-playableagent.js:154`
  - CUA 现在是把 `specs` 写给 Python
  - `writeSpecsFile()` 只认 `blueprint.specs || blueprint.phases`

因此要补：

1. `visual-check` 读 `presentationAtoms / CUAPlan`
2. `PlayableAgent` 改输入协议：
   - 从 `specs.json` 扩成 `cua-plan.json` 或 `verify-plan.json`
3. CUA Python 侧支持：
   - requiredActions
   - expectedFeedback
   - completionSignal
4. autoplay 逻辑由模块元数据声明，不再靠全局 heuristics 猜

### 13.9 Metrics / Archive / 归因层

当前缺口：

- `engine/metrics.cjs` 只记录：
  - `templateCoverage`
  - `customLogicUsed`
  - `codegenMode`
- `engine/archive-writer.cjs` 的 blueprint digest 也只有 `specsCount / entitiesCount`

因此要补：

1. metrics 新字段：
   - `storyboardAtomCoverage`
   - `assemblyCoverage`
   - `fallbackRate`
   - `cuaPlanUsageRate`
   - `unresolvedByType`
2. archive 新字段：
   - `atomDigest`
   - `assemblyDigest`
   - `cuaPlanDigest`
   - `failedModule`
   - `failedAtom`
3. failure fingerprint 新口径：
   - 从“review parse error / duplicate-state-fields”扩成“module binding / atom mapping / assertion miss”

### 13.10 测试与迁移样本层

这是最后一个经常被遗漏但必须有的层。

要补：

1. **golden plans**
   - storyboard → atom plan
   - atom plan → assembly plan
   - assembly plan → emitted files
2. **回归样本集**
   - 收集/建造/升级/刷怪/射击/CTA 各一批
3. **迁移回放**
   - 用现有高频失败任务回放新链路
4. **idempotence tests**
   - 同输入多次生成 plan 必须稳定

没有这层，后续所有“模块化稳定性提升”都难以定量证明。

---

## 14. 需要统一的关键决策

以下问题如果不先统一，实施期会不断返工：

1. **V4 是否升格为 canonical submit artifact**
   - 我的建议：是

2. **是否保留 `spec-extract`**
   - 我的建议：保留，但降级为体验合同层

3. **模块颗粒度停在哪一层**
   - 我的建议：第一版以 L1 能力模块 + 少量 L2 archetype 为主

4. **fallback 可写范围有多大**
   - 我的建议：只能写 slot，不能改主骨架

5. **现有 template engine 是否直接废弃**
   - 我的建议：不废弃，改造成 emitter 的底层实现资产

6. **第一批覆盖哪些玩法**
   - 我的建议：优先覆盖当前 metrics 中出现频率最高的收集/建造/交付/刷怪/射击环

7. **分镜原子是否进入 registry**
   - 我的建议：进入，而且和 runtime module 一样做 schema/validator/CUA metadata

8. **CUA 是否改成优先消费模块合同**
   - 我的建议：是，逐步从纯黑盒切到 module-aware

---

## 15. 建议结论

这件事值得做，而且应该作为 Blueprint 下一阶段最核心的稳定性工程之一推进。  
但执行策略必须是：

**不是**:

- 直接删 `codegen`
- 再加一轮自然语言解析
- 继续让 AI 按“模块组合建议”写 C#

**而是**:

1. 把“实体搭积木”升级为正式 schema
2. 把“分镜描述”也升级成 `StoryboardAtomPlan`
3. 把“第二轮解析”做成严格 `AssemblyPlan`
4. 让 CUA 读 `CUAPlan + 模块合同`
5. 先走 `assembly-first, codegen-fallback`
6. 等覆盖率和失败面收敛后，再进一步收缩旧 codegen

---

## 16. 讨论清单

建议下一轮讨论聚焦以下 8 个问题：

1. `EntityPlan` 是否同意以 `archetype + modules[]` 替代当前单 `template`？
2. `StoryboardAtomPlan` 是否同意把 `交互 / 状态 / 表现` 三类原子做成 registry？
3. `AssemblyPlan` 是否同意把 `stateOwners / fileOwners / unresolved` 作为必填？
4. `spec-extract` 是否接受降级为 experience contract，而不再驱动代码结构？
5. CUA 是否同意优先消费 `CUAPlan + 模块合同`？
6. 第一阶段是否只覆盖高频模块，不追求全玩法纯装配？
7. fallback 是否接受“只能写 slot，不能重写主文件”？
8. 提交主链是否同意增加：
   - `V4 valid -> assembly path`
   - `storyboard only -> spec path`

以上 8 个问题确认后，就可以进入实现拆解和任务排期。
