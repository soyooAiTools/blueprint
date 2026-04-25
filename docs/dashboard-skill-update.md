# Dashboard / Blueprint SKILL 同步清单（归档系统 2026-04-19）

## 2026-04-25 增量同步：公开预览默认入口验证

### 需要同步到 Blueprint / dashboard / operator skill

- CUA 通过不再等价于公开裸预览可用；必须区分：
  - CUA observe 路径：`iframe.html?autoplay=1` + observer-ready + PlayableAgent
  - 审核/用户路径：公开 HTTPS `index.html`
- `runtime-contract` 需要先跑 default preview probe，不能只用 PlayableAgent PASS 跳过后续门禁。
- `upload` 阶段必须验证真实公开 URL：
  - 先等待 `window.app` 或 `window.__gameState` / `window.__getGameState()` 初始化
  - 再开始推进 deadline
  - 要求前 3 个 spec phase 或 terminal state
  - 同时检查 screenshot pixel diff，避免状态推进但画面/镜头停在第一 SHOT
- 如果 upload 报 `Public preview did not progress` / `public-preview-*`，worker checkpoint 必须从 `compile` 起失效，不能复用旧 HTML。
- 公开 fallback 派发 `luna:start` 前必须等 `window.startGame` 已经解析完成；大型 inline HTML 可能超过 3s 才到达 startup script。
- `done` / `cua_passed` 在服务端会映射到 `reviewing`，这是进入人工审核的正常状态，不应误判为 pipeline 未完成。

### 需要同步到 incident / archive

- 事故记录：`docs/INCIDENTS.md`
- 完整归档：`docs/_archived/2026-04-25-public-preview-cua-gap.md`

### 需要同步到 operator command notes

公开预览手工复测优先使用 upload stage 导出的探针，而不是只看 CUA：

```bash
node - <<'NODE'
const upload = require('./engine/stages/upload.cjs');
const fs = require('fs');
const taskId = 'proj_1776912973985_5o2lyu';
const specs = JSON.parse(fs.readFileSync('server-data/webgl/' + taskId + '/specs.json', 'utf8'));
const ctx = { taskId, blueprint: { specs }, addLog(stage, msg) { console.log('[' + stage + '] ' + msg); } };
upload._verifyPublicPreviewProgress(ctx, 'https://playcools.top/webgl/' + taskId + '/index.html')
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(err => { console.error(err.stack || err); process.exit(1); });
NODE
```

## 2026-04-22 增量同步：Codex reviewer / 在线任务收口

### 背景

2026-04-21 到 2026-04-22 的线上收口不再只是"归档可见性"问题，而是把 worker 主链切到更 deterministic 的 review/fix-loop：新增 Codex coder/reviewer 路径，以及围绕 `phase-entity-unbound` / `phase-entity-init-only` / `update-new-vector-in-hot-path` 的规则与预修复。

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

`night-monitor` 已在 2026-04-23 移除，原因是自动恢复职责与 skill / ops 层重叠、设计边界不清。

当前口径：

- 不再有 failed/stuck project 的独立自动重提 daemon
- `POST /api/projects/:id/feedback` 只记录反馈并把项目置为 `feedback`，不会自动重提
- 恢复信息优先通过 `watchdog/run`、dashboard 信号和 task log 判断
- 真正的 deterministic 修复仍在 review/codegen/static-check 链
```

### 需要同步到 `dashboard/references/architecture.md`

新增"Recovery / Watchdog" 章节

```markdown
## Recovery / Watchdog（2026-04-22, updated 2026-04-23）

Dashboard / ops 视角当前主要理解：

- `watchdog/run`：常规观测与治理流程

### 关键文件

- `server-data/task-logs/<taskId>/pipeline.jsonl`：任务尾部与失败点
- `server-data/skill-monitor/*`：skill 侧巡检与 auto-fix 动作
- `server-data/regressions.json`：回归聚合信号

### 判断口径

- 如果任务仍反复卡在相同 fingerprint，但 repo HEAD 已变化，优先看该修复是否已经热生效到 worker / review / watchdog
- 如果 top blocking rules 长时间被 `phase-entity-init-only` / `phase-entity-unbound` 占据，说明问题仍停留在生成/预修复层，不是 dashboard 展示问题
```

### 需要同步到 skill 的 rules / references

- 新 reviewer 主链默认是 Codex reviewer + deterministic pre-repair，不要再假设只有 GPT reviewer。
- 处理线上失败任务时，优先读 recovery packet 和最近 session 尾部片段，不要整份 session jsonl 全量灌上下文。
- 盯任务时先核对三类 blocker：`phase-entity-unbound` / `phase-entity-init-only` / `update-new-vector-in-hot-path`。
- 如果旧修复已经落地到 repo，必须再验证它是否真的进入当前 `worker / watchdog / review` 流程，而不是只存在于源码里。

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

## 2026-04-22 增量同步：system hardening + deep-research skill

### 需要同步到 blueprint / operator skill 的认知

- `method-check` 不再只是查缺方法，已经前移承担 contract check + phase-gate pre-repair。
- 当前高频 contract 规则包括：
  - `duplicate-state-fields`
  - `forbidden-generic-api`
  - `player-alias-drift`
  - `invalid-pool-literals`
- 调研线上失败时，不能只看最终 `method-check` 指纹；要区分：
  - 真实任务代码问题
  - 共享 `GFM_*.cs` 带来的 contract 噪音

### deep-research skill 状态

2026-04-22 已安装到：

```text
~/.codex/skills/deep-research/
```

来源：

```text
dashhuang/deep-research-skill
```

注意：

- skill 文件安装完成，不代表当前会话已经自动加载
- 只有在 Codex 重启或新会话初始化后，它才会出现在 `Available skills`

### 归档入口

本轮完整归档见：

- `docs/_archived/2026-04-22-blueprint-system-hardening-and-skill-sync.md`
- `server-data/analysis/2026-04-22-blueprint-root-cause-report.md`

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
