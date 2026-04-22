# 2026-04-22 Blueprint System Hardening + Skill Sync

## 背景

2026-04-22 的收口工作从“盯任务”转成“改系统”。

这轮变更的目标有 4 个：

1. 把高频 compile / phase gate 问题前移到 `method-check` 和 deterministic repair。
2. 把 codegen / custom logic / review 主链切到更适合代码审查与修复的 Codex 路径。
3. 保留监控，但把自动动作收敛到“哨兵 + 轻处置”，避免在线改核心代码。
4. 把本轮分析、监控、skill 安装状态写成可追溯记录，避免下一轮重复排查。

## 本轮系统改造

### 1. review / method-check 前移

核心文件：

- `engine/stages/review.cjs`
- `engine/stages/method-check.cjs`

新增或扩大的能力：

- `repairPhaseGateRuntimeMoves`
- `stripInteractionFlagShortcutsFromPhaseGates`
- `rewriteHotPathVectorAllocations`
- `method-check` contract check
- `method-check` phase-gate pre-repair

当前前移拦截的主规则：

- `phase-entity-init-only`
- `phase-entity-unbound`
- `phase-gate-shortcircuits-with-interaction-flags`
- `duplicate-state-fields`
- `forbidden-generic-api`
- `player-alias-drift`
- `invalid-pool-literals`

### 2. codegen / custom logic / fix 主链改为 Codex

核心文件：

- `engine/stages/codegen-schema.cjs`
- `worker/codex-code-coder.js`
- `worker/code-reviewer.js`

主调整：

- `custom logic fill` 默认走 `codex exec + gpt-5.4`
- code generation / incremental fix 默认走 Codex backend
- review 主链保持 Codex reviewer

### 3. skeleton / template 收口

核心文件：

- `adapters/skeleton-generator.cjs`
- `adapters/codegen-template-engine.cjs`
- `adapters/templates/trigger-codegen.cjs`
- `adapters/templates/interactions/deliver-sell.cjs`
- `adapters/templates/interactions/cost-gated-click.cjs`

主调整：

- 不再默认把 `OnTap` 生成为“点一下就 phase 完成”
- 删除统一注入的 phase interaction flag shortcut
- 把热路径里的 `new Vector3(...)` 位移改成 struct-copy 模式
- 收紧 phase gate / interaction handler 的默认生成口径

### 4. 运行态恢复与监控

核心文件：

- `lib/task-queue.cjs`
- `api/worker.cjs`
- `server-data/night-monitor/*`
- `server-data/skill-monitor/*`

主调整：

- stale task reclaim 修复
- cancel 时清理 assignment / retry 状态
- worker `updatedAt` 刷新修复
- 监控默认只做：
  - failed resubmit
  - low-risk auto-fix
  - medium/high-risk alert only

## 线上样本结论

本轮 5 个失败任务的深挖结论见：

- `server-data/analysis/2026-04-22-blueprint-root-cause-report.md`

最新判断：

- `method-check` 前移是有效的，任务已不再主要死在 review
- 但 `forbidden-generic-api` 当前范围过宽，会把共享 `GFM_*.cs` 一起算入任务责任
- `player-alias-drift` 在部分任务上是真问题，不能直接关闭，只能收窄检测口径

## Skill 同步

本轮新增了本地 `deep-research` skill 安装记录。

当前安装路径：

- `~/.codex/skills/deep-research/`

内容来源：

- `dashhuang/deep-research-skill`

本仓库只记录：

- skill 已安装
- 可用于后续深度调研类任务
- 当前会话是否真正加载，仍取决于 Codex 重启 / 新会话初始化

## 测试与验证

本轮新增测试：

- `test/method-check-auto-repair.test.cjs`
- `test/method-check-contract.test.cjs`
- `test/method-check-phase-gate.test.cjs`
- `test/review-deterministic-repair.test.cjs`
- `test/skeleton-template-regression.test.cjs`

至少完成过：

- 相关 `node -c` 语法校验
- method-check / review / template 回归测试
- pm2 热重启后 worker 与 editor 恢复

## 提交说明

本归档文件对应的提交应覆盖：

- 系统级前置修复
- codegen / review 路径切换
- 监控策略收敛
- 记录、分析、归档文件补齐
