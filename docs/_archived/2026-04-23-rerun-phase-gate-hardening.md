# 2026-04-23 rerun + phase-gate hardening

## 背景

`2026-04-23 00:00` 到 `00:30`（北京时间，UTC+8）重新拉起 6 个历史失败任务后，线上再次出现：

1. 任务“刚提交就挂”
2. `phase-entity-init-only` 在 split-partial 任务上持续复现
3. 低 coverage W1b 样本仍有机会把半成品 handler 直接送进 review

这说明前一轮修复虽然切掉了 reviewer timeout / GPT keyless fallback 等问题，但还没有把“重提”和“split-partial phase gate”这两条根因链完全收口。

## 直接根因

### 1. rerun 不是 fresh retry

`engine/stage-rerun.cjs` 旧行为只做了：

- checkpoint trim
- task status → `pending`
- project status → `submitted`

但没有清：

- `fail_count`
- `infra_retry_count`
- `code_retry_count`
- `metadata_json.outerFpHistory`

因此 task 在新的失败上报里仍会沿用旧 outer fingerprint 历史，`lib/task-queue.cjs` 会直接判成 `Outer-retry fingerprint FATAL`。

线上样本：

- `proj_1776680853909_w7113b`
  - 重提前仍为 `codeRetryCount=41`
  - `metadata.outerFpHistory` 保留 10 条旧指纹
  - 状态消息直接是 `repeated 7x across outer retries`

### 2. phase gate deterministic repair 只覆盖单文件

旧 `repairPhaseGateRuntimeMoves()` 的隐含假设：

- `CheckEventRules()`
- `Phase_<id>_Init()`
- `Phase_<id>_OnTap()`
- `Phase_<id>_OnAutoPlayArrive()`

都在同一个文件里。

但 W1b / split-partial 真正的文件布局是：

- 主文件 `GameFlowManagerMain.cs`
  - `CheckEventRules()`
  - `Update()`
  - `EnterPhase(..., "phaseId", ...)`
- `GameFlowManagerMain.Flow.cs`
  - `Phase_<id>_Init()`
  - `Phase_<id>_OnTap()`
  - `Phase_<id>_OnAutoPlayArrive()`

所以旧 repair 在 split-partial 产物上：

- 能看到 gate
- 看不到 init body
- 也补不到真实 handler

结果就是 `phase-entity-init-only` 在 review 中反复命中。

### 3. 低 coverage W1b 可以跳过 custom logic

旧 `codegen-schema` 路径里，只有 `schema.customLogic.length > 0` 才会调 custom logic runner。

当 schema 没列出 custom logic 时，哪怕模板覆盖率很低、phase handler 仍是空壳，也会直接：

- `No custom logic — skipping text runner entirely`

这会把半成品 split-partial handler 直接送进 `review`。

## 改动

### A. rerun 冷启动化

文件：

- `engine/stage-rerun.cjs`
- `test/stage-rerun.test.cjs`

改动：

- 抽出 `buildTaskReset()` / `prepareProjectForRerun()`
- 重提时统一清：
  - retry counters
  - `retry_after`
  - `outerFpHistory`
- project JSON 清 `lastFailure`
- 导出 helper，便于测试与后续脚本复用

### B. split-partial phase gate repair

文件：

- `engine/stages/review.cjs`
- `engine/stages/method-check.cjs`
- `test/method-check-phase-gate.test.cjs`
- `test/review-deterministic-repair.test.cjs`

新增：

- `repairPhaseGateRuntimeMovesAcrossPartials(mainCode, extraFiles)`

流程：

1. 从主文件 `CheckEventRules()` 中识别 `EnterPhase(..., "phaseId", ...)`
2. 收集当前 phase gate 使用的 `_snap_XPos`
3. 在 extraFiles 中查找：
   - `Phase_<id>_Init()`
   - `Phase_<id>_OnTap()`
   - `Phase_<id>_OnAutoPlayArrive()`
4. 如果 X 只在 init 里有位移：
   - 把最小 move 语句补进主文件 `Update()` 的 phase branch
   - 把同样的 move 补进 `Flow.cs` 的 tap / autoplay handler

这条修复同时接到：

- `review.repairKnownStructuralDamage()`
- `method-check.applyPhaseGatePreRepair()`

这样 phase gate 结构问题不会继续只在 review 才暴露。

### C. codegen / skeleton / reviewer 同链路收口

文件：

- `adapters/skeleton-generator.cjs`
- `engine/stages/codegen-schema.cjs`
- `engine/static-check.cjs`
- `worker/codex-reviewer.js`
- `worker/fix-recipes.json`
- 相关 tests

核心点：

- skeleton gate entity 只保留模板会真实移动的实体
- custom logic 改成 workspace-write 真文件编辑，再回读
- custom logic 结束后立即跑 contract scrub
- reviewer 改读 `-o` 输出文件，timeout 提到 4 分钟

## 线上验证

受控重提：

- task: `proj_1776680853909_w7113b`
- 时间：`2026-04-23 00:29`（北京时间）
- 入口：`node engine/stage-rerun.cjs --project proj_1776680853909_w7113b --from codegen`

验证结果：

- task row：
  - `status=pending -> processing`
  - `failCount=0`
  - `infraRetryCount=0`
  - `codeRetryCount=0`
  - `metadata.outerFpHistory` 已移除
- project JSON：
  - `status=processing`
  - `lastFailure=null`
- 新 pipeline：
  - 正常重新进入 `clone -> spec-extract -> spec-validate -> complexity-gate -> codegen`
  - `coverage=0.40`
  - `Custom logic detected (4 items), invoking Codex text runner...`

结论：

- rerun 已经从“假重提”变成真正 fresh retry
- W1b 低 coverage 样本不再静默绕过 custom logic

## 测试

通过：

- `node test/stage-rerun.test.cjs`
- `node test/method-check-phase-gate.test.cjs`
- `node test/review-deterministic-repair.test.cjs`
- `node test/method-check-auto-repair.test.cjs`
- `npm test`

说明：

- `test/phase-gate-entities.test.cjs` 仍是 describe/expect 风格，不是当前 `npm test` runner 的直接入口；本次未把它纳入 standalone 验证命令。

## 值班口径同步

已同步到当前本机 `blueprint-monitor` skill：

- 重提后先检查 counters / `outerFpHistory` / `lastFailure`
- split-partial phase gate 要同时看主文件 `EnterPhase(...)` 和 `GameFlowManagerMain.Flow.cs`
- “刚提交就挂”优先怀疑旧 outer fingerprint 继承，不要先怀疑 submit API
