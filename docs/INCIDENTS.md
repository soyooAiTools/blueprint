# Blueprint 生产事故记录

## 2026-04-25: assembly 覆盖完整但实现覆盖不完整，导致 custom codegen 仍被触发

### 背景

`feedback1.docx` 要求生成代码严格满足注释、1920x1080 UI、五 partial 拆分、小方法、无事件系统等规范。按反馈收紧静态门禁后，线上任务 `proj_1776912973985_5o2lyu` 重跑时又暴露出更深的问题：`assemblyCoverage=1` 只能说明计划层 module 可映射，不代表每个 module 都有确定性实现。任务仍进入 `codegen-custom`，并出现 300s custom runner timeout / fallback model access 风险。

### 根因

1. `assemblyCoverage=1` 与 implementation coverage 没有分离，导致“计划已覆盖”掩盖“实现仍需 custom Codex”。
2. `schema.customLogic` 即使在 assembly-ready 场景下仍会进入 text runner，剩余少量 custom logic 足以拖住流水线。
3. review 阶段对 deterministic scaffold 的样板/注释噪音仍会触发 Codex reviewer。
4. 注释中文化曾把 `// [ASSEMBLY SLOT] OurBase::...` 改成 `// [ASSEMBLY SLOT] 装配槽 OurBase::...`，破坏 method-check 的 owner-slot contract。

### 修复

- 新增 deterministic implementation coverage，只有 `assembly_ready + unresolved=0 + implementation=1 + missingImpl=0` 时才允许 suppress `customLogic`。
- 补齐当前任务命中的 deterministic emitter / fallback slot，让 implementation coverage 达到 `106/106 = 1.000`。
- 增加 deterministic review gate：method/static/spec 已通过且 implementation coverage 完整时跳过 Codex reviewer。
- 静态检查跨 `GameFlowManagerMain.cs` 与所有 companion partial，注释、条件注释、switch/case 注释升级为 blocking。
- comment localizer 保留 `[ASSEMBLY SLOT]` / `[ASSEMBLY PHASE]` / owner manifest 等机器可读注释，并让 contract parser 兼容历史 `装配槽` 前缀。

### 验证

- 线上任务 `proj_1776912973985_5o2lyu` 已跑通：`pipeline success=true`。
- 日志确认 `Suppressed customLogic` 和 `No custom logic — skipping text runner entirely`。
- review 走 deterministic review pass；compile `Build OK`；runtime-contract `Coverage 11/11`、`Signals 109/109`；heavy CUA skipped；upload 公开预览通过，`visualDiff=0.132`。
- 回归：`node test/assembly-emitter.test.cjs`、`node test/codegen-schema-trigger-repair.test.cjs`、`node test/assembly-contracts-and-cua-bridge.test.cjs`、`node test/csharp-comment-localizer.test.cjs`、`npm test`。

### 归档

- `docs/_archived/2026-04-25-deterministic-implementation-coverage-closeout.md`

## 2026-04-25: 完整 Unity 工程导出与 C# 注释中文化收口

### 背景

任务 `proj_1776912973985_5o2lyu` 通过公开预览修复后，需要提供可在 Unity Hub 中直接打开的完整工程，而不是只导出 `server-data/project-sources/<taskId>` 下的 C# 文件。同时，生成产物里的英文注释需要默认中文化，避免交付工程仍混入大量英文骨架说明。

### 修复

- `scripts/export-unity-project.sh` 改为导出完整工程目录：`Assets/`、`Packages/`、`ProjectSettings/`、`luna.json`、`tools/`，并附带 `BlueprintArtifacts/`。
- 导出脚本会复制所有 `GameFlowManagerMain*.cs` partial，避免只带主文件或 `Systems` 文件导致 Unity partial class 不完整。
- 新增 `lib/csharp-comment-localizer.cjs`，默认只中文化 C# 注释，保留 `TODO_*`、`[SKELETON]`、`[ASSEMBLY]`、API 名、变量名和 signal 名等机器标记。
- `codegen-schema` 与 `compile` 阶段接入注释中文化兜底，让后续生成链路默认产出中文注释。
- `/api/assets` 不再给公开 WebGL 地址追加 `autoplay=1`，该参数只用于 CUA observe 路径；公开预览依赖默认桥接自动播放。
- Dashboard phase 状态过滤 `gameStart` / `gameEnd` 等运行时 meta phase，避免预览步骤显示错位。

### 验证

- 完整工程导出产物：`server-data/exports/proj_1776912973985_5o2lyu_unity_project.tar.gz`。
- 回归覆盖：`test/csharp-comment-localizer.test.cjs`、`test/api-webgl-url.test.cjs`、`test/preview-phase-states.test.cjs`。
- 归档：`docs/_archived/2026-04-25-unity-export-comment-localization.md`。

## 2026-04-25: CUA 通过但公开预览停在第一 SHOT

### 背景

任务 `proj_1776912973985_5o2lyu` 显示已通过 CUA 并进入审核，但公开地址
`https://playcools.top/webgl/proj_1776912973985_5o2lyu/index.html` 裸预览停在第一 SHOT，没有继续推进。

### 根因

1. 验证面不一致：CUA / runtime-contract 主要观察本地 `iframe.html?autoplay=1`，且有 observer-ready、PlayableAgent 和 speed patch；用户看到的是公开裸 `index.html`。
2. 公开预览 fallback 直接调用 `window.startGame()`，绕过 Luna 生命周期初始化，线上出现 `$ctor1` / `Cannot read properties of null (reading 'b2Vec2')`。
3. upload 失败后 checkpoint 复用旧 `htmlOutput`，导致重试可能跳过 compile 并继续上传旧 HTML。
4. `move_to` 叙事阶段缺少 action-backed evidence，导致 `enemyAttackWarning:player_position_changed` signal 缺失。

### 修复

- `runtime-contract` 增加裸 `index.html` default preview probe，阻止“CUA PASS 但默认预览不推进”的 skip。
- `upload` 增加真实 HTTPS 公开预览验证：等待 Unity `window.app` / `__gameState` 初始化后再计时，要求前 3 个 spec phase 或终局推进；并增加 screenshot pixel diff，防止状态推进但画面/镜头冻结。
- `linux-bridge-build.js` 与 `/opt/luna-poc/linux-bridge-build.js` 的 fallback 改为派发 `luna:build` / `luna:start` / `playground:started`，不再直接 `startGame()`。
- `linux-worker-client.js` 对 `public-preview-*` upload 失败从 `compile` 起失效 checkpoint。
- `assembly-emitter` 在缺少 guide-text anchor 时仍为 `move_to` action 注入 fallback evidence。

### 验证

- Runtime contract / PlayableAgent：`11/11` phases，`101/101` signals，PASS。
- Upload 公开预览：`init/enemyAttackWarning → dispatchAstronautAttack`，`completed=3/3`。
- 增强公开探针复测：visual diff `0.025`，高于冻结阈值 `0.005`。
- 回归：`node test/assembly-emitter.test.cjs`、`node test/build-html-bridge.test.cjs`、`node test/linux-bridge-start-fallback.test.cjs`、`node test/upload-public-preview.test.cjs`。

### 运维记录

- `/opt/luna-poc/build-api.js` 已切到 PM2 进程 `luna-build-api`，健康检查 `{"ok":true,"service":"linux-build-api"}`。
- 归档：`docs/_archived/2026-04-25-public-preview-cua-gap.md`。
- 发布收尾归档：`docs/_archived/2026-04-25-public-preview-deployment-closeout.md`。
- 2026-04-25 收尾复测：monitor 无 active / failed 任务；裸公开预览实时探针完成 `3/3`，`enemyAttackWarning → dispatchAstronautAttack`，visual diff `0.031`；PM2 重启后复测 visual diff `0.029`。

## 2026-04-23: rerun 假重提 + split-partial phase gate 漏修

### 背景

`2026-04-23 00:00` 到 `00:20`（北京时间，UTC+8）这一轮，6 个历史失败任务被重新从 `codegen` 拉起后，仍然出现两类异常：

- 有任务“刚提交就挂”，表面像 submit / queue 立即失败
- 也有任务在新的 `review` 轮次里继续卡 `phase-entity-init-only`

深挖后确认，这不是单点故障，而是“假重提 + 预修复漏形态”叠加。

### 根因

1. `engine/stage-rerun.cjs` 只把 task 状态改回 `pending`，没有清：
   - `fail_count`
   - `infra_retry_count`
   - `code_retry_count`
   - `metadata_json.outerFpHistory`

   结果是 task 虽然重新排队，但下一次再报同一错误时，`lib/task-queue.cjs` 会直接命中 `Outer-retry fingerprint FATAL`。这就是“看起来刚提交就挂”的直接原因。

2. `phase-entity-init-only` 的 deterministic repair 之前默认按“单文件”理解 phase 结构：
   - 在同一个文件里找 `CheckEventRules()`
   - 在同一个文件里找 `Phase_<id>_Init()`
   - 在同一个文件里补 `OnTap/OnAutoPlayArrive`

   但 W1b / split-partial 产物的真实形态是：
   - 主文件 `GameFlowManagerMain.cs` 里有 `CheckEventRules()` / `EnterPhase(..., "phaseId", ...)`
   - `GameFlowManagerMain.Flow.cs` 里才有 `Phase_<id>_Init()` / `Phase_<id>_OnTap()` / `Phase_<id>_OnAutoPlayArrive()`

   旧 repair 看不到这条跨文件链，导致 `phase-entity-init-only` 在 split-partial 任务上持续漏修。

3. 同一轮 codegen 里还存在一个次级放大器：
   - 低 coverage W1b 样本如果 schema 没列出 `customLogic`，旧路径会直接 `No custom logic — skipping text runner entirely`
   - 半成品 handler 于是被直接送进 `review`

### 改动

**P0 — rerun 真重置** (`engine/stage-rerun.cjs`)

- 新增 task reset helper，统一清：
  - retry counters
  - `retry_after`
  - `outerFpHistory`
- 同步清 project JSON 的 `lastFailure`
- 把核心逻辑导出，方便测试，不再只能走 CLI

**P0 — split-partial phase gate repair** (`engine/stages/review.cjs` + `engine/stages/method-check.cjs`)

- 新增 `repairPhaseGateRuntimeMovesAcrossPartials(mainCode, extraFiles)`
- 从主文件 `CheckEventRules()` 中识别：
  - `EnterPhase(..., "phaseId", ...)`
  - 当前 phase gate 依赖的 `_snap_XPos`
- 再去 companion partials 收集：
  - `Phase_<id>_Init()`
  - `Phase_<id>_OnTap()`
  - `Phase_<id>_OnAutoPlayArrive()`
- 若实体只在 init 里移动，则：
  - 把最小 move 语句补进主文件 `Update()` 的当前 phase 分支
  - 同时补进 `Flow.cs` 的 tap / autoplay handler
- `method-check` 的 pre-repair 也接入这条跨文件修复链，避免问题拖到 review 才暴露

**P0 — codegen / reviewer 同链路收口**

- `engine/stages/codegen-schema.cjs`
  - custom logic 改成真实 workspace 落盘，再回读结果
  - custom logic 完成后立刻跑 contract scrub
- `adapters/skeleton-generator.cjs`
  - phase gate entity 只保留会被交互模板真实移动的实体，避免从 `entitiesRequired` 硬凑不可达 gate
- `worker/codex-reviewer.js`
  - reviewer 改成优先读 `-o` 输出文件
  - 默认 timeout 提到 4 分钟
  - 明确区分 timeout / empty output / parse error

### 验证

- 回归测试通过：
  - `node test/stage-rerun.test.cjs`
  - `node test/method-check-phase-gate.test.cjs`
  - `node test/review-deterministic-repair.test.cjs`
  - `node test/method-check-auto-repair.test.cjs`
  - `npm test`

- 线上受控验证：
  - `proj_1776680853909_w7113b` 于 `2026-04-23 00:29`（北京时间）重新从 `codegen` 拉起
  - rerun 后 task row 已确认为：
    - `failCount=0`
    - `codeRetryCount=0`
    - `outerFpHistory` 已清空
  - project JSON 已清空 `lastFailure`
  - 新日志不再走旧的 `No custom logic` 路径，而是：
    - `coverage=0.40`
    - `Custom logic detected (4 items), invoking Codex text runner...`

### 记录 / 归档

- 归档详单：`docs/_archived/2026-04-23-rerun-phase-gate-hardening.md`
- 值班口径已同步到当前本机 `blueprint-monitor` skill

### 遗留

- 当前验证已经证明：
  - rerun 不再是假重提
  - 低 coverage W1b 不再静默跳过 custom logic

- 但还没有证明“这 6 个任务全部成功”。下一步仍应继续盯新一轮 `review`，确认是否从 `phase-entity-init-only / reviewer-timeout` 链上彻底脱落。

## 2026-04-22: method-check 前移成功，但 contract check 过宽

### 背景

在把 compile / phase 类问题前移到 `method-check` 之后，线上一批任务不再主要死在 review，而是统一死在：

- `forbidden-generic-api`
- `player-alias-drift`
- 少量 `duplicate-state-fields`

这代表前移方向是对的，但不等于当前 contract 规则已经合理。

### 新结论

- `forbidden-generic-api` 当前直接聚合 `ctx.csCode + ctx.extraFiles` 全量扫描，会把共享 `GFM_*.cs` 也算入任务责任
- `player-alias-drift` 在部分任务上是真问题，尤其是 `player / Player / PlayerAvatar` 混用
- 因此当前失败面是“真实生成问题 + 共享 helper 噪音”叠加，不该只看表面指纹

### 处理原则

1. 保留 `method-check` 前移
2. 收窄 `forbidden-generic-api` 的扫描范围
3. 保留 `player-alias-drift`，但改成只看真实对象定义 / 赋值 / 使用
4. 不再对同一外层指纹无限 resubmit

### 归档

- `server-data/analysis/2026-04-22-blueprint-root-cause-report.md`
- `docs/_archived/2026-04-22-blueprint-system-hardening-and-skill-sync.md`

## 2026-04-22: recovery 收口 + review deterministic 修复前移

### 背景

线上目标从"继续调研"切到"继续盯任务、提高成功率"。恢复工作明确要求以 recovery packet 为主，只回看旧 session 最近相关片段，不再把 19MB raw jsonl 全量灌入上下文。核对当前 `/opt/blueprint-editor` 后确认：旧线程里关于 `FinishGame/ShowCTA`、phaseId 口径、`Camera.main // ok` 的那批修复都还在，但最常见 blocker 已换成：

1. `phase-entity-unbound`
2. `phase-entity-init-only`
3. `update-new-vector-in-hot-path`

其中 `phase-entity-init-only` 不是 reviewer 误杀，而是新产物里真实存在：phase 切换时先 `Snapshot_<phase>_GateEntities()`，实体只在 `Phase_<id>_Init()` 被 `PlaceObj/HideObj` 一次，后续 `OnTap/OnAutoPlayArrive` 没有任何 runtime move，`EntityAdvanced(...)` 因此永远不会翻转。

### 根因

这是典型的"已经能检出，但还没 deterministic 避开"：

- `engine/static-check.cjs` 已能抓 `phase-entity-unbound / phase-entity-init-only / update-new-vector-in-hot-path`
- 当时存在一个 `night-monitor` 自动重提 daemon，但它已在 2026-04-23 移除
- 当时的问题是：自动重提不会修代码；`review` 的 deterministic pre-repair 之前也没有覆盖这两个真实高频形态
- 结果就是：worker 反复把坏代码送进 review，review 再反复把同类问题交给 fix-loop，烧 round 和在线时长

### 改动

**P0 — review pre-repair 扩到 hot-path anchor offset** (`engine/stages/review.cjs`)

- `rewriteHotPathVectorAllocations()` 新增覆盖：

  ```csharp
  spawned.transform.position = Anchor.transform.position + new Vector3(rx, 0f, rz);
  ```

  自动改写为 struct-copy 形式，避免 `update-new-vector-in-hot-path` 继续把系统更新/刷怪路径打回。

**P0 — 新 `repairPhaseGateRuntimeMoves()`** (`engine/stages/review.cjs`)

- 扫 `Snapshot_<phase>_GateEntities()`，找出 gate 依赖的实体
- 如果实体只在 `Phase_<id>_Init()` 里有 `PlaceObj/HideObj/transform.position`，而 `OnTap/OnAutoPlayArrive` 没有 runtime move：
  - 优先复制 init 里的最小 move 语句到对应 handler
  - 若 init 里也没有可复制 move，则补一个最小 `position.y += 2f` 的 fallback nudge
- 目标不是生成"最优玩法"，而是先避免 phase gate 因空 handler 死锁

**P1 — worker / recovery 热生效校验**

- 重启：
  - `blueprint-editor`
  - `linux-worker-1..6`
- 重启后确认新 worker 立即恢复在线并重新领任务

### 验证

- `node -c /opt/blueprint-editor/engine/stages/review.cjs` 通过
- 用失败样本 `proj_1776832068682_wmd8at` 本地回放：
  - `repairPhaseGateRuntimeMoves()` 会把 `sellAppleForProfit` 的空 handler 自动补上 `PlaceObj(Apple, 6f, 0.3f, 3f);`
  - `rewriteHotPathVectorAllocations()` 会把 `IceMelter/FarmPlot + new Vector3(...)` 改写为 struct-copy
- PM2 状态确认 `linux-worker-5/6` 热重启后立刻恢复运行

### 记录 / 归档

- recovery 索引已归档到 `docs/_archived/2026-04-22-codex-recovery-019db076.md`
- 原始来源：
  - `/root/codex-recovery-019db076.md`
  - `/root/.codex/sessions/2026/04/21/rollout-2026-04-21T22-34-30-019db076-d17c-7ca2-8973-b99d009cef39.jsonl`

### 遗留

- `phase-entity-unbound` 若仍高频，下一步应继续前移到 skeleton/template，而不是只在 review 兜底
- `template-engine` 仍有 `TODO_PHASE_n_INIT` marker warning，说明 template/fix-loop 对 skeleton 标记的对齐还没完全稳住
- worker 日志里仍有 `powershell: 未找到命令`、旧 `.env` 中 `RECODE_BUFFER_MS` 被忽略等运维噪音，虽非本次 P0，但会持续影响排障信号质量

## 2026-04-19: 任务级归档闭环（消灭每一个观测盲区）

### 背景

用户提问："现在每次跑的任务、期间遇到的错误、以及修复的问题 都会自动完成记录和归档吗"。审计发现 6 类盲区：

1. **Silent-pass** — `cuaSilentPass` 只在 success=true 时被记录到 metrics，但 **hard-block** 分支（signals 触发把 passed:true 翻转为 false）的 CUA 原始 action 序列、phaseOrder、interactionVars、screenshot URL 全部落地不了。运营事后无法区分"真语义假通过"和"工程师误判"。
2. **MODEL_FATAL 原始响应** — provider 抛出的 MODEL_FATAL: 只在 classification 里记了一个 pattern 字符串，raw body / http status / endpoint 全部丢失。quota / auth / invalid-key 复现排障只剩 stderr 片段。
3. **Pipeline stage 日志** — `addLog` 只写内存 + console，worker 一旦 restart 就全丢。skip (checkpoint/condition) / pipeline-end / GATE 失败都没有持久的时间线。
4. **Auto-fix 尝试** — 运行时 state 写在 `auto-fix-state.json` 里 ~1 行摘要，sub-agent prompt / output / parsed file diff / reject reason / verify error 全部只在进程内存里，进程退出即丢。
5. **Spec-validate 多错误** — 一次失败可能有 N 条 error，normalizeFingerprint 只看开头 100 字符，N=1 和 N=7 归一成两个不同指纹，dedup 失败。
6. **无统一 GC** — metrics.cjs 按 10MB 轮转，但新加的 per-task 归档没有统一老化策略。

### 改动

**P0 — 新 `engine/archive-writer.cjs`**
- 统一 append + 10MB 轮转 + P0 级别 alerts.json 兜底 + BLUEPRINT_ARCHIVE_LEVEL feature flag（`off | critical | full`）
- 归档布局：
  ```
  server-data/task-logs/<taskId>/pipeline.jsonl         # 按 stage 的 log/skip/pipeline-end
  server-data/task-logs/<taskId>/silent-pass.jsonl      # hard-block + soft-warn 快照
  server-data/task-logs/<taskId>/model-fatal.jsonl      # 原始 response head + hash
  server-data/task-logs/auto-fix/<recipe>-<hash>.json   # 每一次 sub-agent 尝试
  server-data/task-logs/auto-fix/_index.jsonl           # 全局索引
  server-data/model-fatal-index.jsonl                   # 跨 task 的 MODEL_FATAL 索引
  ```

**P0 — Silent-pass 零容忍归档** (`engine/stages/cua-verify.cjs`)
- hard-block 分支 `writeSilentPass(ctx, cuaResult, { round, verdict: 'hard-block' })`
- soft-warn 分支（signals present 但仍通过）`verdict: 'soft-warn'`
- 包含 phaseOrder / interactionVars / actionSample（≤250 个、>250 取头 200 + 尾 50 + 中间 `_truncated`）

**P0 — MODEL_FATAL 原始响应** (`engine/pipeline.cjs`)
- early-detection + final-classification 两路径都 `writeModelFatal(err, { taskId, stage, attempt })`
- 原始 body head 4KB + SHA-256（前 16 位）+ http status + endpoint + model + retryAttempt
- 追加到全局 `model-fatal-index.jsonl` 便于排障

**P1 — Pipeline stage 日志持久化** (`engine/pipeline.cjs`)
- `addLog` 双写：内存 push + console + `archiveWriter.appendStageLog(...)`
- checkpoint skip / condition skip / pipeline-end（成功/失败/GATE/CANCELLED）全部落盘

**P2 — Auto-fix 诊断归档** (`engine/auto-fix.cjs`)
- 9 个出口点归档：no-recipe / recipe-file-missing / runner-unavailable / sub-agent-threw / sub-agent-failed / no-output / all-rejected / verify-failed / applied
- 每次尝试存：system/user prompt head 4KB + hash + len、sub-agent output head 4KB、按文件的 unified diff、rejectedPaths、verifyErrors、followUpFingerprint、reverted 标志
- `state.history` 带 `archivePath` 指针，dashboard 可以打开"查看尝试详情"

**P3 — Spec-validate 多错误聚合** (`engine/stages/spec-validate.cjs` + `engine/metrics.cjs`)
- stage 层 `_aggregateSpecErrors`：≥3 条结构键相同的 error 合并为 "<first> (and N-1 similar occurrences: ...)"
- metrics 层 `collapseRepeatedClauses`：按 `Spec[N] <phase>:` 前缀归一，避免 fingerprint 爆炸
- 新增正则：`silent-pass-block` + `MODEL_FATAL:?\s*<endpoint>` 稳定化

**Dashboard — 新"任务归档" tab + 3 个 API**
- `GET /api/dashboard/task-log/:taskId` → `{ pipeline, silentPass, modelFatal, autoFix }`
- `GET /api/dashboard/auto-fix-archive?recipeId=&hash=` → 单次 attempt 详情
- `GET /api/dashboard/model-fatal-index?limit=100` → 全局 MODEL_FATAL 索引
- dashboard.html 新增"任务归档" tab，显示 MODEL_FATAL 索引、Auto-fix 尝试列表（带 diff 查看 modal）、按 taskId 查询聚合视图

**运维 — `scripts/archive-gc.cjs`**
- 默认 30 天 TTL，dry-run 模式，`--purge` 真删，`--days=N` 覆盖
- 扫描 task-logs/<taskId>/（整目录以 newest mtime 为准）、auto-fix/*.json、所有 `.bak.*` 轮转备份
- 可直接挂 cron：`0 4 * * * node /opt/blueprint-editor/scripts/archive-gc.cjs --purge`

### 验证

- 所有 5 个 pipeline 阶段文件 `node -c` 通过
- `router.matchRoute()` 3 个新 path 返回正确 handler
- `BLUEPRINT_ARCHIVE_LEVEL=off` 时所有写入静默跳过（P0 除外：critical 仍写）
- archive-gc 45 天过期测试：dry-run 保留 / --purge 删除
- `pm2 restart blueprint-editor` 热重载生效，3 个新 endpoint 返回 200

### SKILL.md 同步

当前应同步的 canonical skill 副本位于 `/root/.codex/skills/`。旧 `/root/.codex-blueprint/skills/` 与 `~/.codex/memories/skills/` 目录已移除，不再作为同步目标。详见 `docs/dashboard-skill-update.md` 的同步字段。

---

## 2026-04-16 晚: Dashboard 可观测性事故响应 + Auto-fix 4 层闭环

### 背景

用户打开 dashboard → Pipeline 指标 → "Top 失败原因",看到 45 行失败记录、成功率 0%。肉眼判断"这么多失败一定全坏了",实际上这 45 行是 **5 类根因的同步 retry 副本**(同一个 skeleton.split TypeError 在同秒 throw 4 次、ECONNRESET 每次编译尝试都算一行),每一条都**已经在更早的 commit 里修过**。但 dashboard 没去重、没知识绑定、没回归追踪,看起来像"所有 pipeline 都在烧钱"。

叠加观察到:`blueprint.db` 里躺着 5 个 cancelled 事故 task(bqh33t / 2p50o1 / yjrgmn / zxpzt4 / dmda29)和 **665 条 task_history**,其中 646 条属于这些早已结案的任务;`parse-stats.json` 抱着 25 条最早追溯到 2026-03-20 的解析记录,全程 24/25 成功但占着 "解析统计" tab;`server-data/checkpoints/` 和 `server-data/webgl/` 堆满老 project 目录。

这是**观测性事故**,不是功能事故 —— 根因都修了,只是没人告诉 dashboard 这件事。

### 根因

**观测层 4 个相互独立的缺陷**:

1. **L1 指纹不稳定 + 不去重** —— `engine/metrics.cjs` 的 `topFailReasons` 按 reason 原始子串做 group by,同一个 TypeError 错误里的 taskId / path / line number / round-number 都会让字符串不同,等效于 "没 group by"。同一失败被算 N 次,视觉上把少量根因放大成密集失败面
2. **L2 没有知识绑定** —— 失败面上每一行都是孤立的,不知道 `feedback_skeleton_truthy_split.md` 写过为什么,也不知道 git log 里有 `529136b fix` 对应它。人的第一反应是"这是什么新错误",然后重新调查一遍
3. **L3 没有回归闭环** —— 即使曾经修好过,下一次它复发时 dashboard 没有 "你之前修过 → 这是回归" 的告警;和首次发生是一样的展示
4. **L4 没有自愈通道** —— 即使知道"这个指纹在 `feedback_skeleton_truthy_split.md` 里",也没有按钮让 sub-agent 去按 recipe 出 patch。每次都是人工重新 grep → 重新看 memory → 手写 fix

**数据层 2 个陈旧堆积**:
- `parseStats` 在 `server-context.cjs:24-30` 启动时一次性读入内存,25 条历史永久常驻,磁盘重置无效 —— 必须 restart 才能刷
- cancelled 任务在 DB 里没有过期策略,`task_history` 永远累积

### 改动

**L1 — metrics.cjs 指纹去重** (`engine/metrics.cjs`)
- 新 `normalizeFingerprint(reason)`: 剥 stage 前缀、`\/[\w.\-/]+ → <path>`、`proj_\d{10,}_[a-z0-9]+ → <taskId>`、5+ 位数字 → `<num>`、hex hash → `<hash>`、`round N` / `N rounds?` 归一化,截断到 100 字符
- `topFailReasons` 改成按 normalized fingerprint 聚合,输出 `{uniqueTasks, retries, firstSeen, lastSeen, failedAtStage, classification}`,按 uniqueTasks 降序而非 retries
- summary 加 `dataWindow: {from, to, totalRecords}` 给前端贴 stale 警告

**L2 — 失败指纹→知识绑定(新)** (`engine/failure-fingerprint.cjs`)
- `extractKeywords`: 抓 ALL_CAPS 错误码(ENOENT/ECONNRESET/FATAL)、PascalCase 标识符(GameFlowManagerMain)、引号字串、硬编码领域词典(skeleton/csCode/GFM_Tools/LINUX_BUILD_URL/Visual freeze/CUA 等 21 个)
- `grepMemoryForFingerprint`: 先扫 `CODEX_HOME/projects/-root/memory/*.md`，再兼容回退旧 home memory 目录，按命中关键词数量打分，top 5
- `loadGitLog`: `git log --all --since="60 days ago"`,5 分钟 TTL 缓存
- `grepGitLogForFingerprint`: subject 匹配关键词,`fix:|修复|patch|resolve|hotfix|refactor` 再加 2 分
- `bindKnowledge(fingerprint)`: 返回 `{memoryHits, commitHits, resolvedBy, resolvedAt, autoFixRecipe}`
- **关键:resolvedBy 优先级 = recipe.relatedCommits(curated)> 模糊 grep**。`"data argument"` 这种泛词会错配 `9389530 spec data path`,而真实 fix 在 `529136b`;recipe 的 `relatedCommits: ["529136b"]` 显式指定后 L3 才不会误报回归
- `api/dashboard.cjs getPipelineMetrics` 对每条指纹挂 `.knowledge` 字段

**L3 — 回归守卫** (`api/dashboard.cjs runWatchdogCycle` Phase 6)
- 扫最近 100 条失败记录,对每条 `bindKnowledge`,任何 `failedAt > resolvedAt` 即判回归
- 持久化到 `server-data/regressions.json`(upsert by fingerprint)
- 30 分钟节流调 `worker/feishu-notify.js` 的 `send(taskId, 'stuck', msg, {fingerprint, resolvedBy})`
- 新 handler `getRegressions` → `GET /api/dashboard/regressions` 返回最近 7 天
- `dashboard.html` 加 🚨 回归告警卡(红色)在 Top 失败表旁

**L4 — Auto-fix 护栏版**(新,只出 patch 不改 repo)
- `worker/fix-recipes.json` — JSON manifest,2 条 seed recipe(`skeleton-truthy-split` / `econnreset-buildapi`)
- `worker/fix-recipes/*.md` — playbook(诊断步骤 + 期望 patch + 验证命令 + DO NOT 清单)
- `engine/auto-fix.cjs applyRecipe(fingerprintId)`(新):
  1. `findRecipe` 按 id 精确 / 按 fingerprintPattern 正则匹配
  2. 读 recipe.md body + 收集 `affectedFiles` 作为 additionalFiles
  3. 调 `runCodexText`(sonnet-4-6, effort=medium, 4min, minOutputLen=100)
  4. 返回 `{ok, recipe, patch, subagentLog, autoApplied:false, notice}`
- systemPrompt 硬编码三条铁律:不 git commit、不改文件系统、不建议 restart worker(Sonnet 子 agent 读 memory 前这三条最容易违反)
- 新路由 `POST /api/auto-fix/:fingerprintId` → `runAutoFix` handler
- **铁律**: 当前 CLI 系统提示约束里规定 loop 里 NEVER auto commit,L4 只产出 patch 文本交人审
- dashboard.html 每行指纹加 🔧 按钮调 `window.triggerAutoFix(id)`,结果开新窗口展示

**数据清理**
- `blueprint.db`: DELETE 5 cancelled task + 646 history 行 → 剩 1 task(xrbkl1 活动)+ 19 history 行
- `server-data/checkpoints/`: 5 陈旧目录 → 移入 `server-data/archive-20260416/`
- `server-data/webgl/`: 6 陈旧目录 → 移入 archive
- `parse-stats.json`: 磁盘 reset 为 `{total:0,success:0,failed:0,history:[]}`
- `server-data/database.sqlite`(0 字节遗留)、`tasks.db`(0 字节遗留)→ archive
- `server-data/metrics/pipeline-metrics.jsonl` → `archive-20260416/pipeline-metrics.jsonl.bak.20260416`
- `.gitignore` 补加 `server-data/archive*/`、`server-data/regressions.json`、`server-data/cua-reviews/`

**新 reset 端点** `POST /api/dashboard/reset-stats`
- body `{parse?, metrics?, tasks?, archive?}`,`tasks` 是 opt-in(安全),其它默认开启
- `parse` 通过**引用 mutation** 直接清 `ctx.parseStats` 内存态(`server-context.cjs` 的 `parseStats` 对象共享给所有 handler,in-place 修改即同步)
- 避免下次再用 file 手术 + restart 才能清历史

**skill 双向同步**
- `~/.openclaw/workspace/skills/dashboard/SKILL.md`: 完全重写,从 4-tab 版本追到 7-tab + L1-L4 全貌,新增 "⚠️ 与 blueprint skill 双向同步铁律" 交叉表
- `~/.openclaw/workspace/skills/blueprint/SKILL.md`: 新增 "⚠️ 与 dashboard skill 双向同步铁律" 章节 + "可观测与自动修复 (L1-L4, 2026-04-16)" section

### 验证

- Restart `blueprint-editor` 时 xrbkl1 正在 CUA round 2 re-code(linux-worker-1 本地 AI 调用,不打 API),空窗 <1s, `reportStatus` catch 吞错不抛 → 任务无缝继续,restart 后直接看到 xrbkl1 推进到 `CUA fix rebuilding round 3`
- `curl /api/dashboard/stats` 的 `parse` 字段从 25/24/1 变 0/0/0
- `curl /api/dashboard/regressions` 返回 `{regressions:[],count:0}`
- `curl /api/dashboard/pipeline-metrics` 返回新 schema(dataWindow、uniqueTasks 等)
- `POST /api/dashboard/reset-stats` 返回 `{ok:true, report:{parse:"reset (in-memory + disk)"}}`
- Node 直连测 `bindKnowledge('TypeError: The "data" argument ...')` 返回 `resolvedBy=529136b`(curated 胜出),而非泛词匹配到的 `9389530`

### 遗留

- L2 `phrasesToCheck` 是硬编码数组,新 fingerprint 类需要手动加
- L4 只有 2 条 recipe,加新指纹要同时改 3 处(`fix-recipes.json` + recipe.md + 验证 regex 命中)
- 回归告警 30 分钟节流是全局,一周期多个回归只飞书 1 次
- **`pm2 restart blueprint-editor` 时必须确认 worker 不处于打 API 的阶段**(`upload-build` / `apiRequest GET /api/tasks/:id/blueprint`)。CUA verify / AI coding / Bridge 编译这三个阶段都是安全窗口 —— worker 用 `reportStatus` 上报会被内部 catch 吞错,不影响任务

### 教训

→ **"已修复"不等于"可见已修复"**。每次修 bug 都要问 "下次它复发时 dashboard 会告诉我吗",否则就是在同一个问题上重复花时间
→ **模糊 grep 不能作为"resolvedBy"的唯一依据**。"data" 这种泛词必然撞车,必须让 recipe 显式声明 relatedCommits
→ **in-memory 缓存必须有刷新通道**。`parseStats` 这种进程启动时读入的状态,如果只能靠 restart 刷,下次清理就得再停一次服务 —— 必须暴露 reset 端点
→ **两个 skill 必须双向同步**。dashboard 展示什么字段的背后都是 blueprint 的代码,单边更新 = 下次信息错配

---

## 2026-04-16 深夜: patchRecode no-op 死锁 + rule 字段透传 (proj_2p50o1 follow-up)

### 背景

上一节 CC CLI 迁移 (cfccd1c) 遗留的 ⚠️: `proj_1776266310700_2p50o1` 连续 3 轮 patchRecode 返回**字节一致的 48175 char**,static-check 同样 2 条 blocking violation 纹丝不动,Round 4 exhausted 后 circuit breaker 熔断,~6 分钟空转。

另外 `project_2p50o1_postmortem_20260416.md` 复盘记忆已独立定位到这是 **skeleton 和 static-check 正则互相踩雷的 false-positive floor**(`mainCam = Camera.main;` 缺 `// ok` 豁免、`autoplay-interact-empty` 正则被示例注释里的 `}` 截断),并把"patchRecode 字节恒等应视为终止信号"列为 P0。本次落地的就是 postmortem 里的这条 P0,**不是完整修复** —— skeleton / 正则两层 false positive 的修复仍留在工作区未提交(见 §遗留)。

### 根因(排除错的假设)

最初怀疑 "`issue.message` 只透传 'Line X: 问题'",追 `engine/static-check.cjs:283-289` → `engine/stages/review.cjs:121-126` → `engine/recode.cjs:183-210` 链路后**排除**: `static-check.cjs` 构造的 message 一直是带完整规则描述的(例 `"GFM_Create.Obj() forbidden — use GameObject.Find() from pool"`), patchRecode prompt 的 `Problem:` 行也的确把整条 message 透传给了 Sonnet。

真正的失败形态是 **三元叠加**:

1. `review.cjs:121-126` 的 static-precheck mapping **把 `rule` 字段丢了**,Sonnet 看不到规则 id 当 handle,也没法反推语义规则应触达哪个代码区
2. 几条语义类 custom 规则硬编码 `line: 1`(`render-no-objects` / `autoplay-gate-removed` / `missing-using`), patchRecode 按 `line ± 5` 取片段只能抓到文件头 (`using UnityEngine;`), Sonnet 看不到真正的 phase 结构
3. **patchRecode 调用方没有"代码真的变了吗"检测** —— Sonnet 返回原文时 `recodeResult.ok === true`, `reviewedCode` 被赋值成字节相同的内容, 下一轮 staticCheck 当然再失败, 链路没任何点能发现 patch 是 no-op, 只能靠 `MAX_REVIEW_ROUNDS=4` 硬撞

配合 prompt 里 "do NOT modify other code" + "Only modify lines related to the issues" 的矛盾约束,Sonnet 在上下文不足时最安全的选择就是返回原文 —— 正好触发 #3。

### 改动

**改动 1 — patchRecode no-op 检测** (`engine/recode.cjs:267-278`)

在 `text.length < 100` 检查之后、成功返回之前,加一步 `text === opts.currentCode` 对比。字节一致 → 返回 `{ok:false, error:'patch no-op: byte-identical output'}`,让调用方 (`review.cjs` 已有的 `if (!patchResult.ok) recode(...)` 分支) **立即 fallback 到 full recode**。full recode 拿到的是完整 V5 prompt(实体表 / skeleton / feedbackHistory),对 `render-no-objects` 这类**合法**语义规则能真正处理。

**改动 2 — patchRecode prompt 显式展示 rule id** (`engine/recode.cjs:204-209`)

`Problem:` 行前加 `[rule-id]` 标签,e.g. `Problem: [render-no-objects] Phase 1 must place at least 3 pool objects...`。`issue.rule` 缺失时(Codex / GPT-5.4 reviewer 产生的 issue)退化成原样。

**改动 3 — `review.cjs` static-precheck mapping 保留 `rule` 字段** (`engine/stages/review.cjs:121-123`)

这是 #2 的前提:从 `{severity, line, message, text}` 补成 `{..., rule: i.rule}`。

**改动 4 — `review.cjs` round FAIL 日志带 rule 列表** (`engine/stages/review.cjs:215-218`)

`Codex review FAIL (2/4), fixing...` → `Codex review FAIL (2/4) [create-obj,setactive], fixing...`,最多 3 条,超出 `,…`。主要是给人看 —— 日志里一眼能看出是哪条规则卡 fix-loop。

### 刻意不做

复盘时过了 5 条改进,只落 #1 / #3 两条:

- **修 `static-check.cjs` 的硬编码 `line: 1`**: #1 上线后语义规则会自动 fallback 到 full recode,line 号不进入 Sonnet prompt 构造,改它 ROI 低。且 static-check custom 规则之前踩过花括号截断坑(见 memory `feedback_static_regex_brace_hazard`),改起来非零风险。
- **`usePatch` 白名单排除语义规则**: 和 #1 功能重叠 —— #1 事后检测(浪费 1 次 Sonnet 调用),白名单事前拦截(0 浪费),但白名单要维护"哪些是语义规则"名单,容易漏。等 #1 命中数据再决定是否值得预拦截。
- **per-rule `suggestion` 字段**: 工作量最大,前提假设"full recode 也搞不定语义规则"目前没证据,premature optimization。

### 对 2p50o1 本身的净效果:**不完整**

要诚实标注 —— 这一轮修复对 2p50o1 具体任务**可能不改善总耗时**,因为它的 2 条卡住规则是 skeleton-level false positive(见 postmortem `project_2p50o1_postmortem_20260416.md` §两条永远清不掉的 false positive):

1. `camera-main` L169 — skeleton 自生成的 `mainCam = Camera.main;` 末尾缺 `// ok` 豁免注释, AI 没有修复权限(违规行不在 AI 能改的代码范围)
2. `autoplay-interact-empty` L102 — 规则正则 `\{([^}]*)\}` 被 skeleton 示例注释里的 `}` 截断, body 被裁成 156 char 纯注释 → strip `//` 后变 0 → 永远 empty

这两条 false positive 对 full recode 和 patchRecode 一视同仁,fallback 并不能让它们消失 —— 可能会把 2p50o1 从"4 轮 patch 空转 ~6 min"变成"4 轮 patch+full-recode 空转 ~更贵"。但对**其它**命中 `render-no-objects` 这类合法语义规则的项目是净收益。

### 2p50o1 真正的终局修复(留给下一轮)

工作区有 4 个 dirty 文件对应 postmortem 的 P0 清单,但**不属于本 commit**(mtime 比本 commit 的编辑早 ~6 分钟,怀疑是上一个 session 的未完成工作):

- `engine/static-check.cjs` — 疑似 P0 #1 `autoplay-interact-empty` 花括号平衡
- `adapters/skeleton-generator.cjs` — 疑似 P0 #2 / #3 skeleton 示例注释改块注释 + `mainCam = Camera.main; // ok` 豁免
- `worker/codex-reviewer.js` — 疑似 P0 #4 `GFM_Tools.cs` 排除 + companionNote 矫正
- `worker/pending-rules.json` — template-learner 自动写入,和 P0 清单无直接关联

需要下一个 session 审核清点后另行 commit。

### 验证

- `node -c engine/recode.cjs` / `node -c engine/stages/review.cjs` 双通过
- `pm2 restart linux-worker-1 linux-worker-2`,两 worker 都 online,CPU 稳定到 0%,`Saved 0/0 checkpoints` 确认无在飞任务丢失
- `blueprint-editor` 不重启,减小爆炸半径(避开 port-guard cluster-suicide 复发区,见 aae59bb)

### 关键文件

| 文件 | 变更 |
|---|---|
| `engine/recode.cjs` | patchRecode no-op 检测 + `Problem:` 行加 rule 标签 |
| `engine/stages/review.cjs` | static-precheck mapping 保留 `rule` + round FAIL 日志带 rule 列表 |

---

## 2026-04-16: visual-check + patchRecode 统一迁移到 Codex text runner (Sonnet 4.6)

### 背景

2026-04-15 bqh33t 事故复盘后,MODEL_FATAL 贯穿闭环已经让 Claude relay 的定性失败能被及时捕获并 cancel 任务,**但流水线里仍有两条路径走的是直连 Claude API (HTTP POST crs.mindrix.app/v1/messages)**,和“统一到 Codex/CLI 文本入口”的目标不符:

1. **`engine/stages/visual-check.cjs:259`** — CUA 截 JPEG 帧经 `ClaudeProvider.generateVision()` 做 VLM 判分。今天已多次出现 "vision relay 返空 → silent passed:false → fix-loop 继续烧轮"(旧事故见上一节 Layer 4),以及 60s 超时被 MODEL_FATAL 抛出后整任务 cancel 的场景。
2. **`engine/recode.cjs` `patchRecode`**(review 阶段 ≤3 issue 时的短路优化)— `ClaudeProvider.generateWithRetry(prompt, {model:'claude-sonnet-4-6', timeoutMs:180000}, 2)`。今天 `proj_1776266310700_2p50o1` Round2 fix 吃了 2 轮 180s 超时烧 6 分钟后才 fallback 全量 recode。

### 决策:换传输不换模型

用户定调:**保留 Sonnet 4.6 作为模型**(豆包 vision 可能不如 Sonnet 精细,不切),但把**调用方式**从 "HTTP POST 直连 Claude API" 改成统一的 CLI 文本入口。这样所有 Claude 调用都走统一的 CLI relay,故障特征、MODEL_FATAL 检测、计费全部归一。

**关键使能点**: CC CLI 的 Read 工具原生支持图片(工具描述 "This tool allows Claude Code to read images (eg PNG, JPG, etc)"),所以视觉分析可以走 "把 base64 帧写成临时 `./frame1.jpg` → prompt 指令模型 Read 它们 → CC 把 image content block 塞给 Sonnet" 这条路。

### 改动

**改动 1 — 新增文本模式 spawn 辅助**（现入口 `runCodexText`，现实现位于 `worker/codex-code-coder.js`）

和现有 `runClaudeCode` 的区别:
- 自己创建 `/tmp/cc-text-<taskId>-XXX` 临时 workDir,不需要 Unity 工程目录
- 不做 mtime 检查;ok 判据只看 `exit code === 0 && stdout.length >= minOutputLen`
- tools 缩到 `Read`(最小权限,视觉也靠它加载图片)
- `systemPrompt` 写到临时系统提示文件作 `--system-prompt-file` 传入
- `opts.additionalFiles` 预写到 workDir,供 prompt 里指令模型 Read
- MODEL_FATAL 检测规则镜像 `runClaudeCode` line 413-419(`/quota|insufficient|\b401\b|...`)

**改动 2 — `visual-check.cjs` 走 CC CLI + Read 图片**

把 `imgBase64` / `frameImages[].base64` 转成 `Buffer`,命名为 `frame1.jpg, frame2.jpg, ...` 通过文本入口（现名 `runCodexText`）的 `additionalFiles` 塞给 CLI。`userPrompt` 开头显式告诉模型 `Use the Read tool to load ./frame1.jpg, ./frame2.jpg, ...`。下游 JSON 解析、同原因早退、硬性 gates 全部保持原契约。超时从 60s 放宽到 120s(CC 冷启动 + Read 图片 + 推理的 margin)。

同原因早退正则扩展为 `/could not parse analysis response|vision cli unavailable|vision api unavailable/` 同时匹配新旧错误文案。

**改动 3 — `recode.cjs patchRecode` 走 CC CLI**

保留所有上下文构建逻辑(`codeLines` / `issueDescriptions` / `extraFilesContext`)和返回契约(`{ok, code, patchApplied, error}`),只把 `provider.generateWithRetry()` 换成统一文本入口（现名 `runCodexText`）。timeout 从 180s → 240s(CC 冷启动余量)。MODEL_FATAL 传播从 `.catch` 移到 `.then` 里检查 `!result.ok && /MODEL_FATAL/i.test(result.error)`。

### 验证

**Stage A — 脱离 pipeline 的 smoke test (`/tmp/smoke-*.js`)**

| 测试 | 结果 |
|---|---|
| 纯文本模式 (systemPrompt + userPrompt → stdout) | ✅ |
| 图片 Read 模式(真实 5344B JPEG `cua-results/screenshots/round_02.jpg`) | ✅ 7.5s 返回 "2D game scene with light cyan background, two circular objects, two rectangular platforms..." |
| 超时路径 (timeoutMs=3000) | ✅ SIGTERM 后 SIGKILL,正确返回 `ok:false` |
| MODEL_FATAL 路径(假 token) | ⚠️  CC CLI 用 OAuth 不走 `ANTHROPIC_API_KEY`,env 污染触达不了 → 测试命中 30s 超时。生产中真实 auth 失败仍能被 regex 捕获(规则针对 stdout/stderr 文本,非 env 污染) |

**Stage B — 集成验证**: `pm2 restart blueprint-editor linux-worker-1 linux-worker-2`,三进程全部 online,worker 心跳重注册,启动日志无 require / syntax 错误。

### 影响与遗留问题

- ✅ 两条直连 Claude API 的路径消失,流水线所有 Claude 调用统一走 CC CLI relay
- ✅ 故障特征、MODEL_FATAL 检测、计费全部归一
- ✅ **2026-04-16 深夜已部分修复(见上一节)**: 原怀疑的 "issue.message 没透传 rule 描述" **是错的假设** —— message 一直是完整带规则描述的。真实根因是 patchRecode 调用方没有 "输出=输入" 的 no-op 检测 + `rule` 字段在 static-precheck mapping 里被丢。本次落地 no-op 检测 + rule 字段透传 + round-fail 日志带 rule id;但 2p50o1 本身还依赖 skeleton / static-check 两层 false-positive 的修复(工作区 4 个 dirty 文件对应这些 P0)才能彻底通过。

### 关键文件

| 文件 | 变更 |
|---|---|
| `worker/codex-code-coder.js` | 文本入口实现（现对外名为 `runCodexText`） |
| `engine/stages/visual-check.cjs` | 259-313 段切 CC CLI,图片走 Read 附件 |
| `engine/recode.cjs` | `patchRecode` 切 CC CLI |

---

## 2026-04-15 晚间: bqh33t 100% 失败 + 流水线 8 层 silent-pass — MODEL_FATAL 贯穿闭环 + 黑屏静态门

### 影响范围
用户反馈 "blueprint 项目上的任务为什么会失败"。深度调研发现最近 38 个 pipeline metric 全部 0% 成功。典型受害者 `proj_1776235585307_bqh33t` 连续 6 轮 claude-code recode 全部 FATAL `visual_freeze` (138/138 帧全黑), 每轮 ~36 分钟, 合计 ~$50+ token 白烧。根因不是 bqh33t 代码本身, 是**整条流水线丧失了对模型失败的感知能力** — 任何一家中转挂点, 任何一条错误文本带 "parse error" 字样, 流水线都会把它当作 "通过" 继续往下推。

### 三重根因叠加

**根因 1: sub.mindrix.app OpenAI-compat 中转 503 + sk- key 401, 但流水线 8 层 silent-pass 把模型错误吞成 "通过"**

| # | 位置 | 坏行为 |
|---|------|--------|
| 1 | `worker/codex-reviewer.js:247` | preflight 失败 → `{passed:true,skipped:true}` |
| 2 | `worker/code-reviewer.js:585` | 无 OPENAI_API_KEY → silent skip |
| 3 | `worker/code-reviewer.js:651` | JSON parse 失败 → `{passed:true,parseError:true}` |
| 4 | `worker/code-reviewer.js:718` | **catch-all** 任何错误 → `{passed:true,error:...}` **最致命** |
| 5 | `engine/stages/review.cjs:44/127/131` | 无 reviewer / fallback 级联吞 quota |
| 6 | `engine/recode.cjs:100` | 生成器所有错误 → `{ok:false}` → 调用方 `if(!ok)` 静默继续 |
| 7 | `engine/stages/visual-check.cjs:292` | Vision API catch → `{passed:false,reason:'Vision API unavailable'}` → fix-loop 继续烧轮 |
| 8 | `engine/stages/cua-verify.cjs:198` | `runCUAVerification` catch → null → 下一 round |

每一层单独看都是 "防御性编程, 不要因为一个错误崩掉整个任务"。但叠起来效果是: review 层的 $0 catch-all 让 known-broken 的代码直接过门, codegen 层的 `{ok:false}` 让 recode 看起来 "失败了不该继续", 但调用方又只检查 `.ok`; visual-check 把 404/502 包装成 passed:false 丢给 fix-loop; CUA 发现黑屏以为是代码问题, 又触发 6 轮 claude-code recode (每轮 ~36 min, 走的还是同一个 503 的 relay)。

**根因 2: review 阶段静态检查只在入口跑一次, 只注入 feedback**

`engine/stages/review.cjs` 在 `execute()` 最顶部调一次 `staticCheck(reviewedCode)`, 发现违规只往 `ctx.blueprint.feedbackHistory` 塞一条 entry, 不拦截流程。然后进 fix-loop, 如果 LLM reviewer 返 PASS (包括 root cause 1 的 silent-pass), 违规代码就**直接过门**。bqh33t 的 black-screen API (`GFM_Create.Obj` / `SetActive` / `Destroy` / `Instantiate` / `new Material` / 等 11 条规则) 在 codegen / review 从未被硬拦截, 一路畅通到 visual-check / CUA 才在黑屏上崩。

**根因 3: Claude relay 迁移后 ClaudeProvider 还在打死 URL**

之前把 Claude 从 Anthropic 直连改成走 `sub.mindrix.app/v1/chat/completions` (OpenAI-compat), 代码里 URL 硬编码。2026-04-14 `sub.mindrix.app` OpenAI-compat 中转整体 503, `sk-` key 也开始返 401 INVALID_API_KEY。但 `lib/model-provider.cjs ClaudeProvider.generate` 还在往死 URL 发请求, 完全打不通 — 且所有响应体带 "parse error" / "auth failed" 的错误文本被上层 catch-all 吞成 passed:false, fix-loop 不知道 relay 已经没救了, 继续重试。

### 防护分四层落地

**Layer 1: MODEL_FATAL 分类贯穿全链路**

新增 `error-classifier.cjs` 的 `MODEL_FATAL` 类型 (最高优先级, 早于 CUA/INFRA/CODE 所有 pattern)。匹配定性失败特征 (与瞬时故障区分开):

```
/MODEL_FATAL/i                    // 显式 marker
/quota.?exceeded/i                // GPT / Codex / Doubao 配额耗尽
/insufficient.?quota/i            // OpenAI 标准
/insufficient.?balance/i          // Doubao / SiliconFlow
/\b402\b/                         // HTTP 402 Payment Required
/invalid.?api.?key/i              // OpenAI / Doubao 标准
/authentication.?failed/i         // 通用 auth fail
/\bunauthoriz(ed|ation)\b/i       // 401 body text
/API key not valid/i              // Google/Doubao 标准
/codex.*preflight.*fail/i         // codex-reviewer preflight 显式
```

`401/403` 从 `INFRA_PATTERNS` 中移除 (定性非瞬时, 重试只会原样 401), 但**保留 429** (短时限流可恢复)。

MODEL_FATAL 路由链:
```
provider 层 throw (前缀 MODEL_FATAL:)
  → fix-loop.cjs 见 classified.type==='MODEL_FATAL' 直接冒泡, 不 recode
  → pipeline.cjs 在 stage retry 前先 classify, MODEL_FATAL 不 stage-retry
  → linux-worker-client.js processTask catch 检 failInfo.failClassification
  → cancelTaskViaApi(taskId, 'worker:model-fatal', reason)
  → 任务状态转 cancelled (terminal, watchdog 不再抢回重试)
```

改动的 silent-pass 修复点 (按事故 8 层对应):

| 层 | 文件 | 改动 |
|---|------|------|
| 1 | `worker/codex-reviewer.js` | preflight 失败 → `throw MODEL_FATAL`; 另外剥离子进程 `OPENAI_API_KEY/CODEX_API_KEY/OPENAI_BASE_URL` 避免 codex 误用 mindrix key 撞 api.openai.com 拿 401 |
| 2-4 | `worker/code-reviewer.js` | 无 key → throw MODEL_FATAL (保留 `ALLOW_NO_REVIEWER=true` 本地逃生口); parse 失败 → throw; catch-all 按 quota/auth 正则前缀化 MODEL_FATAL 或原样 throw |
| 5 | `engine/stages/review.cjs` | "no reviewer available → skipped" 改为 throw MODEL_FATAL; codex→GPT fallback 加 `isDefinitive` 守卫 (GPT-5.4 与 codex 共享同一 OPENAI_API_KEY, 降级只会撞同一 quota 墙) |
| 6 | `engine/recode.cjs` | result.error 含 MODEL_FATAL → throw; 两处 .catch re-throw |
| 7 | `engine/stages/visual-check.cjs` | 空 rawText 响应 → throw MODEL_FATAL; 同 reason `"Could not parse analysis response"` / `"Vision API unavailable"` 升级为 MODEL_FATAL (过去 2 轮即取消任务而非烧 6 轮 recode) |
| 8 | `engine/stages/cua-verify.cjs` | runCUAVerification catch 见 MODEL_FATAL re-throw |

同时 provider 侧在 throw 处前缀化:
- `lib/model-provider.cjs ClaudeProvider.generate/generateVision`: 响应体 error / HTTP 401 402 403 / parse-fail-on-4xx 全部前缀 `MODEL_FATAL:`
- `adapters/doubao-adapter.cjs`: `json.error.code + message` 扫 quota/insufficient/401/402/403/invalid_access_key/access_denied/billing 正则, hit 即 MODEL_FATAL 前缀
- `worker/codex-code-coder.js`: CLI early-exit 时扫 stdout+stderr auth/quota 正则, 命中前缀化

**Layer 2: 11 条黑屏规则 blocking + codegen 前置硬门**

`engine/static-check.cjs` 给 11 条会导致 Luna 黑屏/不可见的规则打 `blocking:true` 标记:
```
setactive / create-obj / create-ground / set-color / create-canvas /
create-primitive / destroy-call / instantiate / add-component /
renderer-material-color / new-material
```
新导出 `getBlockingIssues(code, ctx)` 只返 blocking 标记条目。

`engine/stages/codegen.cjs` 在拿到 csCode 和 extraFiles 后 (review 之前) 立刻扫 blocking issues, 命中则:
1. 前 10 条带行号摘要塞进 `ctx.blueprint.feedbackHistory`, 下一轮 AI prompt 明确知道要修什么
2. throw `Blocking static violations: N (first: <msg>)`, 强制 fix-loop 下一轮 recode

代码**连 compile 都到不了**, 把 3 个 stage 的损耗提前到 codegen 入口挡掉。partial class 文件 (GameFlowManagerMain.Systems.cs) 也一起扫。

**Layer 3: review 静态检查搬进 fix-loop 每轮都跑**

`engine/stages/review.cjs` 把原来入口一次性的 `staticCheck()` 删除, 搬进 fix-loop `attempt()` 每轮都跑。命中时合成:
```js
{
  passed: false,
  source: 'static-precheck',   // 不带 parseError/error 字段
  feedback: 'STATIC CHECK VIOLATIONS ...',
  issues: [...],
  criticalCount: N,
}
```
`source: 'static-precheck'` 且**没有** `parseError`/`error` 字段是关键 — 这样 codex→GPT 降级分支条件不触发, fix-loop 直接走 recode 路径, 不浪费第二次 LLM review。

**Layer 4: Claude provider Anthropic-native dual-mode**

`lib/model-provider.cjs ClaudeProvider` 双模改造:
- `ANTHROPIC_AUTH_TOKEN` 存在 → 走 `crs.mindrix.app/api/v1/messages` (Anthropic-native，同一条 CLI relay 链路，2026-04-15 实测稳定)
- 否则 → 旧的 `sub.mindrix.app/v1/chat/completions` (legacy fallback)

`generate` / `generateVision` 都适配了双响应格式:
- Anthropic-native: `content[{type:'text', text:'...'}]` + `usage.input_tokens/output_tokens`
- OpenAI-compat: `choices[0].message.content` + `usage.prompt_tokens/completion_tokens`

Usage 归一化: `input_tokens → prompt_tokens`, 保持 `visual-check [vision-cost]` 日志跨模一致。

`ecosystem.config.cjs`: `OPENAI_BASE_URL` 硬编码改 env-first (原硬编码覆盖 `.env` 的值导致静默降级), 新增 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 环境变量声明。

### 陷阱 / 教训

1. **"不要因为一个错误崩掉整个任务" 的防御性编程在多层叠加后会变成黑洞。** 每一层的 catch-all 都是 "少数错误变多数成功" 的权衡, 但当错误本身就是 "quota 耗尽 / 中转 503" 这种根本性故障时, 每多一层 catch-all 都等于多烧一倍的钱。**定性失败 (quota/auth/invalid-key) 必须立刻 cancel 任务, 跟瞬时错误 (ECONNRESET/502) 在分类器层面就要区分。**
2. **401/403 不是 INFRA 错误。** 重试 100 次还是 401。但 429 (rate limit) 是 INFRA — 短时间退避后可以继续。
3. **静态检查只在流程开头跑一次等于没跑。** 必须在每个 fix-loop 轮次 **前** 都跑, 并且命中时直接合成 passed:false 走 recode, 不能依赖 "下一轮 AI 自己从 feedbackHistory 读出来修"。
4. **黑屏级规则要在 codegen 阶段就拦截。** 到 review 阶段才拦截意味着白烧一轮 LLM token; 到 visual-check 才拦截意味着白烧 compile + Luna build (~80s) + CUA (~54s)。
5. **硬编码 URL 的中转迁移是定时炸弹。** `ecosystem.config.cjs` 把 `.env` 的值覆盖掉, 让所有 `process.env.OPENAI_BASE_URL` 读出来都是旧 URL — 改法是 env-first (`process.env.OPENAI_BASE_URL || '默认值'`)。
6. **codex 子进程环境变量污染。** `~/.codex/auth.json` 用的是 ChatGPT auth mode, 但如果 `OPENAI_API_KEY / CODEX_API_KEY / OPENAI_BASE_URL` 在 env 里就存在, codex 会切到 API key 模式直接撞 `api.openai.com`, 拿 mindrix 中转 key 去撞官方 API 必拿 401。修法是 `spawn()` 时显式从 env 里**剥离**这三个变量。

### 验证

`lib/model-provider.cjs healthCheck()` 三路全绿:
```
claude 1710ms  (Anthropic-native via crs.mindrix.app)
doubao 4501ms
gpt54  7172ms  (codex preflight cached)
```

bqh33t 任务已通过 `POST /api/tasks/proj_1776235585307_bqh33t/cancel` 取消, 状态 `cancelled`, 日志 `[Cancel Task] ... cancelled by claude:bqh33t-permanent-failure-2026-04-15`。

### 逃生口

`ALLOW_NO_REVIEWER=true` 环境变量保留无 key 本地测试场景, 默认关闭。

### 提交

- commit: `19e61c9` fix: MODEL_FATAL 贯穿闭环 + bqh33t 黑屏静态门 + Anthropic dual-mode (blueprint-editor, 16 文件)
- commit: `52e6faf` docs: INCIDENTS.md 新增 bqh33t 事故记录本条
- commit: `ab06e5c` fix: code-reviewer.js 拆除 3 处 silent-skip (MODEL_FATAL 闭环最后一环; 经用户明确授权 `--no-verify` 跳过 hook, 因改动不涉及 REVIEW_RULES 只改 fallback 分支)
- commit: `993069a` fix: CUA speed patch 类发现 3 层 fallback 鲁棒化 (cua-agent, runner.py 一个文件 — 解决 Bridge.NET 嵌套命名空间下 `GameFlowManagerMain` 硬编码失效, observe 模式游戏从 1x 降速导致 CUA 超时)

---

## 2026-04-15 16:40: Port-Guard 把 PM2 God Daemon 当端口占用者 SIGTERM 之 — 4 分钟全站下线

### 影响范围
`pm2 reload blueprint-editor` 触发级联下线: blueprint-editor + linux-worker-1 + linux-worker-2 三个 apps 同时 `Deleting process`, PM2 daemon 自身优雅退出。nginx 反代 `3901` 无后端 → 外部访问 `playcools.top/webgl/*` 全部 404/502, 持续 4 分钟 (16:40:32 ~ 16:44:54) 直到 `pm2 resurrect`。期间 CUA 太空捡垃圾任务 (bqh33t) 被 SIGINT 中断, 好在 2026-04-09 的 checkpoint 修复救了场, 恢复后继续跑。

### 根因
**`lib/port-guard.cjs` 与 PM2 cluster 模式的致命冲突**。

`server.cjs` 启动时调用 `killPortOccupier(3901)`, port-guard 用 `ss -tlnp sport = :3901` 找占用者 → SIGTERM。这在「手动 `node server.cjs` 忘了 kill 再启动」场景下是对的, 但 **PM2 cluster 模式下监听 socket 不是 worker 进程持有的**, 而是 PM2 God Daemon 自己持有再分发给 cluster workers:

```
ss -tlnp
LISTEN 0 511 *:3901 users:(("PM2 v6.0.14: Go",pid=2349527,fd=3))
```

所以新 cluster worker 启动时:
1. port-guard 查 3901 → 看到 PID 2349527
2. `process.kill(2349527, 'SIGTERM')` → **自杀 PM2 God Daemon**
3. Daemon 优雅退出 → 杀掉所有 managed apps

只要 cluster 模式 + port-guard 同时存在, 每次 `pm2 reload` (甚至 `pm2 restart`) 都会触发这个 bug。原先的 `feedback_pm2_reload_cascade.md` 错把根因归咎于 `pm2 reload` 语义, 实际上跟 reload/restart 无关 —— 是 port-guard 在 cluster 模式下根本不该运行。

### 修复方案 (双重防护)
| # | Fix | 文件 | 改动 |
|---|-----|------|------|
| 1 | PM2 下跳过 port-guard | `server.cjs` | `if (!process.env.pm_id) { killPortOccupier(PORT); }` — `pm_id` 是 PM2 注入的环境变量, 存在即 run under PM2, PM2 自己会处理端口移交 |
| 2 | 识别 PM2 拒绝杀 | `lib/port-guard.cjs` | 读 `/proc/<pid>/comm`, 正则匹配 `^PM2\b` 或 `God\s*Daemon` 则 return 不杀 — 防御纵深, 即使未来别的代码路径调用 killPortOccupier 也不会误杀 |

### 陷阱 / 教训
1. **cluster 模式的 app 不要跑 port-guard/lsof-kill/fuser-k 类逻辑** —— 监听 socket 是 God Daemon 持有的, 杀它就是自杀 daemon → 杀所有 apps
2. **fork 模式 worker 反而安全** —— linux-worker-1/2 是 fork 模式 (不监听端口), port-guard 不影响它们
3. **判断是否 run under PM2** 用 `process.env.pm_id` (或 `NODE_APP_INSTANCE`)
4. **诊断「pm2 突然全挂」** 第一时间看 `/root/.pm2/pm2.log` 有没有 `pm2 has been killed by signal` —— 正常 reload 不会出现, 只有外部 SIGINT/SIGTERM 到 daemon 才会

### 提交
- commit: `aae59bb` fix: port-guard SIGTERM PM2 God Daemon 致 4 分钟级联下线

---

## 2026-04-15: 3 任务无限烧钱 + Dashboard 状态停滞 (6 项 fix-loop 修复 + 5 项 dashboard 修复)

### 影响范围
3 个任务 (bqh33t, dmda29, yjrgmn) 连续运行 >2 小时未退出,每个任务烧掉预估 >50 美元 token; 与此同时 dashboard 首屏加载 ~10 秒、workers 永远显示 0/3 online、cancelled 状态永远不同步到项目 JSON — 运维侧完全看不到真实状态无法介入,形成"跑飞+瞎眼"复合故障。

### 根因分析

**根因 1: fix-loop `beforeRoundFn` 未 await, 导致 round 计数与实际执行错位**
- `engine/fix-loop.cjs` 的 retry hook 通过 fire-and-forget 调用,`round++` 继续而副作用还在 pending
- cua-verify 的 claude-code 生成在第 N 轮还在执行时,日志里已经是第 N+1 轮,circuit breaker 用 round 计数永远触发不到
- 表象: 3 任务都看到 "CUA round X failed, AI re-coding..." 循环但无退出

**根因 2: 同 CODE error 反复出现但从无熔断**
- fix-loop 只对连续 round 无进展做检查,同一条错误 A->B->A->B 振荡时每次都 reset counter
- `visual-check` 的 "Could not parse analysis response" 错误重复 3 轮后仍继续 recode,每轮 ~7 分钟
- 同理 `compile.cjs` 的 same-error exit 原本用"连续匹配",A->B->A->B 也能逃过

**根因 3: CUA visual_freeze 被错误分类为 CODE 继续重试**
- error-classifier 的 `CUA_FATAL_PATTERNS` 只有 `CUA total time limit`,visual_freeze 没进 FATAL
- 画面冻结通常是 Camera/Canvas/初始化问题,claude-code incremental-fix 根本改不动
- 每轮烧 $5-10 的 claude-code 调用,跑满 10 round 纯浪费

**根因 4: 手动 cancel 无法传到 worker, pipeline 继续烧钱**
- 无论从 dashboard 点 cancel 还是改 task status,worker 端完全没有机制感知
- 只能等 worker 任务跑完(或崩溃)才会停下

**根因 5: Watchdog reclaimStale 无限循环没有 retry counter**
- 任务被 watchdog reclaim 后回到 pending,下一个 worker 拿到后又走 processing,又超时又被 reclaim
- 无 `infra_retry_count` 限制 → 永远不会走到 permanent_fail
- 配合根因 1/2/3 形成复利,3 任务反复消耗 token 预算

**根因 6: Watchdog 抢任务 — worker 刚启动就被抢走 checkpoint**
- worker 重启后在 recover checkpoint(需要几秒到几十秒),watchdog 一轮是 120s
- 如果 worker 启动时刻正好临近 watchdog cycle,会在 checkpoint 还没稳定时被当成 stale reclaim
- 表象: bqh33t 在 worker-1 重启后立刻被 watchdog 判定 stale 放回 pending

**根因 7 (dashboard): workers 永远 offline — UTC 时区 bug**
- `lib/task-queue.cjs` stats() 的 `new Date(last_seen)` 没有 `'Z'` 后缀
- SQLite 存 UTC 但 JS 按本地时间 (CST) 解析,差 8h
- `(now - heartbeat) < 90s` 永远 false,所有 worker 显示 offline,online=0

**根因 8 (dashboard): 首屏加载 ~10 秒**
- `/api/dashboard/api-health` 每次请求同步 ping Doubao (~5.5s) + Claude (~0.4s)
- 前端 dashboard mount 时调用,阻塞首屏渲染
- 没有缓存、没有并发去重

**根因 9 (dashboard): 状态机 cancelled 完全缺失**
- `lib/state-machine.cjs` PROJECT_TRANSITIONS 根本没有 cancelled 条目,大部分非终态也没有 `→ cancelled` 转出
- `forceTransition` 对无效转换只 warn 不抛,但 cancelled 项目的 status 永远停留在 processing/failed
- 配合 F14-desync 缺失,UI 上看不到任何 cancelled 项目

**根因 10 (dashboard): Phase 2 F14-desync 只覆盖 3 个 case**
- `api/dashboard.cjs` runWatchdogCycle 的 desync 检测是硬编码的 3 个分支
- cancelled/done/cua_passed 都没覆盖,task 已经结束但项目文件还是 processing/failed
- 没有扫描 cancelled tasks → 手动 cancel 后永远不同步

**根因 11 (日志污染): Worker 每次 fix round 都触发 "Invalid transition: processing → processing"**
- `api/worker.cjs` workerStatus 每次收到 worker 汇报都 `projectSM.forceTransition`
- 没有 no-op/regression guard,相同状态/退化转换全部打印 warn
- 日志被刷屏,真正的问题被掩盖

### 修复方案

| # | Fix | 文件 | 改动 |
|---|-----|------|------|
| A | retry counter | `lib/task-queue.cjs` | `reclaimStale()` 给每次 reclaim 累加 `infra_retry_count`,超过 5 次直接 permanent_fail |
| B | uptime grace | `lib/task-queue.cjs` | worker uptime <180s 的不抢任务 (让刚重启的 worker 稳定 checkpoint) |
| C | beforeRoundFn await | `engine/fix-loop.cjs` | hook 改成 Promise.resolve().then().catch(),确保下一 round 拿到完成的状态 |
| D | 同 CODE 错误熔断 | `engine/fix-loop.cjs` | 签名前 120 字符匹配,连续 3 轮同一错误 → 抛 `FIX_LOOP_CIRCUIT_BREAKER` |
| D' | 同 build 错误计总数 | `engine/stages/compile.cjs` | `errSigCounts` 按签名累计 (不是连续),A->B->A->B 振荡也能触发 |
| E1 | visual_freeze → FATAL | `engine/error-classifier.cjs` | `CUA_FATAL_PATTERNS` 加 `/Visual freeze FATAL/i` |
| E2 | visual_freeze 3 轮熔断 | `engine/stages/cua-verify.cjs` | `stuckDiagnosis.rootCause === 'visual_freeze'` 且 `_noProgressRounds >= 3` 直接 throw |
| F1 | status/cancel 端点 | `api/worker.cjs` `api/router.cjs` | 新增 `GET /api/tasks/:id/status` + `POST /api/tasks/:id/cancel` |
| F2 | worker poller | `worker/linux-worker-client.js` | processTask 起 30s 间隔 `checkTaskCancelled`,检测到 cancelled 置 `ctx._cancelled` |
| F3 | pipeline unwind | `engine/pipeline.cjs` | `runNext()` 开头检查 `ctx._cancelled` 抛 `TaskCancelledError`; tryExecute.catch 放行不重试 |
| F4 | worker catch 识别 | `worker/linux-worker-client.js` | 外层 catch 见 `TaskCancelledError` → 清 checkpoint + 静默 return, 不 `reportStatus('failed')` |
| G | UTC 时区 fix | `lib/task-queue.cjs` | `new Date(workers[j].last_seen + 'Z')` 强制按 UTC 解析 |
| H | api-health 缓存 | `api/dashboard.cjs` | 模块级 `apiHealthCache` + 启动 prime + `setInterval(refresh, 30s)`; 请求路径只读缓存 |
| I | 状态机补 cancelled | `lib/state-machine.cjs` | 所有非终态 PROJECT/TASK TRANSITIONS 加 `→ cancelled`; 终态加 `cancelled: []` |
| J | F14-desync 扩展 | `api/dashboard.cjs` | `TASK_TO_PROJECT` 映射表覆盖所有 task status (target + compatible[]); 额外扫 `taskQueue.list('cancelled')` 立即同步 |
| K | no-op/regression 抑制 | `api/worker.cjs` | `workerStatus` 在 forceTransition 前检查 `isNoop` 和 `isRegression` (building→processing 等),跳过不打印 |
| L | uptime 进 heartbeat | `worker/linux-worker-client.js` | heartbeat payload 加 `uptime: (Date.now() - WORKER_START_TIME)/1000`,配合 Fix B |

### 陷阱 / 教训
1. **`var { projectSM } = require(...)` 写进 docblock** — 编辑文件头部时,require 不小心插到 `/** ... */` 之间,`node -c` 通过但运行时 `ReferenceError: projectSM is not defined`,F14-desync 首次触发整个 watchdog 崩溃一整轮。教训: 追加顶部 require 必须以 `*/` 之后的行为锚点。
2. **ScheduleWakeup 无法取代监督闭环** — 没有 dashboard + F14-desync + cancel 机制,"跑飞任务"完全不可见。任何长期 pipeline 必须有外部杀开关,不能只靠内部 circuit breaker。
3. **UTC vs local time** — SQLite `datetime('now')` 存 UTC (无后缀),JS `new Date(x)` 对无后缀字符串按本地时间解析,差 8h。这个 bug 可以潜伏数月,只要整个链路都在本地读写就不暴露,一旦跨 timezone 比较就全线翻车。
4. **fix-loop 的 fire-and-forget hook** — JS 的 async 没有强制 await,代码看起来能跑,但 round 计数和实际执行会错位。所有 hook 必须返回 Promise 且被 await。
5. **docblock 内的 require 陷阱** — 见 `CODEX_HOME/projects/-root/memory/feedback_require_in_docblock.md`（旧环境仍可兼容回退到 legacy home memory 路径）。

### 提交
- commit: `86a1469` fix: 3 任务无限烧钱 + dashboard 瞎眼 — fix-loop/状态机/desync 12 项修复
- commit: `ad6a2ee` feat: dashboard 4-API 健康展示 + Claude /v1/v1 URL bug + GPT-5.4 preflight 原因细化

### 验证结果
- Watchdog Run #1 (post fix): 检出 yjrgmn + dmda29 两个 "失败但 task=cancelled" desync,两条 fix 执行成功,项目文件写入 `status=cancelled`
- `/api/dashboard/api-health` 延迟: 6-10s → 5ms
- Workers online 显示: 0/3 → 2/3 (真实在线的)
- bqh33t 继续在 worker-2 checkpoint 恢复跑,未被本次重启打扰 (只重启了 blueprint-editor + idle 的 worker-1)
- 无 "Invalid transition" 日志

---

## 2026-04-14: 3 worker 全线 compile 失败级联 (5 根因 + 1 环境修复)

### 影响范围
3 个 worker 所有 compile 任务 ECONNRESET / csCode required / ENOENT iframe.html / codegen 同步崩溃。持续近 1 小时才完整定位,每次修一层又出下一层。

### 根因分析

**根因 1:双 .env 路径不匹配,LINUX_BUILD_URL 静默 fallback 到僵尸远端**
- `linux-worker-client.js:15` dotenv 加载 `__dirname/../.env` → **parent `.env`**(API 密钥),
  而 `LINUX_BUILD_URL` 等 10 个键写在 `worker/.env` 里
- 子 `.env` 从未被读到,worker 走硬编码 fallback `http://120.55.70.226:3080`
- 该端口 LISTEN 但响应 `Empty reply from server`(僵尸服务),所有请求 ECONNRESET
- 表象指向网络/服务挂了,实际是配置加载错了文件

**根因 2:build-api 字段重命名 `code` → `csCode`,helpers.cjs 未同步**
- `/opt/luna-poc/build-api.js`(新)要求 `csCode`,legacy `linux-bridge-build.js` 要求 `code`
- `helpers.cjs:buildRequest` 和 coder worker 里的 `build-test.sh` Python payload 都只发 `code`
- 修复根因 1 后立即暴露:`{ok:false,error:"csCode required"}`

**根因 3:`/build-html` 端点被移除,HTML 改为 `htmlBase64` 内联**
- 新 build-api 只有 `/build`,返回 `{ok, buildTime, htmlSize, htmlBase64}`
- `compile.cjs:49` 还在调 `helpers.buildRequest(buildUrl, '/build-html', ...)` 期望 Buffer
- 修复根因 2 后立即暴露:`/build-html` 404

**根因 4:`if (skeleton.split)` 方法名 truthy 陷阱**
- coder worker 里想判断 skeleton 是 split-mode 对象(generator 返回 `{main,systems,split:true}`)
- 但字符串也有 `.split` — `String.prototype.split` 是函数,**永远 truthy**
- ≤10 phases 返回普通字符串时,分支误入多文件路径,`fs.writeFileSync(path, skeleton.main)` = undefined → 同步 throw
- 4 个 codegen round 同一秒全失败(特征:时间戳相同 = 同步错误,非 LLM/网络)
- 以前被"first 3 phases limit"掩盖,改成 all phases 后命中 10 phases 临界

**根因 5:stage4-template 缺 `iframe.html`(环境,非代码)**
- `linux-bridge-build.js:621` `convertToSingleHTML` 无存在检查 `fs.readFileSync(stage4Dir + '/iframe.html')`
- `/opt/luna/stage4-template/` 只有 `index.html`,没有 `iframe.html`
- 用户手动将 iframe.html 放入模板目录后解决
- 代码侧建议后续在 `convertToSingleHTML` 加 existsSync + generateIframeHTML() fallback(generator 函数已存在但从未被调用)

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| LINUX_BUILD_URL 配置到被加载的 .env | `/opt/blueprint-editor/.env` | 新增 `LINUX_BUILD_URL=http://127.0.0.1:18860` |
| BUILD_URL fallback 去掉僵尸远端 | `worker/linux-worker-client.js:327` | `120.55.70.226:3080` → `127.0.0.1:18860` |
| buildRequest 双字段兼容 shim | `engine/helpers.cjs` | 同时发 `csCode` 和 `code`,`/build-html` 路由到 `/build` + base64 解码 |
| build-test.sh Python payload | `worker/codex-code-coder.js` | `{'code':code}` → `{'csCode':code, 'code':code}` |
| skeleton 分支判断改为 typeof | `worker/codex-code-coder.js` | `if (skeleton.split)` → `if (typeof skeleton === 'object' && skeleton.split === true)` |
| pending-rules.json 清理污染 | `worker/pending-rules.json` | 移除 outage 期间误捕获的 csCode required / iframe.html 条目(它们是环境失败,不是代码质量问题) |

### 验证结果
- Worker 2 proj_1776165800102_yjrgmn 首次完整通过 compile:`Build OK in 7s, HTML: 1.1MB`
- `[prompt-cache]` 日志显示系统提示文件 sha1 跨 worker 一致 — prompt cache 应命中
- Worker 1 zxpzt4 突破 codegen 同步崩溃,进入正常 INCREMENTAL_FIX 流程

### 教训
1. **dotenv 路径一定要确认加载的是哪个文件** — `grep -l KEY .env worker/.env` 秒验;不要假设近邻的 `.env` 被读到
2. **fallback 默认值不要是死服务地址** — 宁愿 throw 也不要静默降级到僵尸
3. **JS `if (obj.X)` 陷阱** — 当 X 是常见方法名(`split`/`map`/`length`/`forEach`)时一定要 `typeof` 或显式比较值
4. **"N 轮同秒失败"特征** — 几乎一定是同步 throw,不要先怀疑 LLM/网络/超时,直接搜 throw 路径
5. **Auto-learner 需要 failClassification 白名单** — pending-rules.json 自动捕获机制对 `compile stage failure` 无差别收录,会把环境/网络错误当代码问题注入下次 prompt,长期会放大噪声
6. **多层级联修复的副作用** — 每修一层就暴露下一层,耗时很长;遇到这种场景要提前假设"这不是最后一层"并做好流水线 health check

## 2026-04-01: 凌晨6项目全部失败

### 影响范围
6个项目全部 failed：卖水(pt2ysl)、救人泡澡(z43qrz)、子弹模具(wxfmbx)、制作子弹(1sjld8)、太空卖氧气(k0rbwx)、回收子弹(mwduot)

### 根因分析

**根因 1：CUA API 临时故障被误判为代码问题**
- 凌晨 CUA API（OpenAI computer-use-preview）返回 401/503
- luna-agent.js 静默重试 15 轮，产生空报告
- worker 把空报告判定为"代码有问题"，触发 AI 重写代码
- 实际上代码没问题，是 API 暂时不可用

**根因 2：autoPlayVerify 降级通道从未执行**
- quickPlayTest 在 headless 环境检测到 rendererCount=0（Luna 的已知假阳性）
- quickTest 失败后直接 `return { passed: false }`，跳过了所有下游逻辑
- autoPlayVerify 只存在于 luna-agent 返回报告后的分支中，quickTest 的 early return 永远到不了

**根因 3：学习系统断路 — 270条规则、40条黑屏规则，AI 完全不知道**
- pending-rules.json 积累了 270 条生产失败规则
- 但 AI 编码 prompt 里没有注入任何历史教训
- promotion 算法用关键词匹配，把 "Camera.main" 拆词后匹配失败
- 结果：同样的黑屏、Camera.main、CreatePrimitive 错误反复出现

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| API 故障早期检测 | luna-agent.js | 连续5次 API 错误提前退出，标记 `api_failure` |
| quickTest→autoPlay 降级 | worker-cua-verify.js | quickTest 失败先尝试 autoPlay 再放弃 |
| api_failure→autoPlay 降级 | worker-cua-verify.js | CUA API 不可用时自动降级 |
| 基础设施/代码区分 | linux-worker-client.js | infraFailure 不触发代码重写 |
| 指数退避重试 | server.cjs | 基础设施失败 5→80 分钟退避，最多5次 |
| 历史教训注入 | prompt-v5-basetemplate.js | top 10 跨项目规则注入 AI 编码 prompt |
| 动态规则审核 | codex-reviewer.js | promoted + pending 规则注入 Codex 审核 |
| promotion 算法重写 | code-reviewer.js | 按 rule 分类聚合替代关键词匹配 |

### 提交
- commit: `993b09d` fix: 凌晨6项目全部失败根因修复

### 后续措施
- pending-rules.json 从 270 条清理至 30 条（去重、合并同类、清理 CUA 运行时噪音）
- 建立规则定期维护机制（见 build-pipeline.md）

---

## 2026-04-01: Pipeline 模型大迁移

### 背景
原 Pipeline 大量依赖 GPT-5.4（sub.mindrix.app 中转）和 Gemini（sub.mindrix.app 中转）。
凌晨 CUA API 故障导致 6 项目全部失败（见上方事故），暴露了单点依赖风险。
决定全面替换为多模型分工方案。

### 迁移清单

| 环节 | 旧模型 | 新模型 | 文件 |
|------|--------|--------|------|
| 分镜文件→蓝图帧 | GPT-5.4 (primary) + Gemini (fallback) | **豆包 Seed 2.0 Pro** | `storyboard-parser.cjs`, `python/storyboard_parser.py` |
| 一键PDF→V4蓝图 | GPT-5.4 | **豆包 Seed 2.0 Pro** | `python/pdf_to_blueprint.py` |
| 蓝图帧→V4实体蓝图 | GPT-5.4 | **Claude Opus 4.6** (fallback: 豆包) | `python/blueprint_converter.py`, `server.cjs` |
| Spec 提取 | Gemini | **豆包 Seed 2.0 Pro** | `spec-extractor.cjs` |
| AI 编码 | Claude Opus 4.6 | 不变 | `worker/worker-coder.js` |
| 代码审核 | GPT-5.4 | **GPT-5.4** (保留) | `worker/code-reviewer.js` |
| 截图审核 | Gemini | **豆包 Seed 2.0 Pro** | `screenshot-review/screenshot-review.cjs` |
| CUA 验证 | GPT-5.4 CUA (luna-agent.js) | **PlayableAgent** (Qwen2.5-VL-72B) | `worker/worker-playableagent.js`, `server-cua-review.cjs` |
| 竞品参考→蓝图 | Gemini 2.5 Pro | **豆包 Seed 2.0 Pro** | `worker/reference-to-blueprint.js` |
| 视频分析→蓝图 | Gemini 2.5 Pro | **Gemini** (保留) | `worker/video-to-blueprint.cjs` |
| API 健康检查 | ping GPT-5.4 + Gemini | **Claude + 豆包 + Gemini** | `server.cjs` |

### PlayableAgent 替换 CUA 详细说明
- 旧方案：`luna-agent.js` 调 GPT-5.4 CUA (computer-use-preview) 操控浏览器
  - 依赖 `OPENAI_API_KEY` + 代理，凌晨 401/503 导致全线失败
- 新方案：`worker-playableagent.js` 调 `blueprint_verify.py` (Python 3.8)
  - VLM 截图分析 (Qwen2.5-VL-72B via SiliconFlow) + `__gameState` API 读取 Phase 进度
  - Xvfb + Playwright 非 headless 模式渲染 WebGL
  - 同接口: `runCUAVerification(buildDir, blueprint, taskId, log) → {passed, issues, report}`
  - 三个入口全部替换: `worker-client.js`, `linux-worker-client.js`, `server-cua-review.cjs`

### 备份文件
- `python/storyboard_parser.py.bak.gpt54`
- `python/blueprint_converter.py.bak.gpt54`
- `python/pdf_to_blueprint.py.bak.gpt54`
- `storyboard-parser.cjs.bak.gemini`
- `spec-extractor.cjs.bak.gemini`
- `screenshot-review/screenshot-review.cjs.bak.gemini`
- `worker/code-reviewer.js.bak.claude`
- `worker/luna-agent.js.bak.gemini`

### 影响
- GPT-5.4 仅保留：代码审核 (`code-reviewer.js`) + 图片生成 (`gpt-image-1`)
- Gemini 仅保留：视频分析 (`video-to-blueprint.cjs`)
- 豆包成为分镜解析/Spec/截图审核/竞品参考的主力
- Claude 成为编码/蓝图转换的主力
- PlayableAgent 完全替代 CUA，消除 OpenAI CUA API 单点依赖

---

## 2026-04-02: Luna 7.1.0 升级后黑屏 — 双重根因修复

### 背景
从 Luna 6.4.0 升级到 7.1.0，同时将 90 个无颜色池对象替换为 160 个预烘焙颜色池对象。
升级后所有构建产出均为黑屏。

### 根因分析

**根因 1：Bridge.NET 类重复定义**
- Luna 7.1.0 的 stage4 模板 engine/scripts.js 已包含 stub `Bridge.define("GameFlowManagerMain", {Start:function(){},Update:function(){}})`
- 构建时将用户编译的 JS 直接拼接到引擎末尾，再次 `Bridge.define("GameFlowManagerMain", ...)`
- Bridge.NET 运行时检测到重复类定义，抛出 `"Class 'GameFlowManagerMain' is already defined"` 异常
- 异常为 Promise rejection，无明显堆栈，表现为静默黑屏

**根因 2：引擎 loadSettings 空指针崩溃**
- 7 个 `loadSettings` 函数（loadSortingLayerSettings 等）直接访问 `e[te.sortingLayers].length`
- 当项目设置数据缺失时，返回 null，导致空指针崩溃
- 表现为引擎初始化阶段崩溃 → 黑屏

### 排查过程
1. 初始怀疑：`convertToSingleHTML` 的 XHR 拦截器不兼容新引擎 → 排除（cache/*.js 是非必要文件）
2. 尝试用旧引擎 + 新 bundle → 不兼容（Deserializers 格式不匹配）
3. 搭建 CDP（Chrome DevTools Protocol）调试环境，捕获运行时异常
4. 定位到 exception at line 304 col 258789 → Bridge.NET class registration throw
5. 确认 `Bridge.define("GameFlowManagerMain")` 在引擎中出现 2 次

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| stub 类剥离 | `worker/linux-bridge-build.js` | `assembleStage4()` 拼接前用正则去除模板中的 stub GameFlowManagerMain |
| 引擎 null guards | `/opt/luna/stage4-template/engine/scripts.js` | 7 个 loadSettings 函数添加 `if(!n)return;` |

### 验证结果
- 173 个实体全部加载，160 个池对象确认存在
- 0 个 JS 异常
- 截图中确认 Red/Blue/Green/Yellow/Purple 颜色正确渲染
- 构建耗时 6 秒，HTML 7MB

### 提交
- blueprint: `08faf21` fix: strip stub GameFlowManagerMain from engine to prevent class redefinition crash
- luna-base-template: `9b89483` fix: add patched stage4 engine with null guards for loadSettings functions

### 教训
1. **拼接引擎 + 用户代码时，必须检查命名冲突** — 模板引擎已有 stub 类，用户代码再定义同名类会崩溃
2. **Promise rejection 在 headless Chrome 中几乎不可见** — 需要通过 CDP `Runtime.exceptionThrown` 才能捕获
3. **Luna 7.1.0 单文件格式的 cache/*.js 是非必要文件** — 它们引用 `decompressArrayBuffer` 等未定义函数，说明不应被加载
4. **headless Chrome 需要 20+ 秒才能完成 6MB JS 引擎的解析和执行** — 不要因为前 10 秒无响应就认为加载失败

---

## 2026-04-02: BUG-0012 磁盘满致项目丢失 + AI编码只实现3/11 phase

### 影响范围
6个项目全部不可见或失败：
- 项目列表 API 返回 500（看起来"任务丢失"）
- 3个项目 failed: 制作子弹(stub代码)、卖水(phase-skipped)、子弹模具(phase-skipped)
- 3个项目 stuck: 救人泡澡、太空卖氧气、回收子弹（ENOSPC后卡死）

### 根因分析

**根因 1：ENOSPC 导致 JSON 写入截断**
- 磁盘 93% 满，worker 写项目 JSON 时空间耗尽，文件被截断为非法 JSON
- `listProjects()` 用 `files.map(JSON.parse)`，一个文件解析失败整个 API 返回 500
- 用户看到的是"任务全部丢失"

**根因 2：Skeleton 只生成前 3 个 phase**
- `MAX_INITIAL_PHASES = 3` 限制骨架只覆盖 3/11 phase
- AI 在 `$5` budget 内来不及读完大 prompt 就耗尽预算，产出 9 行 stub 代码
- 即使代码生成成功，也只实现 3 个 phase，CUA 检测到 game_ended 后 phase-skipped

**根因 3：CUA 反馈未有效传递给 AI**
- 增量修复 prompt 写"请阅读 prompt.md 了解反馈"，但 AI 不一定会读
- 4 轮修复产出完全相同的代码（卖水 507 行，子弹模具 525 行，字节级相同）

**根因 4：Codex 审核失败后继续构建**
- Codex 连续 3 轮检测到 critical issues，但 pipeline 仍继续到 CUA
- 浪费 CUA 资源验证已知有严重问题的代码

**根因 5：FULL_GENERATION 切换时清空所有上下文**
- 连续 2 轮同一问题时切换全量重生成，但 `feedbackHistory = []` 清空了失败原因
- AI 没有任何线索知道之前为什么失败，产出相同代码

### 修复方案

| # | 修复项 | 文件 | 改动 |
|---|--------|------|------|
| 1 | listProjects 单文件容错 | `server.cjs` | map→forEach+try/catch，跳过损坏文件 |
| 2 | Budget 取消上限 | `worker/codex-code-coder.js` | `--max-budget-usd` 默认 0（不传），不再限制 |
| 3 | Skeleton 覆盖全部 phase | `worker/codex-code-coder.js` | 移除 `MAX_INITIAL_PHASES=3`，所有 phase 生成骨架 |
| 4 | Codex 审核失败阻断构建 | `worker/linux-worker-client.js` | criticalCount>0 时 return failed，不继续到 CUA |
| 5 | CUA 反馈直接注入 prompt | `worker/codex-code-coder.js` | 反馈文本直接写进 userPrompt，不依赖 AI 读 prompt.md |
| 6 | FULL_GENERATION 携带原因 | `worker/linux-worker-client.js` | 保留失败摘要+明确指令，避免产出相同代码 |

### 提交
- commit: `4f0f976` fix: 流水线5项关键修复

### 教训
1. **写文件必须有原子性保障** — JSON 写入被截断是致命的，应该 write-to-temp + rename
2. **API 容错是底线** — 单个数据文件损坏不应导致整个列表接口不可用
3. **Skeleton 限制 3 phase 是错误的优化** — 省下的 token 不值得丢失 8 个 phase 的代价
4. **$5 预算对复杂蓝图不够** — 29KB prompt + 多文件读取就耗尽预算，AI 还没开始写代码
5. **反馈必须直接注入 prompt** — 不能假设 AI 会主动去读某个文件
6. **重生成必须携带失败原因** — 否则 AI 没有任何信号避免重复同样的错误

---

## 2026-04-03: V3 代码清除 + 三项关键 Bug 修复

### 背景
4月2日重新提交6个项目后全部再次失败，深度排查发现3个根因。

### 根因分析

**根因 1：CLI coder 秒退被误判为成功**
- coder worker 在调用模型前预写 skeleton 到 .cs 文件
- Claude 退出后检查**文件是否存在**来判断成功 → skeleton 永远存在 → 永远 "partial success"
- 结果：未修改的 skeleton（满是 `true /* TODO */` 占位符）被当作有效代码
- 游戏所有 phase 瞬间触发 → 3秒结束 → phase-skipped

**根因 2：Doubao API TLS 断连导致 spec 截断**
- mihomo (clash-meta) 运行在 `global` 模式，所有流量走海外代理
- Doubao (volces.com) 是国内服务，海外节点 TLS 握手失败 (SSL_ERROR_SYSCALL)
- spec-extractor 只提取出 1/11 个 spec，skeleton 只有 210 行
- 配置中已有 `DOMAIN-SUFFIX,volces.com,DIRECT` 规则，但 global 模式下被忽略

**根因 3：V3 蓝图格式兼容性 Bug**
- `linux-worker-client.js` 只检查 `blueprint.nodes.length`
- V4 蓝图使用 `entities[]` 而非 `nodes[]` → 4个项目被误判为空蓝图
- 下游 `worker-coder.js` 已有 V4 支持但永远执行不到

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| 骨架误判修复 | `worker/codex-code-coder.js` | 检查文件 mtime 是否变化，而非是否存在 |
| CLI 秒退检测 | `worker/codex-code-coder.js` | exit code≠0 + <10s + stdout<200字符 → 直接失败 |
| Spec 截断重试 | `spec-extractor.cjs` | specs 数量 < 50% frames 时自动重试（最多3次） |
| Clash 路由修复 | mihomo config | global → rule 模式，TUN 保持开启，volces.com 走直连 |
| **V3 代码全面清除** | 多文件 | 删除 ~1400 行 V3 代码，仅保留 V4 entity-driven 路径 |

### V3 清除详情

**删除的 V3 代码路径：**
- `worker-coder.js`: 删除 `parseBlueprintToPrompt`、`parseBlueprintToLegacyScenes`、V3 生成路径、`verifyCodeContent` (~1383 行)
- `server.cjs`: shotCount → entityCount/phaseCount，删除 objectRegistry/globalParams
- `linux-worker-client.js`: V3 nodes 检查 → V4 entities only
- `prompt-v4.js` / `prompt-v5-basetemplate.js`: V3 nodes fallback → 无 phases 时报错
- `worker-playableagent.js`: V3 phaseNode fallback → 要求 specs 文件

**归档到 `_deprecated_v3/`：**
- `upload-v4.cjs`、`server-utf8.cjs`、`scripts/submit-blueprint.cjs`、`scripts/frames-to-blueprint.cjs`

### 后续
- V3 格式不再支持，所有项目必须使用 V4 entity-driven 蓝图

---

## 2026-04-08: Gemini清理 + LLM链路修复 + Worker心跳/认证修复

### 影响范围
全部pipeline任务（64次历史运行0%成功率），3个在跑任务反复失败

### 根因分析

**根因 1：Worker heartbeat 始终上报 idle（linux-worker-client.js:569）**
- heartbeat 固定发 `status: 'idle'`, 无 `currentTask` 字段
- watchdog `reclaimStale(300, 180)` 5分钟后判定 desync → 强制回收正在跑的任务
- 级联效应：任务在 worker 间弹来弹去 → Claude slot lock 泄漏 → API 限流

**根因 2：CLI 认证失败（现实现位于 `worker/codex-code-coder.js`）**
- env 覆盖 `ANTHROPIC_API_KEY` 为 GLM key + `CLAUDE_CODE_SIMPLE: '1'` 禁用 OAuth
- 系统实际用 OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`)，不是 API key
- Claude CLI 2秒退出 exit code 1

**根因 3：Spec提取失败 — Gemini key过期 + DoubaoProvider格式错误**
- spec-extractor 硬编码 `createProvider('gemini', {})`，Gemini API key 已过期
- 改为Doubao后发现 DoubaoProvider 将 prompt 字符串直接传给 adapter
- adapter 的 `for (const c of contents)` 对字符串逐字符迭代，产生垃圾消息
- system prompt (`{system, user}` 格式) 被丢弃，temperature/maxTokens 未传递

**根因 4：dotenv 路径错误（linux-worker-client.js:15）**
- `__dirname + '/.env'` 指向 `worker/.env`（不存在）
- 实际 .env 在 `../`，导致 `DOUBAO_API_KEY` 为空

**根因 5：Slot lock 清理不完整（现实现位于 `worker/codex-code-coder.js`）**
- 只靠 25min mtime 超时，不检测持锁进程是否存活
- worker crash 后 lock 残留，占位直到超时

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| heartbeat上报busy+taskId | linux-worker-client.js | activeTasks>0时报busy |
| CLI OAuth认证 | codex-code-coder.js | 移除env覆盖,用OAuth |
| 去除Gemini依赖 | model-provider.cjs | 删除GeminiProvider,chain改为Doubao→Claude |
| spec-extractor直连Doubao | spec-extractor.cjs | createProvider('doubao') |
| DoubaoProvider格式修复 | model-provider.cjs | prompt→[{role,parts}],传system/temp/maxTokens |
| dotenv路径修复 | linux-worker-client.js | __dirname+'/.env' → '../.env' |
| PID存活检测 | codex-code-coder.js | process.kill(pid,0)检测死进程 |
| Gemini变量名清理 | storyboard-parser.cjs, doubao-adapter.cjs | _geminiKey→_doubaoKey等 |
| ecosystem清理 | ecosystem.config.cjs | 移除GEMINI_*环境变量 |

### 验证结果
- Spec提取：3个任务全部成功提取11个phase specs（之前100%失败）
- Claude CLI：Opus 4.6成功启动codegen（之前2秒退出）
- Heartbeat：worker正确上报busy+taskId（之前被watchdog反复抢任务）

### 教训
1. 变量命名应与实际服务一致，_geminiKey 实际是 Doubao key 造成长期混淆
2. dotenv path 用 `__dirname` 时需注意 worker 子目录 vs 项目根目录
3. LLM adapter 层必须有格式校验，字符串 vs 数组语义差异导致静默失败
4. heartbeat 是 watchdog 的唯一信号源，错误上报会级联放大为全系统故障
- `video-to-blueprint.cjs` 仍输出 V3 格式，需后续迁移至 V4

---

## 2026-04-16: build-api 6.4.0→7.1.0 升级 — Bridge is not defined 黑屏

### 背景
proj_1776297105366_xrbkl1 (太空捡垃圾) 视觉预检连续失败：
`ReferenceError ('Bridge is not defined')` — 全帧黑屏，AI recode 修不好。

### 根因分析

**根因：build-api 版本滞后，与 7.1.0 模板架构不匹配**

| 组件 | 路径 | 版本 | 行数 |
|------|------|------|------|
| build-api 使用的 | `/opt/luna-poc/linux-bridge-build.js` | 6.4.0 多文件 | 838 |
| worker 侧已更新的 | `/opt/blueprint-editor/worker/linux-bridge-build.js` | 7.1.0 单文件 | 1025 |

- 4月2日 stage4-template 迁移到 7.1.0 单文件架构 (`index.html` + `engine/scripts.js`)
- worker 侧 `linux-bridge-build.js` 同步更新（index.html → iframe.html 兼容复制 + scripts.js 拼接）
- **build-api (`/opt/luna-poc/`) 从未同步**，仍然用 6.4.0 多文件逻辑（读 iframe.html → inline 19 个独立 engine JS）
- 4月14日 23:08 有人手动添加了一个 6.4.0 格式的 iframe.html 试图修复，但没有添加对应的引擎文件
- 结果：18 条 `<script src="engine/...">` 全部 404 → Bridge 未定义 → 黑屏

### 修复

1. **build-api 升级**：`/opt/luna-poc/linux-bridge-build.js` 替换为 worker 侧 7.1.0 版本 (838→1025 行)
2. **build-api 重启**：kill 旧进程 (pid 1943443, 4月12日启动) → 启动新进程
3. **stage4-template 清理**：移除 6.4.0 遗留 (iframe.html, engine/unity/bin/, engine/luna/, js/)
4. **全面清除 6.4.0 残留**：
   - 删除 5 个备份目录 (~90MB)
   - 更新 render-iframe.js 默认版本 6.4.0→7.1.0
   - 更新 worker-cua-verify.js 注释
   - 更新 deserializers.js 版本字符串
   - 更新 Pro/luna.json, packages-lock.json, Bee cache 引用

### 验证
- 烟雾测试：POST /build → 7.3MB HTML（之前坏的 1.1MB），所有引擎 inline 标记存在，0 残留外部标签
- xrbkl1 重新提交后：CUA 覆盖从 0/11 (visual_freeze) 提升到 10/11 (phase-skipped)

### 教训
1. build-api 与 worker 共享 `linux-bridge-build.js` 但各自维护副本 — 迁移时必须两端同步
2. `convertToSingleHTML` 找不到文件时静默 `return match` 是危险设计 — 应该 throw
3. compile 阶段 `htmlData.length > 10240` 检查不够 — 应验证关键 inline 标记存在
4. visual-check 识别黑屏但路由到 C# recode — 对构建级故障应走 MODEL_FATAL 而非 recode
