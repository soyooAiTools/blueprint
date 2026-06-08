# Blueprint Skill 与 Blueprint Editor 项目现状说明

生成时间：2026-06-08（Asia/Shanghai）  
用途：给同事讨论 Blueprint skill、Blueprint Editor 当前流水线、近期任务状态、耗时瓶颈和下一步优化方案。

## 1. 一句话结论

当前 Blueprint 已经从旧 adapter 活跃链路迁到 `source-ir` 模块化链路。模块化主要降低生成混乱和失败概率，但完整任务耗时仍长，核心原因是完整验收链路仍包含串行的 LLM 修复、Luna/WebGL 构建、Runtime Contract、真实浏览器 CUA、manual joystick flow、storyboard/WebGL visual diff 等环节。

建议后续讨论重点不要继续泛化为“再模块化一点”，而是改成双通道：

- `fast lane`：相位级影响分析 + checkpoint CUA + visual canary + 并行 gate，快速出可看 preview。
- `cert lane`：后台跑完整 CUA/visual/fidelity 证书，作为最终发布门禁。

## 2. 主要地址与路径

| 类型 | 地址 / 路径 | 说明 |
|---|---|---|
| Blueprint skill 源仓库 | `https://github.com/soyooAiTools/blueprint-skill` | skill 文档源码仓库 |
| 本机 skill checkout | `/opt/blueprint-skill/` | 当前查看到的 skill 文档，`SKILL.md` 已有本地修改 |
| Codex canonical skill | `/root/.codex/skills/blueprint/` | Codex 实际安装 skill 副本 |
| Blueprint 主项目 | `/opt/blueprint-editor/` | 主实现代码库，仓库名 `soyooAiTools/blueprint` |
| Luna 模板工程 | `/opt/luna-base-template/` | Luna playable template |
| CUA 验证器 | `/root/cua-agent/` | browser/CUA 自动验证器 |
| 任务数据库 | `/opt/blueprint-editor/server-data/blueprint.db` | `tasks` / `task_history` / `worker_heartbeats` |
| 输入分镜目录 | `/nickTemp/分镜目录/` | 用户分镜 PDF 和本地批处理输出 |
| 本地输出目录 | `/nickTemp/分镜目录/_blueprint_outputs/` | 本地 batch/source-ir/visual/cert 输出 |
| CUA 输出目录 | `/opt/blueprint-editor/worker/cua-results/` | manual probe、visual audit、video audit 等结果 |
| 线上预览基址 | `https://playcools.top/webgl/<taskId>/index.html` | 正式任务 preview URL |

近期重点 preview：

| 项目 | taskId | DB 状态 | Preview |
|---|---|---|---|
| PA守护家园 | `proj_1780206159599_6uzhan` | `done` | `https://playcools.top/webgl/proj_1780206159599_6uzhan/index.html` |
| 卖水 | `proj_1780207650108_kz733y` | `done` | `https://playcools.top/webgl/proj_1780207650108_kz733y/index.html` |
| 太空捡垃圾分镜 | `proj_1780215351440_lnpnqt` | `cancelled` | `https://playcools.top/webgl/proj_1780215351440_lnpnqt/index.html` |
| 太空捡垃圾分镜 | `proj_1780223872392_tnnnjx` | `failed` | 无 preview |

说明：DB 里的 `created_at` / `updated_at` 看起来按 UTC 写入；北京时间需加 8 小时。

## 3. Blueprint Skill 作用

`blueprint` skill 用于指导 Codex 处理 Blueprint Editor 相关工作，包括：

- storyboard / PDF / image storyboard 转 Blueprint。
- `storyboard2html` 生成 HTML 效果稿。
- `source-ir` 转 Blueprint / Luna / WebGL。
- worker-coder / worker-client / Luna build。
- CUA 验证、Runtime Contract、manual joystick probe。
- storyboard/WebGL visual diff、fidelity 闭环。
- 注释中文化、程序员交付包清理。
- 线上任务进度、失败分析和回归修复。

skill 里的默认定位原则：

1. 先查 skill references / incidents。
2. 再查 `/opt/blueprint-editor` 主项目。
3. 复用已有 pipeline / helper / gate。
4. 没有现成方案再扩展实现。

## 4. 当前 Pipeline 总览

```text
分镜文件 / PDF / 图片
  -> Stage 1: 分镜解析
     adapters/storyboard-parser.cjs
     adapters/storyboard-pdf.cjs

  -> Stage 2: storyboard2html
     scripts/storyboard2html-input.cjs
     scripts/storyboard2html-generate.cjs
     scripts/storyboard2html-smoke.cjs
     engine/storyboard2html-*.cjs

  -> Stage 3: source-ir
     adapters/source-ir/index.js
     engine/source-scene-ir.cjs
     engine/source-ir-preview-renderer.cjs
     adapters/source-ir/* contract / proof / visual / verify modules

  -> Stage 4: Blueprint/Luna/WebGL
     adapters/source-ir/run-blueprint-smoke.js
     worker/linux-bridge-build.js
     worker/worker-bridge-build.js
     worker/worker-playableagent.js

  -> 验收
     runtime-contract
     CUA observe
     manual joystick probe
     manual joystick flow probe
     storyboard visual/video audit
     storyboard-webgl-visual-diff
```

常用命令骨架：

```bash
cd /opt/blueprint-editor

# blueprint/input bundle -> storyboard HTML
node scripts/storyboard2html-input.cjs <blueprint.json> <storyboard2html-input.json>
node scripts/storyboard2html-generate.cjs <blueprint.json|input-bundle.json> <out.html>

# HTML/SourceIR -> Blueprint smoke / production verify / visual diff
node adapters/source-ir/index.js <source-ir-renderer.html> <outdir> \
  --blueprint-smoke --verify --verify-runner production --steps 30 --visual-diff

# SourceIR build wrapper，支持只跑部分 visual phases
node scripts/source-ir-build.cjs <source-ir.json|source-ir-renderer.html> <outdir> \
  --blueprint-smoke --verify --verify-runner production --visual-diff --visual-phases phase8

# Debug-only checkpoint CUA，不替代 production full-flow CUA
node scripts/cua-checkpoint-probe.cjs <webgl-build-dir> --phase phase7 --max-phases 1
```

## 5. SourceIR / 旧 Adapter 迁移状态

### 5.1 活跃代码状态

当前主项目活跃代码已经迁到 `source-ir`：

- `/opt/blueprint-editor/adapters/source-ir/`
- `/opt/blueprint-editor/scripts/source-ir-build.cjs`
- `/opt/blueprint-editor/engine/source-scene-ir.cjs`
- `/opt/blueprint-editor/engine/source-ir-preview-renderer.cjs`
- `/opt/blueprint-editor/test/source-ir-*.test.cjs`

本地扫描结果：

- `/opt/blueprint-editor/adapters`
- `/opt/blueprint-editor/engine`
- `/opt/blueprint-editor/scripts`
- `/opt/blueprint-editor/test`

这些活跃代码 / 测试路径中没有命中旧 adapter 关键字。

### 5.2 仍存在的历史名称

仍能看到旧 adapter 字样的地方主要有三类：

1. 历史输出物：`/nickTemp/分镜目录/_blueprint_outputs/.../<legacy-adapter-full>/`。
2. 历史 CUA / telemetry taskId：例如部分 `unity-verify-summary.json` 里仍有 legacy production verify 命名。
3. skill 的 incident/reference 文档：`/opt/blueprint-skill/INCIDENTS.md` 和 `references/build-pipeline.md` 仍有历史叙述。

这不代表当前 active runtime 还在走旧 adapter，但讨论时建议明确下一步是否要做“历史产物术语收口”。如果要求历史输出和 telemetry 也字面收口，需要额外迁移或归档这些非源码产物。

### 5.3 当前 worktree 风险

`/opt/blueprint-editor` 处于大量未提交变更状态，包括：

- 删除旧 adapter 目录。
- 新增/迁移 `adapters/source-ir/*`。
- 重命名测试到 `test/source-ir-*.test.cjs`。
- 修改 `engine`、`scripts`、`worker`、`docs` 多处实现。

`/opt/blueprint-skill/SKILL.md` 也有本地修改。

结论：当前适合讨论和继续验证，但在发版/合并前需要专门做一次 diff review、测试清单复跑和命名收口检查。

## 6. 最近任务状态

### 6.1 PA守护家园

- 输入：`/nickTemp/分镜目录/PA-守护家园-分镜(3).pdf`
- 正式任务：`proj_1780206159599_6uzhan`
- DB 状态：`done`
- Preview：`https://playcools.top/webgl/proj_1780206159599_6uzhan/index.html`
- 最后 DB 记录：2026-06-08 04:52:21 UTC，`Build complete`
- 备注：最后一次 resume 记录是 runtime contract passed，heavy CUA skipped；此前本地/验收链路已有 production CUA、manual joystick、storyboard visual audit 通过证据。

### 6.2 卖水

- 正式任务：`proj_1780207650108_kz733y`
- DB 状态：`done`
- Preview：`https://playcools.top/webgl/proj_1780207650108_kz733y/index.html`
- 本地 SourceIR delivery 证据：
  - 路径：`/nickTemp/分镜目录/_blueprint_outputs/deliveries/卖水-source-ir-only-delivery-20260607-after-visual-ir/webgl/unity-verify-summary.json`
  - `passed: true`
  - `phaseCoverage: 8/8`
  - `signalCoverage: 52/52`
  - runtime contract passed
  - manual joystick probe passed
  - manual joystick flow probe passed

### 6.3 太空捡垃圾分镜

正式 DB 任务：

- taskId：`proj_1780215351440_lnpnqt`
- DB 状态：`cancelled`
- Preview：`https://playcools.top/webgl/proj_1780215351440_lnpnqt/index.html`
- 取消点：已经到 preview/deep validation，卡在视觉预检。
- 失败症状：多轮 `All frames are identical with no visible movement/progression of objects`。
- 最后取消时间：2026-06-05 05:00:34 UTC。

本地后续 rerun 证据：

- CUA / runtime cert：
  - `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空捡垃圾分镜/rerun-final-cert-after-visual/blueprint-smoke/unity-verify-summary.json`
  - `passed: true`
  - `phaseCoverage: 8/8`
  - `signalCoverage: 56/56`
  - runtime contract passed
  - manual joystick probe passed
  - manual joystick flow probe passed
- full visual diff：
  - `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空捡垃圾分镜/rerun-conditional-baseline-full-visual-settle1800/report.json`
  - `passed: true`
  - phase1 至 phase8 均 passed

结论：正式 DB 任务没有完成，是 `cancelled`；但本地补跑已经有后续通过证据。讨论时要分清“线上任务状态”和“本地修复验证状态”。

## 7. 任务耗时与 LLM 占比估算

口径：按 `tasks.timeline_json` 粗分类相邻事件间隔，超过 1 小时的跨天/等待间隔不计入 active time；这是工程估算，不是精确审计。

| taskId | 项目 | 状态 | active time | LLM/review/repair | build/compile | verify/visual/CUA | 备注 |
|---|---|---:|---:|---:|---:|---:|---|
| `proj_1780206159599_6uzhan` | PA守护家园 | done | 103.3m | 56.6m / 55% | 13.3m / 13% | 32.6m / 32% | 多轮修复 + 验证 |
| `proj_1780207650108_kz733y` | 卖水 | done | 76.3m | 38.7m / 51% | 15.5m / 20% | 20.3m / 27% | 有 code retry |
| `proj_1780215351440_lnpnqt` | 太空捡垃圾分镜 | cancelled | 44.6m | 26.6m / 60% | 7.0m / 16% | 9.5m / 21% | 线上 cancelled，跨天 gap 很长 |
| `proj_1780223872392_tnnnjx` | 太空捡垃圾分镜 | failed | 86.6m | 9.3m / 11% | 13.5m / 16% | 42.4m / 49% | fidelity/visual 成本高 |

经验区间：

- clean pass：约 25-35 分钟。
- 普通 1-3 轮 repair：约 45-75 分钟。
- 视觉/CUA 难例：约 90-120 分钟以上。
- 已有 SourceIR/HTML 后只做 smoke/production verify：约 5-15 分钟，但如果 manual flow 很长会超过 10 分钟。

## 8. 为什么模块化后仍然慢

模块化解决的是“生成结构混乱”和“错误归因困难”，不是直接消灭完整验收成本。当前慢主要来自：

1. LLM 仍在修复环里占大头，尤其 codegen、review、visual/CUA feedback 后的 recode。
2. Luna/WebGL 构建仍要跑，且部分路径会清理编译缓存。
3. CUA 是真实浏览器环境，包含 observe、manual joystick probe、manual joystick flow probe。
4. visual diff 要逐 phase 截图、等待 settle、做像素/语义对齐。
5. 多个 gate 当前仍偏串行：一个失败后再进入下一轮 LLM 和下一次完整验证。
6. 一旦失败症状重复，成本按 `失败轮数 × 每轮完整验证成本` 放大。

## 9. 已有可利用的加速抓手

主项目里已经有一些可复用入口，不需要完全重造：

- `scripts/source-ir-build.cjs`
  - 支持 `--visual-phases phase8|6-8|phase6,phase8`。
  - 可以只跑 affected phases 的 visual diff。
- `scripts/validation-router.cjs`
  - 已经能规划 risk-based validation。
  - 支持 checkpoint build dir / checkpoint phase。
- `scripts/cua-checkpoint-probe.cjs`
  - debug-only local manual joystick checkpoint。
  - 明确不是 production full-flow CUA 替代。
- `worker/worker-playableagent.js`
  - `selectManualJoystickPhaseWindow`
  - `runManualJoystickCheckpointProbe`
  - `__driveToPhase` checkpoint 驱动。
- `engine/stages/static-pre-review.cjs`
  - codegen 后、review 前的 deterministic static gate。
  - 先跑 pre-repair，再 reject 残留 blocking issue。
- `worker/fix-recipes/`、`worker/fix-recipes.json`、`worker/promoted-rules.json`
  - 已有失败模式知识库，可做 recipe-first router。
- `worker/codex-code-coder.js`
  - 已记录 prompt cache 相关 hash，但还没有系统化 hit-rate/latency 指标。

## 10. 建议的优化方案

### P0：Fast Lane / Cert Lane

目标：先出可看 preview，完整证书后台跑。

Fast lane 内容：

- SourceIR preflight。
- phase liveness。
- runtime contract quick check。
- affected phase visual canary。
- checkpoint CUA for affected phase。
- smoke-level manual joystick probe。

Cert lane 内容：

- full production CUA。
- full manual joystick flow。
- full storyboard/WebGL visual diff。
- fidelity-source-diff。
- storyboard visual/video audit。

讨论点：产品/交付上能否接受“preview ready”和“cert passed”两个状态。

### P0：相位级影响分析

做一个 phase selector：

- 输入：SourceIR diff、changed files、failed fingerprint、上次失败 phase。
- 输出：需要验证的 phases，例如 `phase7`、`phase7-8`、`phase6,phase7,phase8`。
- 接入：`source-ir-build --visual-phases` + `cua-checkpoint-probe --phase`。

收益：repair loop 不再每次从 phase1 验到 phase8。

### P0：并行 Gate Runner

构建 artifact 后并行跑：

- runtime contract。
- visual canary。
- checkpoint CUA。
- source phase liveness。

任一 hard fail 后取消其他 gate，把失败反馈尽快送回 repair。

收益：墙钟时间下降，尤其是多个 gate 互不依赖时。

### P1：Recipe-first 修复

在 LLM 前加一层 fingerprint router：

- 命中 `fix-recipes` / `promoted-rules`：走确定性 patch 或确定性 feedback。
- 未命中：再调用 LLM。
- 重复 fingerprint：限制重复修复轮数，避免无效消耗。

收益：减少 LLM 调用和重复 repair 时间。

### P1：Patch-only LLM

把 LLM 输入从“全项目重写/大上下文”收窄为：

- 失败 phase。
- 失败 gate。
- 相关模块。
- 结构化 invariant。
- 期望输出为 patch / AST op / bounded edit。

收益：减少 token、降低 hallucination、方便静态验证。

### P1：构建与浏览器缓存

可讨论的方向：

- content-addressed build cache：
  - `sourceSceneIrHash`
  - `templateHash`
  - `skeletonHash`
  - `csHash`
- 保留 MSBuild obj cache 的安全模式，而不是每次强制清。
- Playwright browser/server pool，减少重复 launch / warmup。
- Luna stage1/stage4 cache 策略再细化。

风险：缓存必须可复现、可失效，否则会把旧 artifact 当新结果。

### P2：投机式双候选修复

对高风险视觉/CUA fingerprint：

- 一次生成 2 个候选 patch。
- 同时进 cheap gates。
- 先通过者进入 cert lane。

收益：减少串行 repair loop 墙钟。  
代价：LLM token / 并发资源增加。

### P2：全链路 telemetry

给每个 task 产出统一 trace：

- parse/spec/build/review/CUA/visual 每段 span。
- LLM prompt tokens / cached tokens / latency。
- build cache hit / miss。
- visual phase cost。
- CUA observe/probe/manual flow cost。
- failure fingerprint 和重复次数。

收益：后续优化有量化依据，不再靠人工翻 timeline。

## 11. 需要同事一起定的决策

1. 是否接受 `preview ready` 与 `cert passed` 分离。
2. fast lane 通过后，是否允许先给业务/美术预览。
3. cert lane 失败时，preview 是否自动撤回或标红。
4. 旧 adapter 历史命名要不要彻底从 local artifacts / telemetry 里迁掉。
5. 是否允许 speculative 多候选修复增加 token 成本换墙钟时间。
6. 构建缓存能接受多激进，哪些 gate 必须 clean build。
7. phase selector 的第一版是保守选相邻 phase，还是只选失败 phase。
8. 哪些指标作为优化验收：总耗时、LLM 占比、通过率、cert 失败率、人工介入次数。

## 12. 建议的第一版落地范围

第一版不要一次改完整架构，建议做一个小闭环：

1. 新增 `BLUEPRINT_FAST_LANE=1`。
2. 让 SourceIR build 生成 `affected-phases.json`。
3. `validation-router` 消费 affected phases，输出 fast lane plan。
4. fast lane 并行运行：
   - source liveness
   - runtime contract quick check
   - `storyboard-webgl-visual-diff --phases <affected>`
   - `cua-checkpoint-probe --phase <affected>`
5. 产出 `fast-lane-summary.json`。
6. 只有 fast lane pass 后才进入完整 cert lane。

预期结果：

- repair loop 从 45-75 分钟压到 20-40 分钟区间。
- 可看 preview 目标 12-25 分钟。
- LLM 占比从约 55-65% 降到 30-45%。
- full cert 仍可能 30-60 分钟，但可以后台异步运行。

## 13. 外部参考

- Playwright sharding / parallelism：`https://playwright.dev/docs/next/test-sharding`
- Unity build caching strategy：`https://docs.unity.com/en-us/build-automation/optimize-build-speed/select-caching-strategy`
- OpenAI prompt caching：`https://developers.openai.com/api/docs/guides/prompt-caching`
- Bazel remote/disk cache：`https://bazel.build/remote/caching`
- Selective Regression Testing for Node.js：`https://arxiv.org/abs/2104.00142`

## 14. 附：关键本地文件索引

| 文件 | 作用 |
|---|---|
| `/opt/blueprint-skill/SKILL.md` | Blueprint skill 主说明 |
| `/opt/blueprint-skill/INCIDENTS.md` | 历史事故和修复记录 |
| `/opt/blueprint-editor/scripts/source-ir-build.cjs` | SourceIR build wrapper，支持 `--visual-phases` |
| `/opt/blueprint-editor/adapters/source-ir/index.js` | SourceIR adapter 主入口 |
| `/opt/blueprint-editor/scripts/validation-router.cjs` | risk-based validation plan |
| `/opt/blueprint-editor/scripts/cua-checkpoint-probe.cjs` | debug-only checkpoint CUA |
| `/opt/blueprint-editor/worker/worker-playableagent.js` | CUA/manual joystick/visual audit 主实现 |
| `/opt/blueprint-editor/worker/worker-bridge-build.js` | Luna/WebGL build 逻辑 |
| `/opt/blueprint-editor/engine/stages/static-pre-review.cjs` | deterministic static pre-review gate |
| `/opt/blueprint-editor/engine/stages/cua-verify.cjs` | CUA verify 与 fingerprint repeat breaker |
| `/opt/blueprint-editor/engine/stages/visual-check.cjs` | visual precheck 与 vision backend |
| `/opt/blueprint-editor/worker/fix-recipes.json` | 失败模式知识库 |
| `/opt/blueprint-editor/server-data/blueprint.db` | 正式任务状态数据库 |
