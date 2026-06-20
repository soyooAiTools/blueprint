# Blueprint — AI Playable Ad Pipeline

自动化试玩广告生产流水线：从策划文案到可投放的单文件 HTML，全程 AI 驱动。

- **线上地址**: https://playcools.top/blueprint/
- **耗时**: 策划文案提交 → 可预览试玩广告 ≈ **3 分钟**

## 关联仓库（GitHub, private under soyooAiTools）

| 仓库 | 本机部署路径 | 角色 |
|------|------------|------|
| `soyooAiTools/blueprint`（本仓库） | `/opt/blueprint-editor/` | 主代码：engine / adapters / worker / api / dashboard |
| `soyooAiTools/blueprint-skill` | `~/.openclaw/workspace/skills/blueprint/` | Claude Code skill 说明书 + references。**改 stage/recipe/static-check 时同步更新此 SKILL.md** |
| `soyooAiTools/cua-agent` | `/root/cua-agent/` | CUA Python 验证器（observe_mode 6 层防御实现） |
| `soyooAiTools/luna-base-template` | `/opt/luna-base-template/` | Luna 7.1.0 工程模板的 git 镜像 |
| `soyooAiTools/luna-poc` | `/opt/luna-poc/` | 本机 build-api 编译服务（127.0.0.1:18860） |
| `soyooAiTools/blueprint-ops` | `/opt/blueprint-ops/` | 部署机本地资产：Luna docs / runtime patches / nginx / cc 切换脚本（symlink 回 /root /etc/nginx） |
| `soyooAiTools/openclaw-workspace` | `~/.openclaw/workspace/` | 30+ 协调 skill + memory + learnings（dashboard/feedbacksystem 等通过 sub-agent 调用） |

新机部署 7 个 repo 都要 clone；blueprint-skill 必须放在 `~/.openclaw/workspace/skills/blueprint/`，否则 Claude Code 不会加载。
blueprint-ops 的内容部署时需 symlink 回原位置（详见该 repo README 的"部署机原始位置"表）。

## 架构

```
策划文案 → 分镜解析 → 蓝图编辑 → AI 编码 → Luna 构建 → PlayableAgent验证 → 渠道 HTML
              (豆包)                (Claude)              (Qwen VLM)
                                    ↑                                      |
                                    └────────── 反馈迭代 ←── 审核预览 ←────┘
```

### Blueprint 2.0 Milestone（2026-06-12）

当前生产主链路以 SourceSceneIR / source HTML 为语义事实源，SourceIR adapter 负责向 Blueprint/GameSchema/WebGL/Unity 下传 phase、guideText、实体、资源和视觉 contract。流程图 tab 是稳定 authoring contract：Flow 必须先经过 preflight、resource snapshot、SourceSceneIR 转换和 SourceIR 验证，再进入 WebGL/Luna/Unity 交付。

2.0 交付规则：

- WebGL 产物必须保留 `__gameState`、可驱动 phase hook、runtime binding smoke 和 source guideText parity 证据。
- storyboard2html 生成的 HTML 与最终 WebGL 的一致性是系统终极红线，不能通过 WebGL 侧临时兜底、HTML 假状态或报告文字绕过；`source HTML -> SourceSceneIR/SourceIR -> playable-scene-ir -> WebGL` 必须保持 phase、guideText、targetSequence、entity/resource/gate 语义一致。
- 程序员 Unity 工程必须导出为 `Assets/Scripts/Core` / `Tool` / `Game` 三层；核心模块、工具层和本项目业务分离。
- 状态和步骤语义使用 enum，Player/NPC/Entity 走基类 + 可选组件组合，Audio 走集中式多音源管理。
- 程序员交付代码必须能给人类程序员接手：场景引用走 AIBridge/MCP + Inspector hydration，业务代码不靠 runtime `Find` / `AddComponent` / `new GameObject` 补场景；只保留真实调用链会用到的方法。
- 同一个玩法状态只能有一个 owner。简单 Player 只保留一个 `MoveSpeed`，Movement helper 不保存默认速度，Gold 从资源表派生，HUD 目标提示只由 HudController 写。
- 属性归属贴近能力组件：`MoveSpeed` 归 MovementComponent/移动能力，交互半径归 Trigger/Interaction，背包容量归 Inventory；Player/Manager 只做编排，不复制每个实体的调参字段。
- 生命周期入口必须唯一：`Init/Configure/Setup` 未被调用就删除；依赖 `Awake/Start` 时不保留并行 `Init`；固定 Player/HUD/Camera/关键实体引用缺失时只短路 `Debug.LogError`，不写 runtime 扫描、创建、修组件 fallback。
- Phase/流程节点是连续试玩流程和代码/数据组织入口，不是独立关卡；AIBridge 预水合后要删除 primitive builder、source spec helper 等临时脚本，或下沉为正式 Tool。
- `mBindings` 保留为 Inspector 数据入口，由 AIBridge/Editor 预填；程序员交付版不保留 `GameSceneCtrl` / `SceneObjectRegistry` 这类隐藏运行时对象表作为第二入口；`SCENE_BAKE_PLAN.json` / `SCENE_BAKE_REPORT.json` / `PROGRAMMER_TEMP_CODE_AUDIT.json` 证明场景、mesh、绑定和临时脚本清理已经在交付前完成。
- `programmer-delivery-maintainability-gate` strict 模式会阻断 runtime 查找/挂组件、`Vector3.Distance` 门槛、静态 `Init/Get/Return` 工作流、重复状态 owner、未调用方法和空壳实体类；`programmer-delivery-hardgate` 会把这些 summary 和 temporary-code audit 纳入交付阻断。
- schema prompt、V4/V5 prompt、Codex code runner 和 legacy worker prompt 都必须携带这套程序架构硬规则。

### Harness Engine Pipeline（8 阶段）

```
clone → spec-validate → codegen → review [gate] → compile [gate] → visual-check [gate] → cua-verify [gate] → upload [gate]
```

| 阶段 | 模块 | 说明 |
|------|------|------|
| clone | `engine/stages/clone.cjs` | 克隆 Luna 模板工程 |
| spec-validate | `engine/stages/spec-validate.cjs` | 蓝图 spec 校验（entity/trigger/verb/dead-end） |
| codegen | `engine/stages/codegen.cjs` | AI 编码（entity-resolver → mechanics-resolver → skeleton → Claude） |
| review | `engine/stages/review.cjs` | GPT-5.4/Codex 代码审核（3-Tier 规则，6 轮 fix-loop） |
| compile | `engine/stages/compile.cjs` | Bridge.NET 编译（5 轮 auto-fix） |
| visual-check | `engine/stages/visual-check.cjs` | Playwright 多帧截图 + Claude Sonnet VLM 分析（8 轮） |
| cua-verify | `engine/stages/cua-verify.cjs` | PlayableAgent 操控验证（20 轮，30min 上限） |
| upload | `engine/stages/upload.cjs` | 构建产物保存（版本管理 + gzip 压缩 + 7 天自动清理） |

### 质量门控

- **review**: lineCount >= 100, 30 条静态规则, spec 语义校验（phase/entity/trigger 一致性）, 高危 warning 阻断
- **compile**: 方法数 >= 3, 必需方法检查 (Start/Update/CheckEventRules), 25MB 上限
- **visual-check**: 多帧分析 (t=0/3/8s), 实体可见性, 画面变化检测
- **cua-verify**: Phase 覆盖率, 30min 总时间上限, 5 轮无进展提前退出

### Phase Evidence Runtime Contract（2026-05-21）

Blueprint 的 deterministic assembly 现在同时输出结构化 runtime snapshot：

- Canonical CUA probe contract: `contracts/cua-probe-contracts.v1.json`，覆盖 L1 registry 36/36 模块。
- Node 侧读取/评估：`engine/cua-probe-contracts.cjs`，同时支持 `phaseEvidence.<moduleId>` snapshot 与 legacy game-state path alias。
- C# 侧写入：`adapters/skeleton-generator.cjs` 提供 `RecordPhaseEvidenceObject/Field`，`adapters/assembly-emitter.cjs` 在模块真实执行路径记录 `_meta + before/after/triggered` 等字段。
- CUA report 侧由 `soyooAiTools/cua-agent` 的 `phase_evidence_reporter.py` 汇总 `phaseEvidenceSummary`，重点看 `triggeredPresentFullRate`、`triggeredAntiAutoplayHeldRate`、validation violations 和 non-passed triggered modules。

收口归档见 `docs/_archived/2026-05-21-phase-d-runtime-snapshot-closeout.md`。

### Engine 核心模块

| 模块 | 说明 |
|------|------|
| `engine/fix-loop.cjs` | 声明式 fix-loop 原语（maxRounds, onExhausted, beforeRound, attempt） |
| `engine/error-classifier.cjs` | INFRA(退避) / CODE(recode) / FATAL(终止) 三类错误分类 |
| `engine/recode.cjs` | 统一重编码（clone → seed → generate → findMainCs），支持 extraFiles |
| `engine/static-check.cjs` | 静态代码检查（30 条规则：禁用 API / Bridge.NET 限制 / LINQ / 无限循环 / pool 名拼写） |
| `engine/helpers.cjs` | 构建请求、issue 分类、结构化反馈构建 |
| `engine/spec-conformance.cjs` | Spec 语义校验（phase 完整性 / 交互处理器 / entity 引用 / trigger 条件） |
| `engine/metrics.cjs` | Pipeline 运行指标收集（JSONL），含失败归因/热点/趋势/诊断报告 |
| `engine/cua-probe-contracts.cjs` | CUA probe contract 加载、registry coverage、runtime snapshot coverage / attribution |
| `engine/module-gap-ledger.cjs` | assembly module 缺口归因 ledger，用于确定性覆盖率与缺口追踪 |
| `engine/lesson-extractor.cjs` | 失败自动规则沉淀（CODE/GATE 失败 → pending-rules.json，Jaccard 去重） |
| `engine/cleanup-old-builds.cjs` | WebGL 构建产物清理（默认 7 天，支持 --dry-run） |

### Codegen 前置处理链

1. `adapters/entity-resolver.cjs` — spec entity → `__Pool_` 对象预映射
2. `adapters/mechanics-resolver.cjs` — interaction verb → C# 代码提示（28 种 verb）
3. `adapters/skeleton-generator.cjs` — `buildRealCondition()` 生成真实 C# 条件

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + @xyflow/react 12 + Vite 7 |
| 后端 | Node.js (server.cjs, PM2) |
| AI 编码 | Claude Opus 4.6 |
| 代码审核 | GPT-5.4（3-Tier 规则分层检查） |
| 视觉预检 | Claude Sonnet 4.6（多帧 VLM 分析） |
| CUA 验证 | PlayableAgent — Qwen2.5-VL-72B (SiliconFlow) |
| 分镜解析 | 豆包 Seed 2.0 Pro |
| 构建 | Luna 7.1.0 + MSBuild + Bridge.NET (Linux ECS) |
| 转换 | convertToSingleHTML 内联打包（~7MB） |

> **注意**: 当前生产主链路以 SourceSceneIR / SourceIR 为事实源；V4 entity-driven 蓝图格式（`entities[]` + `phases[]` + `specs[]`）仅作为兼容和诊断入口保留。

## 目录结构

```
blueprint-editor/
├── server.cjs                      # HTTP 服务端（API + 静态文件，端口 3901）
├── ecosystem.config.cjs            # PM2 配置
├── package.json
│
├── engine/                         # Harness Engine（Pipeline 编排层）
│   ├── pipeline.cjs                # 8 阶段 pipeline 编排
│   ├── fix-loop.cjs                # 声明式 fix-loop 原语
│   ├── error-classifier.cjs        # 错误分类（INFRA/CODE/FATAL）
│   ├── recode.cjs                  # 统一重编码入口
│   ├── static-check.cjs            # 静态代码检查
│   ├── helpers.cjs                 # 工具函数
│   ├── spec-conformance.cjs        # Spec 语义校验
│   ├── metrics.cjs                 # Pipeline 指标收集 + 诊断报告（CLI: node engine/metrics.cjs）
│   ├── lesson-extractor.cjs        # 失败 → 规则自动沉淀
│   ├── cleanup-old-builds.cjs      # 构建清理脚本
│   └── stages/                     # Pipeline 各阶段实现
│       ├── clone.cjs
│       ├── spec-validate.cjs
│       ├── codegen.cjs
│       ├── review.cjs
│       ├── compile.cjs
│       ├── visual-check.cjs
│       ├── cua-verify.cjs
│       └── upload.cjs
│
├── adapters/                       # 数据适配层
│   ├── entity-resolver.cjs         # spec entity → pool 对象映射
│   ├── mechanics-resolver.cjs      # interaction verb → C# 代码提示
│   └── skeleton-generator.cjs      # Phase 骨架代码生成
│
├── lib/                            # 基础设施层
│   ├── lifecycle.cjs               # 进程生命周期管理
│   ├── port-guard.cjs              # 端口冲突检测
│   ├── watchdog.cjs                # 进程看门狗
│   └── model-provider.cjs          # LLM 提供者抽象
│
├── worker/                         # AI Worker 模块
│   ├── linux-bridge-build.js       # Bridge.NET 编译服务（端口 3080）
│   ├── linux-worker-client.js      # Linux Worker 主入口
│   ├── worker-coder.js             # AI 编码（Claude Opus 4.6）
│   ├── worker-playableagent.js     # PlayableAgent CUA 验证
│   ├── worker-cua-verify.js        # CUA 验证辅助
│   ├── code-reviewer.js            # GPT-5.4 代码审核（3-Tier 规则）
│   ├── codex-reviewer.js           # Codex 代码审核
│   ├── prompt-v4.js                # V4 prompt 模板
│   ├── prompt-v5-basetemplate.js   # V5 Base Template prompt
│   ├── luna-codex-code.md          # Codex code runner Luna 开发规范
│   └── behavior-templates.md       # 行为模板文档
│
├── screenshot-review/              # WebGL 白屏检测
│   ├── screenshot-review.cjs       # Playwright 截图 + 像素分析
│   └── screenshot-review-server.cjs
│
├── frontend/                       # React 前端
│   ├── src/
│   └── dist/                       # 构建产物
│
├── python/                         # Python 工具
│   ├── storyboard_parser.py        # 分镜解析
│   ├── blueprint_converter.py      # 蓝图格式转换
│   └── pdf_to_blueprint.py         # PDF → 蓝图
│
├── docs/                           # 文档
│   ├── INCIDENTS.md                # 事故记录
│   ├── entity-architecture-proposal.md
│   ├── unity-env-setup.md
│   └── cocos-env-setup.md
│
└── 7.1.0/                          # Luna 7.1.0 SDK（.gitignore）
```

## Luna 构建方案

Linux ECS 上直接用 MSBuild + Bridge.NET 编译 C# → JS，拼接到 Luna 7.1.0 引擎。

```
1. MSBuild 编译 C# → UnityScriptsCompiler.js（~6s）
2. 模板引擎去除 stub GameFlowManagerMain
3. 拼接：engine/scripts.js + UnityScriptsCompiler.js
4. Runtime polyfill 注入（CreatePrimitive/Font/Material 兼容）
5. convertToSingleHTML 打包为单文件 HTML（~7MB）
6. 输出验证：方法数 ≥ 3, 必需方法存在, 体积 ≤ 25MB
```

**要点**：
- 构建服务：`worker/linux-bridge-build.js`（端口 3080）
- 160 个预烘焙颜色池对象（`__Pool_{Shape}_{Color}_{NN}`），不需要运行时 SetColor
- 支持 partial class 多文件编译（>800 行自动拆分）
- `GameFlowManagerMain.cs` 是 AI 入口文件

## API 路由

### 项目管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/:id` | 项目详情 |
| PUT | `/api/projects/:id` | 更新项目 |
| PUT | `/api/projects/:id/blueprint` | 保存蓝图 |
| POST | `/api/projects/:id/submit` | 提交构建 |
| POST | `/api/projects/:id/feedback` | 提交反馈 |
| POST | `/api/projects/:id/approve` | 审核通过 |

### 分镜

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/projects/:id/parse-storyboard` | 分镜解析（FormData） |
| POST | `/api/projects/:id/generate-storyboard` | SSE 生成配图 |
| POST | `/api/projects/:id/edit-frame` | AI 编辑单帧 |

### 流程图作者入口（Blueprint 2.0, 2026-06-12）

项目详情页的 `流程图` tab 是 Blueprint 2.0 的人工语义作者入口。它面向策划填写
phase、entity、resource、requiredInteractions、cost 和 completeCondition，
并将 Flow 转换为 SourceSceneIR/source preview 后再进入 SourceIR/Blueprint/WebGL
链路。Flow 是人工语义基准，不直接替代 storyboard2html/source HTML 的生产事实源。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects/:id/storyboard-flow` | 读取项目 Flow、最近校验报告和生成物 |
| PUT | `/api/projects/:id/storyboard-flow` | 保存 Flow JSON |
| POST | `/api/projects/:id/storyboard-flow/validate` | 运行 Flow authoring preflight |
| POST | `/api/projects/:id/storyboard-flow/source-ir` | 生成 SourceSceneIR 与 source preview HTML |
| POST | `/api/projects/:id/storyboard-flow/diff` | 对比人工 Flow 与 storyboard2html source HTML |
| GET | `/api/projects/:id/storyboard-flow/artifacts/*` | 访问 Flow/source/diff 生成物 |

相关文件：

- 策划填写规范：`docs/storyboard-flow-authoring-guide.md`
- 示例模板：`fixtures/storyboard-flow-template.json`
- 严格 parity 样例：`fixtures/storyboard-flow-space-junk-golden.json`
- JSON contract：`contracts/storyboard-flow-prototype.v1.json`
- CLI：`scripts/storyboard-flow-source-ir.cjs`、`scripts/storyboard-flow-diff.cjs`
- 回归：`node test/storyboard-flow-space-junk-golden.test.cjs`，要求 Flow diff 为 `blocker=0,warn=0,info=0`

### Dashboard

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/dashboard/stats` | 综合仪表盘数据 |
| GET | `/api/dashboard/pipeline-metrics?last=N` | Pipeline 指标（失败热点/通过率/趋势/项目失败明细） |
| GET | `/api/dashboard/api-health` | API 健康检查 |
| GET | `/api/watchdog` | Watchdog 状态 |

### Worker

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/worker/poll?workerId=xxx` | 拉取任务 |
| POST | `/api/worker/heartbeat` | 心跳 |
| POST | `/api/worker/status` | Worker 状态上报（含结构化失败归因） |
| POST | `/api/tasks/:taskId/upload-build` | 上传构建产物 |

## 知识回流系统

CUA/Visual 验证失败自动记录到 `pending-rules.json`，经 3 次验证后自动晋升为 `promoted-rules.json`，注入到后续 codegen 和 review 中。语义去重（Jaccard > 50%）防止重复录入。

## 部署

### 服务端（主 ECS, Linux）

```bash
npm install && node server.cjs
# 或 PM2
pm2 start ecosystem.config.cjs
```

### 环境变量

通过 `worker/.env` 管理（dotenv 加载）。

| 变量 | 说明 | 必填 |
|------|------|------|
| `LLM_API_KEY` | Claude API Key | 可选（有内置默认） |
| `OPENAI_API_KEY` | GPT-5.4 Key（代码审核） | ✅ |
| `SILICONFLOW_API_KEY` | SiliconFlow Key（PlayableAgent VLM） | 可选 |
| `DOUBAO_API_KEY` | 豆包 Key（分镜/Spec） | 可选 |
| `GEMINI_API_KEY` | Gemini Key（视频分析） | 可选 |

### CLI 认证切换（OAuth ↔ 中转站）

`worker/codex-code-coder.js` 里的 CLI spawn 优先从 `CODEX_HOME/auth-active.json` 读取当前认证模式，并兼容回退到旧的 home-level auth 标记文件。

- 文件 shape：`{ "mode": "oauth" }` 或 `{ "mode": "relay", "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "..." }`（权限 `600`）
- 切换命令（本机 `~/.bashrc` 里的 shell 函数）：
  - `cc-oauth [args...]` — 走官方 OAuth（`CLAUDE_CODE_OAUTH_TOKEN`），同时把 active.json 写成 oauth
  - `cc-relay [args...]` — 走中转站（从 `~/.claude-relay.env` 读 URL+Token），同时把 active.json 写成 relay
- 生效时机：worker hot-reload 每任务清 require 缓存（见 `worker/linux-worker-client.js` 热更新机制），**无需 `pm2 restart`**，下一个任务 spawn CLI 即按新模式（日志里会打 `[codex-auth] mode=oauth|relay`）
- 未覆盖：`worker/luna-agent.js` 的直连 Anthropic SDK 仍走 `process.env`，不受此机制控制

## 运维

### Pipeline 指标

```bash
# 终端诊断报告（人类可读）
node engine/metrics.cjs

# JSON 格式（程序消费）
node -e "console.log(JSON.stringify(require('./engine/metrics.cjs').getMetricsSummary(50), null, 2))"
```

- **Dashboard**: `http://localhost:3901/dashboard` → "Pipeline 指标" tab
- **API**: `GET /api/dashboard/pipeline-metrics?last=50`
- **原始数据**: `server-data/metrics/pipeline-metrics.jsonl`（每次 pipeline 自动追加）

诊断报告包含：成功率、失败热点（按 stage）、瓶颈 stage、stage 通过率、错误分类（CODE/INFRA/GATE/FATAL）、趋势、top 失败原因。

### 失败归因

Pipeline 失败时自动记录结构化归因：
- **metrics JSONL**: `failedAtStage` + `failReason` + `failClassification`
- **项目 JSON**: `lastFailure` + `failureHistory`（保留最近 10 条）
- **alerts**: 带 stage/classification/taskId 的分类告警

失败同时触发 `lesson-extractor` 自动提取规则到 `pending-rules.json`（Jaccard 去重，重复命中计数）。

### 构建清理

```bash
# 预览将清理的目录
node engine/cleanup-old-builds.cjs --dry-run

# 清理 7 天前的构建（默认）
node engine/cleanup-old-builds.cjs

# 清理 3 天前的构建
node engine/cleanup-old-builds.cjs --days 3
```

建议 cron: `0 3 * * * cd /opt/blueprint-editor && node engine/cleanup-old-builds.cjs --days 7 >> /var/log/blueprint-cleanup.log 2>&1`

## License

Private — Soyoo AI Tools
