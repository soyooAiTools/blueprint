# Blueprint — AI Playable Ad Pipeline

自动化试玩广告生产流水线：从策划文案到可投放的单文件 HTML，全程 AI 驱动。

- **线上地址**: https://playcools.top/blueprint/
- **耗时**: 策划文案提交 → 可预览试玩广告 ≈ **3 分钟**

## 架构

```
策划文案 → 分镜解析 → 蓝图编辑 → AI 编码 → Luna 构建 → PlayableAgent验证 → 渠道 HTML
              (豆包)                (Claude)              (Qwen VLM)
                                    ↑                                      |
                                    └────────── 反馈迭代 ←── 审核预览 ←────┘
```

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
| upload | `engine/stages/upload.cjs` | SVN/存储上传 |

### 质量门控

- **review**: lineCount >= 100, phase 架构机械检查, 禁止 autoplay
- **compile**: 方法数 >= 3, 必需方法检查 (Start/Update/CheckEventRules), 25MB 上限
- **visual-check**: 多帧分析 (t=0/3/8s), 实体可见性, 画面变化检测
- **cua-verify**: Phase 覆盖率, 30min 总时间上限, 5 轮无进展提前退出

### Engine 核心模块

| 模块 | 说明 |
|------|------|
| `engine/fix-loop.cjs` | 声明式 fix-loop 原语（maxRounds, onExhausted, beforeRound, attempt） |
| `engine/error-classifier.cjs` | INFRA(退避) / CODE(recode) / FATAL(终止) 三类错误分类 |
| `engine/recode.cjs` | 统一重编码（clone → seed → generate → findMainCs），支持 extraFiles |
| `engine/static-check.cjs` | 静态代码检查（禁用 API / Bridge.NET 限制） |
| `engine/helpers.cjs` | 构建请求、issue 分类、结构化反馈构建 |

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

> **注意**: 仅支持 V4 entity-driven 蓝图格式（`entities[]` + `phases[]` + `specs[]`）。

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
│   ├── luna-claude-code.md         # Claude Code Luna 开发规范
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

### Worker

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/worker/poll?workerId=xxx` | 拉取任务 |
| POST | `/api/worker/heartbeat` | 心跳 |
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

## License

Private — Soyoo AI Tools
