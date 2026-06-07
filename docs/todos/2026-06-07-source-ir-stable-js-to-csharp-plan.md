# SourceSceneIR 稳定化方案：替代 storyboard2html -> demo2spec 的 JS 语义反推

日期：2026-06-07

## 结论

当前 `storyboard2html` 到 Unity/C# 的不稳定点，不是 HTML 是否能打开，而是这条链路仍然包含一段隐式翻译：

```text
LLM 生成 HTML/JS
  -> demo2spec 从 JS / PHASES / 函数体 / side effects 反推 gameSchema
  -> Blueprint codegen
  -> C# / Luna WebGL / Unity export
```

长期稳定方案不是强化“JS 到 C# 翻译”，而是把主事实前移成结构化 IR：

```text
storyboard / blueprint specs
  -> storyboard2html 生成 HTML + SourceSceneIR
  -> SourceSceneIR deterministic compiler
  -> gameSchema / specs / visualAssets / playableSceneIr
  -> Blueprint codegen / Luna WebGL / Unity export
```

也就是说：**主路径去掉 demo2spec 的 JS 语义推断；保留 demo2spec 作为 legacy fallback 和验收编排层，逐步改造成 SourceSceneIR bridge。**

## 目标

1. 让 HTML 效果稿、Luna WebGL、Unity 程序员交付包消费同一份结构化 source of truth。
2. 避免从任意 JS 函数体里猜 gameplay 语义。
3. 让 phase、entity、resource、camera、HUD、guidance、CTA 的映射可校验、可 diff、可 hash。
4. 让每次构建、导出、验收都有同源 hash 证据，防止旧 Unity 包或旧 WebGL 混入。

## 非目标

- 不要求第一阶段删除 `adapters/demo2spec/`。
- 不要求放弃 HTML playable；HTML 仍然是人工/视觉 review 的效果稿。
- 不做通用 JavaScript -> C# transpiler。
- 不把 `storyboard2html-generate.cjs` 变成长链路构建器；长链路应由新的 accept/build 脚本编排。

## 当前链路问题

### 已有保障

- `storyboard2html-smoke.cjs` 已能把 generated HTML 接入 `demo2spec -> Blueprint smoke -> CUA -> hardgate`。
- `demo2spec/extract.js` 已能生成 `asset-manifest.json`、`playable-scene-ir.json`，并写入 `sourceHtmlPath` / `sourceHtmlSha256` / `playableSceneIrHash`。
- 主 worker pipeline 有 `source-html-bind` 作为第一阶段；storyboard2html/demo2spec flow 下缺 source HTML 或缺 sha256 会 hard fail。
- `fidelity-source-diff` 和 `storyboard-webgl-visual-diff` 已经可以比较 source HTML 和 WebGL 产物。

### 主要不稳定来源

1. `demo2spec` 仍会从 JS 函数、side effects、factory patterns 里推断玩法。
2. HTML prompt 约束的是 `PHASES`、`ENTITY_STYLE`、`SCENE_CONFIG` 等多个分散合同，不是一个单一 canonical IR。
3. `gameSchema`、`visualAssets`、`playableSceneIr` 之间有重复信息，容易出现 drift。
4. `storyboard2html-generate` 只写 HTML；后续 smoke/build/export 是独立动作，容易漏跑。
5. Unity export 依赖最近一次 build 保存到 `server-data/project-sources/<taskId>` 的 C#，需要额外 freshness gate。

## 核心设计

新增 `SourceSceneIR`，作为 storyboard2html 主路径的唯一语义输出。

HTML 可以继续有 JS runtime，但 Unity/C# 不再从 JS runtime 推断；C# 只从 IR 编译。

### IR 输出形式

第一阶段建议同时支持两种形态：

```js
window.__BP_SOURCE_IR__ = { ... };
window.__BP_SOURCE_IR_HASH__ = "sha256...";
```

以及独立文件：

```text
source-ir.json
source-ir.sha256
```

HTML 内嵌是为了 source HTML 自包含；独立文件是为了脚本和 CI 更容易消费。

### IR 最小结构

```json
{
  "schemaVersion": "source-scene-ir.v1",
  "project": {
    "name": "Water Seller",
    "theme": "farming"
  },
  "scene": {
    "coordinateSystem": "three-xz-y-up",
    "backgroundColor": "#071026",
    "camera": {
      "kind": "perspective",
      "fov": 55,
      "near": 0.1,
      "far": 1000,
      "position": [0, 8, 12],
      "lookAt": [0, 0, 0],
      "follow": {
        "entity": "Player",
        "positionOffset": [0, 8, 12],
        "lookAtOffset": [0, 0, 0],
        "lerp": 0.12
      }
    },
    "ground": {
      "kind": "plane",
      "size": [24, 24],
      "color": "#13233a"
    },
    "lights": [
      { "kind": "ambient", "color": "#ffffff", "intensity": 0.65 },
      { "kind": "directional", "color": "#ffffff", "intensity": 1.2, "position": [6, 10, 5] }
    ]
  },
  "entities": [
    {
      "id": "Player",
      "label": "玩家",
      "kind": "player",
      "position": [0, 0, 0],
      "scale": [0.7, 0.7, 0.7],
      "visibleFromPhase": "phase1",
      "visual": {
        "primitive": "capsule",
        "color": "#66ccff",
        "meshOps": []
      }
    }
  ],
  "resources": [
    {
      "id": "Gold",
      "label": "金币",
      "carrierEntity": "GoldPile",
      "kind": "currency",
      "initial": 0
    }
  ],
  "phases": [
    {
      "id": "phase1",
      "title": "收集金币",
      "guideText": "拖动摇杆到金币堆",
      "showEntities": ["Player", "GoldPile"],
      "steps": [
        {
          "kind": "move_to",
          "target": "GoldPile",
          "radius": 1.2
        },
        {
          "kind": "collect",
          "resource": "Gold",
          "amount": 5,
          "from": "GoldPile"
        }
      ],
      "gate": {
        "kind": "resource",
        "resource": "Gold",
        "threshold": 5
      },
      "duration": { "min": 10, "max": 15 }
    }
  ],
  "hud": {
    "tip": { "source": "phase.guideText" },
    "resourceBar": ["Gold"],
    "cta": { "entity": "CtaButton", "arrivalGated": true }
  },
  "runtimeContract": {
    "requiresJoystick": true,
    "requiresArrivalGate": true,
    "forbidAutoplayProgress": true
  }
}
```

### DSL 白名单

`phases[].steps[].kind` 只允许有限集合：

```text
move_to
collect
deliver
build
upgrade
attack
spawn
despawn
show
hide
set_tip
set_resource
set_entity_state
wait
cta_finish
```

`phases[].gate.kind` 只允许：

```text
near_entity
resource
entity_state
entity_count
timer
compound_all
compound_any
cta_arrival
```

这两个白名单是稳定性的核心。C# codegen 不处理任意 JS，只处理这些可枚举动作。

## 新增/改造模块

### 1. IR schema 与 validator

新增：

```text
contracts/source-scene-ir.v1.json
engine/source-scene-ir.cjs
test/source-scene-ir.test.cjs
```

`engine/source-scene-ir.cjs` 负责：

- `validateSourceSceneIr(ir)`
- `normalizeSourceSceneIr(ir)`
- `computeSourceSceneIrHash(ir)`
- `extractSourceSceneIrFromHtml(html, sourceHtmlPath)`
- `writeSourceSceneIr(outPath, ir)`
- `assertSourceSceneIrBinding(ir, { sourceHtmlPath, sourceHtmlSha256 })`

验收：

```bash
cd /opt/blueprint-editor
node test/source-scene-ir.test.cjs
```

### 2. storyboard2html prompt 强制输出 IR

修改：

```text
engine/storyboard2html-prompt.cjs
engine/storyboard2html-contract.cjs
contracts/storyboard2html-html-contract.v1.json
test/storyboard2html-prompt.test.cjs
test/storyboard2html-contract.test.cjs
```

要求 HTML 顶层必须包含：

```js
window.__BP_SOURCE_IR__ = { ... };
window.__BP_SOURCE_IR_HASH__ = "...";
```

并要求旧合同从 IR 派生：

```text
PHASES            = __BP_SOURCE_IR__.phases 的兼容投影
ENTITY_STYLE      = __BP_SOURCE_IR__.entities[].visual 的兼容投影
ENTITY_POSITIONS  = __BP_SOURCE_IR__.entities[].position 的兼容投影
SCENE_CONFIG      = __BP_SOURCE_IR__.scene 的兼容投影
```

第一阶段不要立刻删除旧 `PHASES` 等变量，因为现有 hardgate、visual-assets parser、visual diff 仍依赖它们。

### 3. IR preflight

新增或扩展：

```text
scripts/source-scene-ir-preflight.cjs
engine/storyboard2html-hardgate.cjs
scripts/storyboard2html-smoke.cjs
```

preflight 检查：

- HTML 内存在 `window.__BP_SOURCE_IR__`
- IR JSON schema pass
- hash pass
- phase id 连续且唯一
- `showEntities` 中所有 entity 存在
- phase gate target/resource/entity 存在
- non-final phase 不允许 `click_entity` 或 ungated CTA
- `requiresJoystick=true` 时必须存在 joystick runtime evidence
- IR 能投影成兼容 `PHASES` / `ENTITY_STYLE` / `SCENE_CONFIG`

验收：

```bash
node scripts/source-scene-ir-preflight.cjs <generated.html> <out/report.json>
node scripts/storyboard2html-smoke.cjs <generated.html> <outdir> --dry-run
```

### 4. IR -> gameSchema deterministic compiler

新增：

```text
adapters/source-ir/index.js
adapters/source-ir/compile-to-gameschema.js
adapters/source-ir/compile-visual-assets.js
adapters/source-ir/compile-blueprint-context.js
test/source-ir-compiler.test.cjs
```

职责：

- `SourceSceneIR.entities` -> `gameSchema.entities`
- `SourceSceneIR.resources` -> `gameSchema.resources`
- `SourceSceneIR.phases` -> `gameSchema.phases`
- `SourceSceneIR.phases[].steps` -> `requiredInteractions`
- `SourceSceneIR.scene/entities/hud` -> `visualAssets`
- `SourceSceneIR` -> `playableSceneIr`

注意：这里不解析 JS 函数，不解析任意 side effects。

输出应兼容现有：

```text
spec.json
gameschema.json
asset-manifest.json
visual-runtime-contract.json
playable-scene-ir.json
blueprint-project.json
blueprint-gameschema.json
blueprint-specs.json
blueprint-plans.json
blueprint-proof-bundle.json
```

### 5. demo2spec 主路径改造成 IR bridge

改造：

```text
adapters/demo2spec/index.js
adapters/demo2spec/extract.js
adapters/demo2spec/blueprint-project.js
```

新逻辑：

```text
if HTML has __BP_SOURCE_IR__:
  use source-ir compiler
  skip JS function/side-effect semantic inference
else:
  use legacy demo2spec extractor
```

需要在输出报告里明确标记：

```json
{
  "semanticSource": "source-scene-ir",
  "legacyJsInferenceUsed": false
}
```

legacy fallback 继续保留，避免旧样例和外部 demo 断链。

### 6. 新增接受/同步编排脚本

新增：

```text
scripts/storyboard2html-accept.cjs
test/storyboard2html-accept-plan.test.cjs
```

建议用法：

```bash
node scripts/storyboard2html-accept.cjs <blueprint.json|input-bundle.json> <outdir> \
  --theme <theme> \
  --steps 40 \
  --verify-runner production \
  --visual-diff \
  [--export-unity] \
  [--programmer-delivery]
```

编排：

```text
1. storyboard2html-generate -> out/source.html
2. source-scene-ir-preflight -> out/source-ir-report.json
3. source-ir/demo2spec bridge -> out/spec.json + gameschema.json + asset-manifest.json + playable-scene-ir.json
4. Blueprint smoke -> out/blueprint-smoke/index.html
5. storyboad2html hardgate -> CUA / runtime evidence
6. storyboard-webgl-visual-diff -> source-vs-webgl phase screenshots
7. write acceptance-manifest.json
8. optional export-unity-project.sh
```

保持 `storyboard2html-generate.cjs` 纯生成；新 session 执行时应优先改推荐入口和文档，把 `accept` 作为 human/operator 的 canonical path。

### 7. hash chain / freshness gate

新增 acceptance manifest：

```json
{
  "kind": "blueprint.storyboard2html.acceptance",
  "schemaVersion": "1.0.0",
  "taskId": "proj_xxx",
  "sourceHtmlPath": ".../source.html",
  "sourceHtmlSha256": "...",
  "sourceSceneIrHash": "...",
  "playableSceneIrHash": "...",
  "gameSchemaHash": "...",
  "visualAssetsHash": "...",
  "webglIndexSha256": "...",
  "csharpSourceHash": "...",
  "unityExportHash": "...",
  "gates": {
    "sourceIrPreflight": true,
    "htmlInteractionHardgate": true,
    "runtimeContract": true,
    "productionCua": true,
    "sourceWebglVisualDiff": true,
    "unityExportFreshness": true
  }
}
```

改造：

```text
engine/stages/upload.cjs
scripts/export-unity-project.sh
lib/programmer-delivery-cleaner.cjs
```

导出 Unity 前检查：

- `server-data/project-sources/<taskId>/ACCEPTANCE_MANIFEST.json` 存在。
- manifest 的 `sourceHtmlSha256` 等于当前 source HTML。
- manifest 的 `csharpSourceHash` 等于即将导出的 C#。
- 如果 `--programmer-delivery`，最终包写入 `playable-flow-manifest.json` 和 `ACCEPTANCE_MANIFEST.json`。

## 迁移阶段

### Phase 0：基线与测试锁定

不改行为，只加测试和文档。

任务：

- 新增本方案文档。
- 新增 `source-scene-ir` schema 草案。
- 加测试确认 `storyboard2html-generate` 仍是纯生成。
- 加测试确认 `storyboard2html-accept` dry-run 计划包含 generate、preflight、source-ir compile、blueprint-smoke、visual-diff、hardgate。

验收：

```bash
node test/storyboard2html-contract.test.cjs
node test/storyboard2html-prompt.test.cjs
node test/luna-pipeline-composition.test.cjs
```

### Phase 1：IR schema + HTML extract

实现 `engine/source-scene-ir.cjs`。

验收：

```bash
node test/source-scene-ir.test.cjs
node scripts/source-scene-ir-preflight.cjs <fixture.html> /tmp/source-ir-report.json
```

### Phase 2：prompt 强制 IR

修改 `storyboard2html` prompt 和 contract，要求 HTML 输出 IR。

验收：

```bash
node test/storyboard2html-prompt.test.cjs
node test/storyboard2html-contract.test.cjs
```

手工验收：

```bash
node scripts/storyboard2html-generate.cjs <blueprint.json> /tmp/source.html --theme <theme>
node scripts/source-scene-ir-preflight.cjs /tmp/source.html /tmp/source-ir-report.json
```

### Phase 3：IR deterministic compiler

新增 `adapters/source-ir/`，能从 IR 直接产出 `gameschema.json`、`visualAssets`、`playableSceneIr`。

验收：

```bash
node test/source-ir-compiler.test.cjs
node adapters/source-ir/index.js <source.html|source-ir.json> <outdir>
```

### Phase 4：demo2spec 主路径切换

`adapters/demo2spec/index.js` 检测到 `__BP_SOURCE_IR__` 时走 source-ir compiler；否则走 legacy。

验收：

```bash
node test/demo2spec-playable-scene-ir-contract.test.cjs
node test/visual-assets-build-gate.test.cjs
node adapters/demo2spec/index.js <source-ir-html> <outdir> --blueprint-smoke --verify --verify-runner production --visual-diff
```

### Phase 5：accept 编排与 manifest

新增 `storyboard2html-accept.cjs`，作为推荐入口。

验收：

```bash
node test/storyboard2html-accept-plan.test.cjs
node scripts/storyboard2html-accept.cjs <blueprint.json> <outdir> --dry-run
```

### Phase 6：Unity export freshness gate

导出 Unity 前强制检查 acceptance manifest。

验收：

```bash
./scripts/export-unity-project.sh <taskId> --programmer-delivery
```

负向用例：

- 修改 source HTML 后不重跑 accept，export 应失败。
- 修改 C# source 后不更新 manifest，export 应失败。
- manifest 缺 `sourceSceneIrHash`，export 应失败或降级为显式 legacy 警告，不能静默通过。

## 推荐新 session 执行顺序

第一轮不要直接大改 `demo2spec`，先做可逆层：

1. 新增 `contracts/source-scene-ir.v1.json`。
2. 新增 `engine/source-scene-ir.cjs`。
3. 新增 `test/source-scene-ir.test.cjs`。
4. 新增 `scripts/source-scene-ir-preflight.cjs`。
5. 修改 `storyboard2html-prompt.cjs`，要求输出 `window.__BP_SOURCE_IR__`，但保留旧 `PHASES` 等兼容变量。
6. 跑 `storyboard2html` 相关测试。

第二轮再做 compiler：

1. 新增 `adapters/source-ir/compile-to-gameschema.js`。
2. 新增 `adapters/source-ir/index.js`。
3. `demo2spec/index.js` 加 IR 优先分支。
4. 保留 legacy parser。

第三轮做 accept + freshness：

1. 新增 `scripts/storyboard2html-accept.cjs`。
2. 写 `ACCEPTANCE_MANIFEST.json`。
3. `export-unity-project.sh` 加 manifest freshness gate。

## 风险与控制

### 风险 1：IR 太大，prompt 不稳定

控制：

- schema 必须短、字段强约束。
- `meshOps` 做数量上限，例如每实体最多 32 ops。
- 文案、素材 metadata 做长度上限。
- prompt 给完整 canonical example，禁止自由扩展字段。

### 风险 2：旧 HTML / 外部 demo 断链

控制：

- `demo2spec` 保留 legacy fallback。
- 输出里显式标记 `legacyJsInferenceUsed`。
- hardgate 对 legacy flow 可以继续用现有规则，但新 storyboard2html flow 必须强制 IR。

### 风险 3：IR 与 HTML runtime 不一致

控制：

- HTML runtime 必须从 `window.__BP_SOURCE_IR__` 派生 `PHASES` 和 runtime state。
- preflight 校验 IR hash。
- visual diff 比较 source HTML vs WebGL。
- hardgate 检查 `phaseEvidence` 的 source ir hash。

### 风险 4：Unity 交付包仍可能旧源混入

控制：

- `ACCEPTANCE_MANIFEST.json` 进入 `server-data/project-sources/<taskId>`。
- export 前校验 source/hash/C# hash。
- 程序员交付包内保留 manifest，但不保留 CUA/Blueprint/Luna 过程资产。

## 成功标准

一个 storyboard2html 任务只有满足以下条件才能算 accepted：

```text
source-scene-ir schema pass
source html hash pass
IR -> gameSchema deterministic compile pass
Blueprint smoke build pass
production CUA hardgate pass
source HTML vs WebGL visual diff pass
export freshness gate pass
acceptance manifest complete
```

关键指标：

- 新 IR 主路径 `legacyJsInferenceUsed=false`。
- phase 数量、phase id、showEntities、steps、gate 在 HTML / gameSchema / Blueprint / Unity export 中 hash 一致。
- C# codegen 不读取 JS 函数体。
- 修改 source HTML 后，不重跑 accept 不能导出 Unity。

## 新 session 可直接使用的任务提示

```text
请按 /opt/blueprint-editor/docs/todos/2026-06-07-source-ir-stable-js-to-csharp-plan.md 执行 Phase 1：
新增 SourceSceneIR schema、validator、preflight 脚本和测试。
不要删除 demo2spec legacy 路径，不要改完整 build 链路。
完成后跑 source-scene-ir、storyboard2html-contract、storyboard2html-prompt、luna-pipeline-composition 相关测试。
```
