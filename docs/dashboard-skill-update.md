# Dashboard / Blueprint SKILL 同步清单（归档系统 2026-04-19）

## 背景

`~/.claude/skills/blueprint/` 和 `~/.claude/skills/dashboard/` 是 harness 保护目录，dontAsk 模式下 Write/Edit 被拒。2026-04-19 落地的任务级归档闭环引入了新 API、新文件布局、新环境变量，需要在下次解除保护时同步到两个 SKILL 的 references/ 和 env.json。

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
