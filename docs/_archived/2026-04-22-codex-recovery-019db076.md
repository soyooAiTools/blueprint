# 2026-04-22 Codex Recovery 归档索引（session `019db076`）

## 来源

- recovery packet: `/root/codex-recovery-019db076.md`
- raw session: `/root/.codex/sessions/2026/04/21/rollout-2026-04-21T22-34-30-019db076-d17c-7ca2-8973-b99d009cef39.jsonl`

## 使用约束

- 以 recovery packet 为主。
- 如需回看 raw session，只看最近相关片段，不要把整份 19MB jsonl 全量灌入上下文。

## 本次收口前确认的真实状态

- repo 当前树与 recovery packet 基本一致：`FinishGame/ShowCTA`、phaseId 口径、`Camera.main // ok` 相关修复仍在。
- 当前最值得优先处理的 blocker 仍是：
  - `phase-entity-unbound`
  - `phase-entity-init-only`
  - `update-new-vector-in-hot-path`
- 其中 `phase-entity-init-only` 在新 worker 产物里仍真实出现，不是误杀：phase gate 拍完快照后，实体只在 `Phase_<id>_Init()` 中移动，`OnTap/OnAutoPlayArrive` 没有 runtime move，导致 gate 不会翻转。

## 本次追加落地

- `engine/stages/review.cjs`
  - 扩展 hot-path `new Vector3(...)` 预修复，覆盖 `target = anchor.position + new Vector3(...)`
  - 新增 `repairPhaseGateRuntimeMoves()`：当 gate 实体只在 init 中出现、handler 缺 runtime move 时，自动把最小 move 补进 `OnTap` / `OnAutoPlayArrive`
- PM2 已热重启：
  - `blueprint-editor`
  - `linux-worker-1..6`
  - `blueprint-night-monitor`

## 后续建议

1. 继续盯在线 review 日志，确认这两类 blocker 是否从 top blocking rules 中下降。
2. 若 `phase-entity-unbound` 仍高频，下一刀应前移到 skeleton/template，而不是继续只靠 review 兜底。
3. `template-engine` 的 `TODO_PHASE_n_INIT` marker warning 仍值得单独治理，它会继续拖低 fix-loop 成功率。
