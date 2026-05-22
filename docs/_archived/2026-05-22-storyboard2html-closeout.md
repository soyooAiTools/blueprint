# storyboard2html bridge closeout（2026-05-22）

## 结论

`#storyboard2html` 本轮把「storyboard 生成 HTML」接进了现有 demo2spec -> Blueprint prebuilt schema -> Luna build -> CUA observe -> hardgate 链路，并用 farming / tower-defense 两套 demo 走通端到端 smoke。

本轮发布边界：

- `soyooAiTools/blueprint@880bbcd`：HTML contract、prompt input/smoke/hardgate、prompt 触发器约束、multi-source collect 代码生成修复、回归测试。
- `soyooAiTools/demo2spec@874121e`：解析 storyboard2html `PHASES`、`showEntities`、结构化 trigger，兼容旧 condition-string trigger，过滤内部 runtime 字段。

## HTML 合同

生成 HTML 必须同时提供静态合同和 runtime 合同：

- `PHASES[]`：每个 phase 描述 `id`、`title`、`showEntities`、`trigger`。
- `setTip(...)`：可 grep 的 UI 文案入口，供 demo2spec 兜底提取。
- named phase functions：作为无 PHASES 兜底时的结构线索。
- `window.__gameState`：包含 `phase`、`completedPhases`、`entity_states`、`ui_state`、`camera_state`、`phaseEvidence` 等 runtime 观察面。
- `phaseEvidence.phase{N}.{moduleId}`：每个 triggered module 写结构化 snapshot，`_meta.schemaVersion="1.0.0"`，`_meta.sourcePlatform="html"`。

Trigger 规则：

- 优先输出 `trigger.triggers[]`，类型包括 `timer`、`resource_collected`、`entity_state_reached`、`compound`。
- 禁止把条件塞成 `conditions:["timer(0.8s)"]` 这类字符串数组。
- `entity_state_reached.state` 必须是整数状态值；`built` 对应 `2`，不要输出 `state:"built"`。
- demo2spec 仍保留 condition-string fallback，作为 defense-in-depth；prompt 侧继续禁止这种形态。

## 关键文件

Blueprint 主仓：

- `contracts/storyboard2html-html-contract.v1.json`
- `engine/storyboard2html-contract.cjs`
- `engine/storyboard2html-prompt.cjs`
- `scripts/storyboard2html-input.cjs`
- `scripts/storyboard2html-smoke.cjs`
- `scripts/storyboard2html-generate.cjs`
- `scripts/storyboard2html-hardgate.cjs`
- `adapters/templates/interactions/multi-source-collect.cjs`
- `test/storyboard2html-contract.test.cjs`
- `test/storyboard2html-prompt.test.cjs`
- `test/skeleton-template-regression.test.cjs`

demo2spec skill repo：

- `extract.js`
- `convert-to-gameschema.js`
- `index.js`
- `test/snapshot-schema.test.cjs`

## 验证记录

Blueprint 回归：

```bash
node test/storyboard2html-contract.test.cjs
node test/storyboard2html-prompt.test.cjs
node test/run-all.cjs
```

最终记录：`node test/run-all.cjs` 通过，`pass=301 fail=0`。

demo2spec 回归：

```bash
node test/snapshot-schema.test.cjs
```

最终记录：通过。

端到端 smoke：

| demo | artifact | phase | signal | validation | triggered_full_rate | antiAutoplay |
|---|---|---:|---:|---|---:|---:|
| farming | `work/storyboard2html-e2e/farming/smoke-rerun` | 3/3 | 14/14 | passed | 1.0 | 1.0 |
| tower-defense | `work/storyboard2html-e2e/tower-defense/smoke` | 3/3 | 15/15 | passed | 1.0 | 1.0 |

Smoke 链路：

```text
storyboard2html-generate.cjs
  -> demo2spec/index.js --blueprint-smoke --verify
  -> Blueprint prebuilt gameSchema
  -> Luna build
  -> CUA observe
  -> storyboard2html-hardgate.cjs
```

## 收口注意

- `multi-source-collect` 必须跳过 skeleton 已声明的 entity `GameObject` 字段，避免多源采集模板和 skeleton 生成重复声明。
- demo2spec 解析出的 R5 resources 不能包含 `_state`、camera、visibleEntities、internal runtime assignments。
- hardgate 主事实是 `phaseEvidenceSummary.validation.passed`、triggered `present_full`、`antiAutoplayHeld`，不要只看 HTML 能打开或 CUA `passed`。
- 运行态 artifact 留在 `work/storyboard2html-e2e/**`；repo 只保存合同、脚本、测试和归档文档。
