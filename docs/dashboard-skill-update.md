# Dashboard / Blueprint SKILL 同步清单（归档系统 2026-04-19）

## 2026-04-22 增量同步：Codex reviewer / night-monitor / 在线任务收口

### 背景

2026-04-21 到 2026-04-22 的线上收口不再只是"归档可见性"问题，而是把 worker 主链切到更 deterministic 的 review/fix-loop：新增 Codex coder/reviewer 路径、night-monitor 自动重提闭环、以及围绕 `phase-entity-unbound` / `phase-entity-init-only` / `update-new-vector-in-hot-path` 的规则与预修复。

本节记录需要同步回 skill 副本的操作知识，避免 skill 还停留在旧的"GPT reviewer + 手工盯日志"认知。

### 需要同步到 `blueprint/references/build-pipeline.md`

新增一节："review deterministic pre-repair + online recovery"

```markdown
## Review deterministic pre-repair + online recovery

`engine/stages/review.cjs` 在进入 reviewer 前先做 deterministic pre-repair，当前至少包含：

- `repairUpdateGameStateBridge`：修复 UpdateGameState JSON bridge 结构损坏
- `stripEarlyShowCTA` / `normalizeFinishGameTerminalFlow`：统一终局流为 `GameEnded(); ShowCTA();`
- `rewriteHotPathVectorAllocations`：把 hot path 中的 `new Vector3(...)` 改写为 struct-copy 形式
- `repairPhaseGateRuntimeMoves`：当 gate 实体只在 `Phase_<id>_Init()` 里移动、而 `OnTap/OnAutoPlayArrive` 缺 runtime move 时，自动补最小 position change

### 高频 blocker（2026-04-22）

- `phase-entity-unbound`
- `phase-entity-init-only`
- `update-new-vector-in-hot-path`

处理优先级：
1. 先看 static-check top blocking rules
2. 再看 deterministic pre-repair 是否已命中
3. 最后才交给 reviewer / incremental fix

### 在线恢复

`engine/night-monitor.cjs` 负责 failed/stuck 项目的自动重提：
- 记录 fingerprint / sameFingerprintCount / sameStatusCount
- 在 repo HEAD 变化或冷却期满足时调用 `/api/projects/:id/submit`
- 事故快照写入 `server-data/night-monitor/`

night-monitor 只负责"重提和归档"，不会自己修复代码根因；真正的 deterministic 修复仍在 review/codegen/static-check 链。
```

### 需要同步到 `dashboard/references/architecture.md`

新增"Night Monitor / Recovery" 章节

```markdown
## Night Monitor / Recovery（2026-04-22）

Dashboard / ops 视角需要理解两类自动恢复：

- `watchdog/run`：常规观测与治理流程
- `engine/night-monitor.cjs`：failed/stuck project 自动重提

### 关键文件

- `server-data/night-monitor-state.json`：持久状态
- `server-data/night-monitor/summary.json`：最近一轮汇总
- `server-data/night-monitor/incidents/*.stuck.json`：卡死事故快照

### 判断口径

- 如果任务仍反复卡在相同 fingerprint，但 repo HEAD 已变化，优先看该修复是否已经热生效到 worker / review / night-monitor
- 如果 top blocking rules 长时间被 `phase-entity-init-only` / `phase-entity-unbound` 占据，说明问题仍停留在生成/预修复层，不是 dashboard 展示问题
```

### 需要同步到 skill 的 rules / references

- 新 reviewer 主链默认是 Codex reviewer + deterministic pre-repair，不要再假设只有 GPT reviewer。
- 处理线上失败任务时，优先读 recovery packet 和最近 session 尾部片段，不要整份 session jsonl 全量灌上下文。
- 盯任务时先核对三类 blocker：`phase-entity-unbound` / `phase-entity-init-only` / `update-new-vector-in-hot-path`。
- 如果旧修复已经落地到 repo，必须再验证它是否真的进入当前 `worker / night-monitor / review` 流程，而不是只存在于源码里。

### 建议同步到 env / operator notes

```json
{
  "USE_CODEX_REVIEW": "true"
}
```

并补充备注：

- `RECODE_BUFFER_MS` 目前由运行时硬编码为 12 分钟，旧 `.env` 里的同名变量会被忽略，应从 skill 操作说明里标记为"历史兼容项，不再依赖"
- 扩 worker 并发时，要同步确认 pm2 里 `linux-worker-4/5/6` 等实例确实已启动并开始领任务
```

## 背景

当前生效的 skill 安装/迁移副本位于 `/root/.codex-blueprint/skills/` 与 `~/.codex/memories/skills/`。本文档记录的是一次需要回写到 skill 副本的归档系统同步项；如果环境仍存在旧 harness 保护目录，也只应视为历史兼容路径。2026-04-19 落地的任务级归档闭环引入了新 API、新文件布局、新环境变量，需要在下次同步 skill 副本时更新到 references/ 和 env.json。

## 需要同步到 `blueprint/references/build-pipeline.md`

### 新增一节："任务级归档（observability archives）"

```markdown
## 任务级归档

`engine/archive-writer.cjs` 统一所有 per-task 观测性写入，10MB 轮转 + 失败兜底 alerts.json。

### 归档布局

| 文件 | 写入方 | 内容 |
| - | - | - |
| `server-data/task-logs/<taskId>/pipeline.jsonl`     | pipeline.cjs    | stage log/skip/pipeline-end 时间线 |
| `server-data/task-logs/<taskId>/silent-pass.jsonl`  | cua-verify.cjs  | hard-block + soft-warn 快照 |
| `server-data/task-logs/<taskId>/model-fatal.jsonl`  | pipeline.cjs    | MODEL_FATAL raw body head 4KB + hash |
| `server-data/task-logs/auto-fix/<recipe>-<hash>.json` | auto-fix.cjs    | 每次 sub-agent 尝试（prompt / diff / verify） |
| `server-data/task-logs/auto-fix/_index.jsonl`       | auto-fix.cjs    | 全局尝试索引 |
| `server-data/model-fatal-index.jsonl`               | pipeline.cjs    | 跨 task MODEL_FATAL 索引 |

### Feature flag

`BLUEPRINT_ARCHIVE_LEVEL` 环境变量：
- `full`（默认）— 全部写入
- `critical` — 只写 silent-pass + MODEL_FATAL（P0）
- `off` — 紧急关闭所有写入

### GC

`scripts/archive-gc.cjs` 默认 30 天 TTL，dry-run 模式安全。建议挂 cron：

    0 4 * * * node /opt/blueprint-editor/scripts/archive-gc.cjs --purge

### 交叉引用

→ dashboard/references/architecture.md 查看 dashboard tab + API
```

## 需要同步到 `dashboard/references/architecture.md`

### 新增"任务归档" tab 章节

```markdown
## 任务归档 Tab（2026-04-19）

位于 dashboard.html 的第 8 个 tab（data-panel="archive"）。

### API 端点

| 路由 | 返回 |
| - | - |
| `GET /api/dashboard/task-log/:taskId?limit=500` | `{ taskId, pipeline[], silentPass[], modelFatal[], autoFix[] }` |
| `GET /api/dashboard/auto-fix-archive?limit=30` | `{ attempts[] }` — 全局索引 |
| `GET /api/dashboard/auto-fix-archive?recipeId=&hash=` | 单次 attempt JSON（含 unified diff） |
| `GET /api/dashboard/model-fatal-index?limit=100` | `{ entries[] }` — 全局 MODEL_FATAL 索引 |

### UI 元素

- taskId 输入框 + 查询按钮 → 在一个视图里看 4 类归档
- Pipeline 事件流（最近 50 条，时间倒序，颜色按 event 类型）
- Silent-pass 快照（红底，显示 verdict/round/signals/actions/phaseOrder）
- MODEL_FATAL 详情（红底，显示 endpoint/model/http status + raw body head）
- 相关 auto-fix 尝试表（按 fingerprint 关联），"查看"按钮弹 modal 显示 sub-agent prompt head + 按文件的 diff

### 交叉引用

→ blueprint/references/build-pipeline.md "任务级归档" 章节
```

## 需要同步到 `env.json`

两个 SKILL 的 env.json 里添加：

```json
{
  "BLUEPRINT_ARCHIVE_LEVEL": "full"
}
```

（可选说明字段建议：`"// BLUEPRINT_ARCHIVE_LEVEL": "full | critical | off — 归档粒度"`）

## 交叉检查清单

按 `feedback_skill_sync_rule.md` 规则，下列改动需要两个 SKILL 同时更新：

- [x] `engine/metrics.cjs` 新增 `collapseRepeatedClauses` + `silent-pass-block` / `MODEL_FATAL:` 正则
- [x] `engine/archive-writer.cjs` 新模块
- [x] `engine/pipeline.cjs` / `engine/auto-fix.cjs` / `engine/stages/cua-verify.cjs` / `engine/stages/spec-validate.cjs` 接入
- [x] `api/dashboard.cjs` + `api/router.cjs` 3 个新 route
- [x] `dashboard.html` 新 tab + 查询 UI
- [x] `scripts/archive-gc.cjs` 运维脚本
- [ ] **SKILL references 同步** — 本文档（由人工在 dontAsk 解除时应用）
- [ ] **SKILL env.json 同步** — 同上
