# 2026-06-11 First Batch Generic Storyboard Delivery Closeout

## 背景

用户要求第一批 4 个试玩广告项目完成 HTML、WebGL、Unity 完整工程交付，并指出两个系统性问题：

- 屏幕可见标签不应显示 `Actor` / `Item` 这类通用机器名，应按 phase / 分镜语义显示 `玩家`、`配菜`、`敌人`、`面包` 等可读 label。
- `MC原创_3D流水线拉面` 的 HTML 在第 9 个 phase 后直接跳到第 13 个 phase，怀疑不是单项目问题，需要系统性排查。

交付样本：

- `firstbatch-action-01`：`MC原创_3D流水线小主厨解锁餐厅`
- `firstbatch-action-02`：`MC原创_3D流水线拉面`
- `firstbatch-action-03`：`MC原创_甜品餐厅物品二合试玩`
- `firstbatch-action-04`：`Nova原创_挂机合成汉堡店`

## 根因

1. PDF/storyboard 解析此前仍残留项目名词或主题 profile 的思路，容易把“汉堡、餐厅、拉面、甜品”等具体内容写成一次性 parser 分支。这样短期能过样本，长期会扩大分支数量，并让 label/interaction 的来源不一致。
2. generic 解析保留 `Player` / `Item` / `Producer` 等稳定机器 id 是合理的，但缺少足够强的中文 `label` 推断和回归测试，导致可见世界标签可能退化成 id。
3. `wait`、`produce`、`reward`、`select`、`combine`、`transfer`、`unlock`、`show` 等通用动作在 SourceIR -> PlayableSceneIR -> overlay runtime -> liveness 之间保留不完整，部分无目标或终局动作容易被压缩、跳过或依赖旧 legacy projection。
4. Unity 程序员交付包使用 `server-data/project-sources/<taskId>` 与 `server-data/projects/<taskId>.json`，如果只刷新 WebGL 目录，Unity 导出会继续读旧 SourceIR/旧锚点，出现 WebGL 已修好但 Unity 工程仍旧的错位。

## 修复

- `scripts/process-storyboard-pdf-samples.cjs`
  - 移除按项目名词或主题内容扩展 profile parser 的方向。
  - `storyboard-pdf-profile-rules.json` 收口为通用 action rules：`move`、`collect`、`transfer`、`deliver`、`select`、`combine`、`show`、`produce`、`upgrade`、`unlock`、`reward`、`attack`、`wait`、`cta`。
  - 从项目名、分镜标题、场景文本推断中文可见 label；机器 id 保持稳定，屏幕文案使用 `entities[].label` / `ENTITY_STYLE.label`。
- `engine/storyboard-ir.cjs`、`engine/storyboard-spec-compiler.cjs`、`engine/storyboard-source-ir-compiler.cjs`
  - 扩展 generic action DSL 到 spec 和 SourceSceneIR。
  - 终局 CTA 只作为最后一个 runtime phase，不吞并前面的 gameplay phases。
- `engine/source-scene-ir.cjs`、`adapters/source-ir/compile-to-gameschema.js`
  - 保留通用 step `kind`、`resource`、`entity`、`state`、`level`、`seconds`、`ctaId` 等字段，避免 legacy projection 丢语义。
- `engine/source-ir-preview-renderer.cjs`、`adapters/source-ir/visual-overlay.js`、`engine/source-ir-phase-liveness.cjs`
  - 支持无目标动作的完成条件，包括 `wait` 计时、`produce/reward` 资源增长和 `cta_finish` 终局。
  - 补齐通用动作的 phase evidence / liveness 计算。
- `worker/worker-playableagent.js`
  - manual joystick / flow probe 更稳地处理 xvfb、观察模式和无目标动作。
- `lib/programmer-delivery-cleaner.cjs`
  - 修复 phase-scoped generic entity 名称规范化。
  - 程序员交付版 Unity 场景 materialize initial phase 时允许已有可见 transform 计为 positioned，避免 `Item__phase01_target` 这类 phase anchor 被误判 missing。

## 验证

定向回归通过：

```bash
node test/storyboard-pdf-generic-parser.test.cjs
node test/source-ir-compiler.test.cjs
node test/source-ir-preview-renderer.test.cjs
node test/source-ir-visual-overlay.test.cjs
node test/source-scene-ir.test.cjs
node test/source-ir-phase-liveness.test.cjs
node test/playable-scene-ir.test.cjs
node test/source-ir-playable-scene-ir-contract.test.cjs
node test/worker-playableagent-patch.test.cjs
node test/playableagent-manual-joystick-probe.test.cjs
node test/worker-playableagent-xvfb.test.cjs
node test/programmer-delivery-cleaner.test.cjs
node test/guard-visual-fallback.test.cjs
```

4 个项目最终验收：

| taskId | phases | strict CUA | signal | visual diff | Unity validation |
| --- | ---: | --- | --- | --- | --- |
| `firstbatch-action-01` | 13 | PASS `13/13` | `82/82` | PASS `13/13` | PASS |
| `firstbatch-action-02` | 13 | PASS `13/13` | `79/79` | PASS `13/13` | PASS |
| `firstbatch-action-03` | 13 | PASS `13/13` | `87/87` | PASS `13/13` | PASS |
| `firstbatch-action-04` | 10 | PASS `10/10` | `54/54` | PASS `10/10` | PASS |

`MC原创_3D流水线拉面` SourceIR phase 序列确认连续：

```text
phase1, phase2, phase3, phase4, phase5, phase6, phase7, phase8, phase9, phase10, phase11, phase12, phase13
```

可见 label 抽检：

- 小主厨：`Player:玩家`, `Item:食物`, `Target:餐厅`, `Consumer:顾客`
- 拉面：`Player:玩家`, `Item:配菜`, `Target:订单小票`, `Container:面碗`, `Producer:传送带`
- 甜品：`Player:玩家`, `Item:甜品`, `Target:餐厅`, `UpgradePoint:合成链`
- 汉堡：`Player:玩家`, `Item:汉堡`, `Target:收银台`, `Consumer:顾客`, `Reward:金币`

## 交付产物

原始交付目录：

```text
/nickTemp/第一批需求_交付
```

按用户要求整理的独立完整交付目录：

```text
/nickTemp/第一批需求_四项目完整交付
```

每个项目目录包含：

- `source_html/source-ir-preview.html`
- `webgl/index.html`
- `unity/<taskId>-unity-project.tar.gz`
- `unity/extracted/<taskId>-unity-project/Assets`
- `unity/extracted/<taskId>-unity-project/Packages`
- `unity/extracted/<taskId>-unity-project/ProjectSettings`

## 教训

- generic PDF/storyboard 扩展应优先补通用 action rules 和 fixture tests，不再按具体项目名词、场景名词或主题 profile 做分支。
- 稳定机器 id 与可见 label 必须分层：id 可保留 `Item`，但屏幕 label 必须来自分镜语义并进入 `entities[].label`、`resources[].label`、`ENTITY_STYLE.label`。
- 交付前不能只看 CUA；必须同时看 SourceIR renderer ownership、runtime binding、source/WebGL visual diff 和 Unity `DELIVERY_VALIDATION.json`。
- Unity 导出前必须确认 `server-data/project-sources/<taskId>` 与 `server-data/projects/<taskId>.json` 同源，否则程序员工程会读旧锚点。
