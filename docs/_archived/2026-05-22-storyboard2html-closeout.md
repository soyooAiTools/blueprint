# storyboard2html bridge closeout（2026-05-22）

## 结论

`#storyboard2html` 本轮把「storyboard 生成 HTML」接进了现有 demo2spec -> Blueprint prebuilt schema -> Luna build -> CUA observe -> hardgate 链路，并用 farming / tower-defense 两套 demo 走通端到端 smoke。

本轮发布边界：

- `soyooAiTools/blueprint@880bbcd`：HTML contract、prompt input/smoke/hardgate、prompt 触发器约束、multi-source collect 代码生成修复、回归测试。
- `soyooAiTools/demo2spec@874121e`：解析 storyboard2html `PHASES`、`showEntities`、结构化 trigger，兼容旧 condition-string trigger，过滤内部 runtime 字段。
- `soyooAiTools/blueprint@6f1224e`：storyboard2html HTML hardgate 强制固定虚拟摇杆 + arrival/proximity gate，禁止 non-final `click_entity`、直接 click/key 完成 phase、setTimeout phase 自走。
- 后续补强：hardgate/prompt 已收紧为真实 Three.js WebGL 3D + 任意位置浮动虚拟摇杆；Canvas/isometric 伪 3D 和固定左下角-only 摇杆不再是合格口径。
- `soyooAiTools/blueprint@b619cb8`：prompt L1/L5 放宽最终 CtaButton 为 arrival-gated dual-path，允许 `near_entity` arrival-only 或 arrival-gated `click_entity`，两条路径都必须写 `cta_finish`。

## 2026-05-22 摇杆交互系统化补强

`卖水` PDF 任务暴露出两类不能只靠单个 HTML 修复的问题：早期产物会退化成 autoplay-disguised-as-game，后续 v2 虽有交互但仍偏向直接点击/键盘兜底，不符合「固定轮盘控制角色到达位置后触发逻辑」的目标玩感。

现在 canonical 交互/视觉口径是：

- 视觉必须是真实 Three.js 3D：`THREE.Scene` + `THREE.WebGLRenderer` + 透视相机 + 灯光 + 复合 mesh；Canvas/isometric 伪 3D 或 DOM 平面示意不再算通过。
- 控制方式必须是任意位置浮动虚拟摇杆：用户在任意非 HUD 区域 `pointerdown` 时，摇杆底盘移动/显示到该触点作为原点；`pointermove` / `pointerup` / `pointercancel` 更新和归零。
- 摇杆 vector 必须每帧推动 `Player` 真实位置变化，并在 `phaseEvidence` 写 `player_input_joystick`。
- 每个 gameplay phase 的逻辑触发必须走 arrival-gate：玩家拖摇杆让角色进入目标 entity 判定圈，才触发 `proximity_trigger` / `move_to_target` / `collect_on_near` / `deliver_to_target` / `inventory_wallet` 等后续模块。
- non-final phase 禁止 `click_entity` trigger，禁止 entity click handler 直接推进 phase，禁止 keydown 直接 mutate phase。
- 最终阶段必须以 `CtaButton` 为目标且 arrival-gated；允许 `trigger.type:"near_entity"` 的 arrival-only 结束，也允许 `trigger.type:"click_entity"`，但 click handler 必须先校验角色已经进入 CtaButton 判定圈。

对应 hardgate 输出必须重点看 `html-interaction-hard-gates.details`：

- `hasJoystickControl=true`
- `autoProgressPatternCount=0`
- `directCompletionPatternCount=0`
- `nonFinalClickEntityCount=0`
- `nonFinalMissingJoystickEvidenceCount=0`
- `ctaUngatedHandlerCount=0`

`卖水` v3 基线产物位于 Jonny workspace `work/storyboard2html/dec6c16d/`，上传包名为 `water-seller-storyboard2html-v3-artifacts.tar.gz`。验证结果：Playwright 拖摇杆跑完 8/8 phases，demo2spec 解析为 8 phases / 19 entities / 5 resources / 0 gaps，Blueprint smoke/Luna build 通过，hardgate v3 通过。

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
- storyboard2html 试玩的 gameplay trigger 还要服从摇杆 arrival-gate 约束：non-final phase 不写 `click_entity`；最终 `CtaButton` 可用 `near_entity` 或 arrival-gated `click_entity`，但无论哪种都必须写 `cta_finish`。

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
