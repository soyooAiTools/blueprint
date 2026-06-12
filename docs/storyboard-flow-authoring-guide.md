# Storyboard Flow Authoring Guide

更新时间：2026-06-12

本规范用于策划填写可编辑流程图。Flow 是人工语义基准，不是直接交付物；进入生产链路前必须通过 Flow authoring preflight、SourceSceneIR preflight、SourceIR build、runtime contract、guideText parity 和 visual/fidelity 验证。

## 文件入口

- 前端：项目详情页 -> 流程图
- 模板：`fixtures/storyboard-flow-template.json`
- JSON contract：`contracts/storyboard-flow-prototype.v1.json`
- 校验 CLI：

```bash
cd /opt/blueprint-editor
node scripts/storyboard-flow-source-ir.cjs <flow.json> <out-dir> --validate-only
```

## 必填结构

Flow JSON 使用：

```json
{
  "schemaVersion": "storyboard-flow-prototype.v1",
  "kind": "blueprint.storyboardFlowPrototype",
  "projectName": "Project",
  "entities": [],
  "resources": [],
  "phases": []
}
```

### phases[]

每个 phase 是一个 runtime phase，目标数量通常为 10-13。

必填字段：

- `id`：稳定机器 id，例如 `phase03_cook`。
- `order`：播放顺序，从 1 开始。
- `title`：人类可读标题。
- `guideText`：屏幕可见玩家提示，后续 SourceIR/WebGL 必须继承。
- `requiredInteractions`：动作 DSL，是真正会进入 SourceSceneIR 的行为事实。
- `completeCondition`：完成条件。
- `visibleEntities`：该 phase 画面上应该出现的实体 id。

常用可选字段：

- `action`：用于前端分类和默认交互生成，例如 `collect`、`deliver`、`unlock`。
- `target`：主操作目标实体。
- `resource`：主资源。
- `amount`：资源数量。
- `cost`：解锁/升级消耗；如果同 phase 没有显式 `transfer/deliver/combine` 支出，转换器会把它作为隐式资源支出。
- `position`：流程图节点坐标。
- `visualNotes` / `notes`：只作备注，不会自动生成 gameplay step。

### entities[]

实体目录用于布局、可见性、标签和目标绑定。

```json
{ "id": "Fryer", "label": "炸炉", "kind": "station" }
```

建议稳定维护：

- `Player`：玩家角色。
- `CtaButton`：最终下载按钮。
- 每个可移动、可点击、可解锁、可升级、可展示的目标。

### resources[]

资源目录用于库存、成本、交付和奖励。

```json
{ "id": "Coin", "label": "金币", "carrierEntity": "MoneyRegister", "initial": 0 }
```

`carrierEntity` 指资源在画面上默认绑定的实体。缺失时转换器会尝试补齐，但校验会给 warning。

## requiredInteractions DSL

每行一个动作：

```text
move_to:Target
collect:Resource:Amount
produce:Resource:Amount
reward:Resource:Amount
deliver:Resource:Target:Amount
transfer:Resource:Target:Amount
combine:Resource:Target:Amount
unlock:Target
build:Target
upgrade:Target:Level
show:Target
spawn:Target
hide:Target
select:Target
attack:Target
wait:Seconds
click:CtaButton
```

规则：

- `click:*` 只能用于最终 CTA phase。
- 只有显式 `combine:*` 会产生合成步骤；`visualNotes` 里的“合成、碰撞、merge”等字样不会生成合成。
- 涉及资源的动作必须写资源 id。
- 涉及目标的动作必须写目标 id。

## Flow 与 storyboard2html 对比

当 storyboard2html 已生成 source HTML 后，用 Flow 作为人工语义基准生成差异报告：

```bash
cd /opt/blueprint-editor
node scripts/storyboard-flow-diff.cjs <flow.json> <source-html> <out-dir>
```

报告会比较：

- runtime phase 数量
- resource catalog
- 每个 phase 的 `guideText`
- primary target
- resource set
- completion gate
- step sequence

`blocker` 表示结构无法对齐；`warn` 表示 storyboard2html 与人工 Flow 有语义差异，应回到 parser/spec/source HTML 链路修正。

## 小主厨餐厅样例关注点

以 `/nickTemp/第一批需求/MC原创_3D流水线小主厨解锁餐厅.pdf` 为例，Flow 应显式表达：

- 接单、取食材、烹饪、交付、收钱、进解锁圈、展示新餐厅、继续生产/交付、CTA。
- 金币成本通过 `resource: "Coin"` + `cost` 或显式 `transfer:Coin:UnlockCircle:<amount>` 表达。
- 不存在合成玩法时，不写 `combine:*`；备注里出现碰撞或拖动不等于合成。
- 重复生产/交付 phase 要写清楚不同目标或上下文，避免下游退化成 `产出 -> 交付 -> 扩建` 的循环。
