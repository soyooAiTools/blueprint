# 2026-04-26 Blueprint 三任务恢复收口

## 背景

本轮继续处理远端 compact 断流前的 Blueprint 线上恢复任务，目标是让三个卡在流水线中的项目完成构建、runtime-contract、公开预览验证，并把重复失败前移为 deterministic repair。

任务：

- `proj_1777127892659_m0txpu`：太空卖氧气
- `proj_1777127909317_ksgqw6`：子弹模具
- `proj_1777127928281_k4462r`：卖水

## 根因

1. `AddResource(id, -n)` 旧生成路径只记录 `resource_incremented`，没有记录 `resource_decremented`，导致 runtime-contract 缺 `unlockNewRoom:resource_decremented` 这类 phase-scoped signal。
2. skeleton 在已有 `Enemy` 逻辑实体时仍生成 legacy `SpawnEnemy(int count)` alias，和真实 `SpawnEnemy` helper 形成 CS0111 重复方法。
3. `method-too-long` 把长机器契约注释和空行一起计入方法长度，导致 `phaseEvidenceSchema` 等注释把生成状态导出方法顶成 blocking。
4. review repair 对 split partial 不够全：assembly runner 定义在 partial，`Update()` 在主文件，旧修复只看单文件。
5. `cua_passed` 被 task queue 视作未分配终态，后续 upload 阶段上报 `done` 时被 `api/worker.cjs` 的 stale-report guard 丢弃，导致 pipeline 已成功但 DB 仍显示 `cua_passed`。
6. `preview_ready`、cancel/ownership、watchdog stale recovery 等状态之间缺少更细的单向守卫，可能把已经进入验证/上传的任务错误回退。

## 修复

- `adapters/skeleton-generator.cjs`
  - `AddResource` 记录负向资源变化 evidence。
  - 避免泛化敌人 alias 生成重复 `SpawnEnemy`。
- `engine/stages/compile.cjs`
  - compile pre-build repair 自动补旧 checkpoint 里的 `NegativeResourceEvidence`。
  - 清理同文件重复方法，覆盖 `SpawnEnemy` 等历史兼容形态。
- `engine/static-check.cjs`
  - 增加/修正重复方法和 method length 检查。
  - method length 按剥离注释后的有效逻辑行统计，并豁免生成状态导出器。
- `engine/stages/review.cjs`
  - deterministic pre-repair 覆盖成员注释、跨 partial assembly runner 注入、post-tap reset-only 清理、switch/case 注释补齐。
- `api/worker.cjs`
  - 放行同一 pipeline 的 `cua_passed -> done`，确保 upload 写回 `previewUrl` 和最终状态。
- `lib/task-queue.cjs`、`worker/linux-worker-client.js`、`api/dashboard.cjs`、`lib/watchdog.cjs`
  - 收紧 preview/cancel/ownership/stale 状态口径，避免旧 worker 或 watchdog 复活错误状态。

## 验证

线上结果：

- `proj_1777127892659_m0txpu`：`done`，公开预览 `https://playcools.top/webgl/proj_1777127892659_m0txpu/index.html`
- `proj_1777127909317_ksgqw6`：`done`，公开预览 `https://playcools.top/webgl/proj_1777127909317_ksgqw6/index.html`
- `proj_1777127928281_k4462r`：`done`，公开预览 `https://playcools.top/webgl/proj_1777127928281_k4462r/index.html`

关键日志：

- `太空卖氧气`：runtime-contract / post-fix CUA observe `11/11` phases、`102/102` signals，upload public preview `completed=3/3`。
- `子弹模具`：runtime-contract `11/11` phases、`132/132` signals，upload public preview `completed=3/3`。
- `卖水`：compile 命中 `GameFlowManagerMain.Resource.cs:NegativeResourceEvidence x1`；runtime-contract `11/11` phases、`102/102` signals；upload public preview `initialAstronautDemandGuide -> produceBottledWater completed=3/3 visualDiff=0.361`。

本地回归：

- `npm test`
- `node test/review-deterministic-repair.test.cjs`
- `node test/method-check-contract.test.cjs`
- `node test/skeleton-flow-fallback.test.cjs`
- `node test/static-check-duplicate-method.test.cjs`
- `node test/static-check-method-length.test.cjs`
- `node test/task-queue-preview-lifecycle.test.cjs`
- `node test/worker-status-guards.test.cjs`
- `node test/compile-deterministic-repair.test.cjs`
- `git diff --check`

## 部署

- 主仓库提交：`a9bff2c Stabilize Blueprint task recovery pipeline`
- 已推送：`origin/main`
- PM2 状态检查：`blueprint-editor`、`linux-worker-1..6`、`blueprint-monitor-loop`、`luna-build-api` 均在线。
- `server-data/**` 运行态文件未纳入提交。

## 后续注意

- `worker/code-reviewer.js` 的默认模型改动被 git hook 拦截，需要赵赫确认后才能单独提交；本次未绕过 hook。
- 若再次看到 pipeline `success=true` 但任务停在 `cua_passed`，优先检查 `cua_passed -> done` 是否被 stale-report guard 丢弃。
- runtime signal 缺 `resource_decremented` 时，优先检查 `AddResource(id, -n)` 和 compile deterministic repair，而不是直接让 CUA/vfix 猜。
