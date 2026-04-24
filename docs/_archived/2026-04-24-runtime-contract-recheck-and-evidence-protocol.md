# 2026-04-24 Runtime Contract Recheck And Evidence Protocol

## 背景

`cua-verify` 的重 fix-loop 在部分任务上会反复命中同类 `CODE` 指纹，但每轮修复后的最新产物没有先回到结构化验证层重新判断，导致：

- `runtime-contract` 只在进入 `cua-verify` 前跑一次，后续证据过期
- 模糊 signal 继续依赖截图前后差分，容易错过瞬时事件
- 重 CUA 被迫承担本该由结构化状态承担的验证责任

## 本次系统改造

### 1. post-fix runtime-contract recheck

在 `engine/stages/cua-verify.cjs` 中，每次 AI 修复代码并 rebuild 成功后，立即重新执行 `runtime-contract`。

新行为：

- 如果 post-fix `runtime-contract` 已通过，直接短路为通过
- `cua-verify` 标记 `skippedByRuntimeContract=true`
- 不再继续消耗剩余重 CUA rounds

关键日志：

- `Post-fix runtime contract passed — skipping remaining heavy CUA rounds`
- `Post-fix runtime contract still needs escalation: ...`

### 2. 通用显式证据协议

在 `/root/cua-agent/playable_agent/signal_assertions.py` 增加显式证据读取，优先支持：

```json
{
  "phaseEvidence": {
    "upgradeOurBase": {
      "resource_decremented": 1,
      "upgrade_level_changed": { "before": 1, "after": 2 }
    }
  }
}
```

以及扁平键：

```json
{
  "variables": {
    "evidence.dispatchAstronautAttack.distance_to_target_below_threshold.distance": 1.2
  }
}
```

当前已接入显式证据的 signal：

- `player_position_changed`
- `distance_to_target_below_threshold`
- `resource_incremented`
- `resource_decremented`
- `entity_state_changed`
- `upgrade_level_changed`
- `target_hp_decreased_or_target_dead`
- `target_removed_or_hidden`
- `source_hidden_or_moved`
- `camera_orientation_changed`
- `camera_zoom_changed`

### 3. 生成与修复 prompt 对齐

`worker/worker-coder.js` 与 `worker/luna-codex-code.md` 已要求生成代码在这些高歧义 signal 上输出 phase-scope evidence，而不是只依赖自然截图差分。

## 验证

本地已通过：

- `node -c engine/stages/runtime-contract.cjs`
- `node -c engine/stages/cua-verify.cjs`
- `node -c engine/stages/review.cjs`
- `python3 -m unittest /root/cua-agent/tests/test_signal_assertions.py`

线上验证时，任务 `proj_1776912973985_5o2lyu` 的流水线日志已经出现 post-fix recheck 分支，说明新链路已生效。

## 部署口径

当前 `blueprint-editor` 与 `linux-worker-1..6` 都是 PM2 常驻进程。

推荐命令：

```bash
pm2 restart blueprint-editor linux-worker-1 linux-worker-2 linux-worker-3 linux-worker-4 linux-worker-5 linux-worker-6
```

注意：

- 不要用 `pm2 reload blueprint-editor`
- `reload blueprint-editor` 过去触发过级联下线，见 `docs/INCIDENTS.md`
- 若已有在飞任务，重启后应从 `runtime-contract` 或 `cua-verify` 做受控 rerun，确保任务吃到最新模块

## 监控口径

排查单任务时，优先看：

- `server-data/task-logs/<taskId>/pipeline.jsonl`
- `server-data/projects/<taskId>.json`

重点搜索：

- `runtime-contract`
- `Post-fix runtime contract passed`
- `Post-fix runtime contract still needs escalation`
- `phaseEvidence`
- `visual-smoke-failed`

如果 signal 缺失但玩法看起来已经发生，优先检查项目导出的 `phaseEvidence` 或 `variables["evidence.<phase>.<signal>..."]`，不要直接把问题归因到 VLM。
