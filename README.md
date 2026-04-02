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

### E2E 流程

| 阶段 | 耗时 | 说明 |
|------|------|------|
| 1. 分镜解析 | ~30s | PDF/文案 → AI 拆帧 → 线稿图 → HTML 分镜板 |
| 2. 蓝图编辑 | 人工 | 分镜转蓝图节点，在 Web 端编辑场景/交互/逻辑/数值 |
| 3. AI 编码 | ~1min | Claude Opus 4.6 读蓝图 → Unity C#，编译失败自动修复（最多 10 轮） |
| 4. Luna 构建 | ~6s | MSBuild + Bridge.NET 编译 + 单 HTML 打包 |
| 5. 渠道转换 | 内含 | convertToSingleHTML 已集成到构建步骤 |
| 6. 审核迭代 | 人工 | 预览 → 反馈 → 重新编码 → 再构建，直到满意 |

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + @xyflow/react 12 + Vite 7 |
| 后端 | Node.js (server.cjs, PM2) |
| AI 编码 | Claude Opus 4.6 (中转: crs.mindrix.app) |
| 分镜解析 | 豆包 Seed 2.0 Pro (ark.cn-beijing.volces.com) |
| 蓝图转换 | Claude Opus 4.6 (中转: crs.mindrix.app) |
| 代码审核 | GPT-5.4 (中转: sub.mindrix.app) |
| CUA 验证 | PlayableAgent — Qwen2.5-VL-72B (SiliconFlow) |
| 视频分析 | Gemini 2.5 Pro (中转: sub.mindrix.app) |
| 构建 | Luna 7.1.0 + MSBuild (Linux ECS) |
| 转换 | convertToSingleHTML 内联打包（~7MB） |
| 版本控制 | SVN + Git |

## Luna 构建方案

Linux ECS 上直接用 MSBuild + Bridge.NET 编译 C# → JS，拼接到 Luna 7.1.0 引擎。

```
1. MSBuild 编译 C# → UnityScriptsCompiler.js（~6s）
2. 模板引擎去除 stub GameFlowManagerMain
3. 拼接：engine/scripts.js + UnityScriptsCompiler.js
4. Runtime polyfill 注入（CreatePrimitive/Font/Material 兼容）
5. convertToSingleHTML 打包为单文件 HTML（~7MB）
```

**要点**：
- 构建服务：`worker/linux-bridge-build.js`（端口 3080）
- Luna 7.1.0 使用单文件 engine/scripts.js（含 Deserializers），不需要旧版 deserializers.js
- 模板引擎已打 null guard 补丁（防止 loadSettings 崩溃）
- 160 个预烘焙颜色池对象，不再需要运行时 SetColor
- `GameFlowManagerMain.cs` 是 AI 入口文件（每次任务由 AI 创建）

## 自动架构图

AI 编码完成后自动生成代码架构关系图：

- `architecture.json` — 结构化数据（类、方法、依赖关系、职责）
- `architecture.drawio` — draw.io 可视化（可直接打开编辑）
- 纯静态 C# 分析，零 API 调用
- 随代码一起 SVN 提交

## WebGL 预览

- 预览 URL：`/webgl/{projectId}/iframe.html`（实际游戏画面）
- `index.html` 是 Luna Dev Environment 空壳，不含游戏内容
- 构建上传后自动检测 `iframe.html` 优先使用
- **白屏检测**：screenshot-review 服务在 AI 审核前做像素级检测（Canvas 颜色方差），白屏/黑屏/纯色硬 REJECT

## 目录结构

```
blueprint-editor/
├── server.cjs                    # HTTP 服务端（API + 静态文件，端口 3901）
├── storyboard-parser.cjs         # 分镜解析（豆包 Seed 2.0 Pro）
├── doubao-adapter.cjs            # 豆包 API 适配器（兼容 @google/genai 接口）
├── dashboard.html                # Worker Pool 监控仪表盘
├── package.json
│
├── worker/                       # Unity Worker（Windows Server, 部署到 D:\worker-repo\worker）
│   ├── worker-client.js          # 任务轮询 + SVN + 构建编排（入口，加载 dotenv）
│   ├── worker-coder.js           # AI 编码（Claude Opus 4.6, Luna 制作规范 + 工程上下文）
│   ├── worker-playableagent.js   # PlayableAgent 蓝图验证（VLM + __gameState）
│   ├── worker-cua-verify.js      # [已弃用] 旧 CUA 验证
│   ├── worker-bridge-build.js    # Luna jake + MSBuild 构建
│   ├── worker-html-converter.js  # 单文件 HTML 渠道转换
│   ├── worker-patch.js           # 预构建修复（scenes, luna.json）
│   ├── generate-architecture.js  # 代码架构图生成（C# → JSON + drawio）
│   ├── ecosystem.config.cjs      # PM2 配置（D 盘路径，不含 env）
│   ├── deploy.cmd                # 一键部署脚本（git pull + npm install + pm2）
│   ├── package.json              # 依赖（dotenv, brotli, html-minifier）
│   ├── .env.example              # 环境变量模板
│   ├── .env                      # 实际环境变量（不入 git）
│   └── html-templates/           # Luna 运行时模板
│
├── worker-cocos/                 # Cocos Worker（备选引擎）
│   ├── worker-client.js          # 任务轮询（Cocos 流程）
│   ├── worker-coder.js           # AI 编码（TypeScript）
│   ├── worker-cocos-build.js     # Cocos Creator CLI 构建
│   └── worker-html-converter.js  # HTML 转换（PNG→WebP + zlib）
│
├── screenshot-review/              # WebGL 白屏检测 + AI 审核
│   ├── screenshot-review.cjs       # Playwright 截图 + 像素分析
│   └── screenshot-review-server.cjs # HTTP 服务（端口 18820）
│
├── docs/
│   ├── unity-env-setup.md        # Unity Worker 部署指南
│   └── cocos-env-setup.md        # Cocos Worker 部署指南
│
└── data/webgl/                   # WebGL 构建产物存储
```

## Unity vs Cocos Worker

| | Unity (`worker/`) | Cocos (`worker-cocos/`) |
|---|---|---|
| 引擎 | Unity 2022.3 + Luna 7.1.0 | Cocos Creator 3.8.8 |
| 语言 | C# | TypeScript |
| 构建 | Luna jake (~38s) | Cocos CLI (~17s) |
| 产物 | ~725KB | ~11.5MB |
| PM2 | `worker-client` | `worker-cocos` |

通过项目 `engine` 字段自动路由到对应构建流程。

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

## PlayableAgent 蓝图流程验证

AI 编码 → 构建完成后，自动运行 PlayableAgent 验证蓝图 Phase 覆盖：

- **模型**：Qwen2.5-VL-72B（SiliconFlow VLM）+ `__gameState` API
- **方式**：Xvfb + Playwright 非 headless → 截图 → VLM 分析决策 → CDP 操作 → 读取游戏状态
- **判定方式**：纯 pass/fail，基于 Phase 覆盖率
- **通过标准**：
  1. specs.json 中所有 Phase 都被 `completedPhases` 覆盖
  2. 游戏不卡死/黑屏
  3. 实体达到终态（buildable entities → state=2）
- **不通过时**：未完成 Phase + gameState 反馈给 AI 重新编码，最多 3 轮
- **模块**：`worker/worker-playableagent.js` → `blueprint_verify.py`（Python 3.8）
- **费用**：~¥0.12/次（20步测试）

## 部署

### 服务端（主 ECS, Linux）

```bash
npm install && node server.cjs
# 或 PM2
pm2 start server.cjs --name blueprint
```

### Worker（Windows Server, D:\worker-repo）

**首次部署：**
```cmd
D:
git clone https://github.com/soyooAiTools/blueprint.git worker-repo
cd worker-repo\worker
copy .env.example .env
REM 编辑 .env 填入 OPENAI_API_KEY、GEMINI_API_KEY、代理等
npm install --production
pm2 start ecosystem.config.cjs --only worker-unity
pm2 save
```

**后续更新（一条命令）：**
```cmd
D:\worker-repo\worker\deploy.cmd
```
自动执行：git pull → npm install → pm2 唯一进程重启

### 环境变量

所有环境变量通过 `worker/.env` 管理（dotenv 加载），不依赖 PM2 env 或系统环境变量。

| 变量 | 说明 | 必填 |
|------|------|------|
| `LLM_API_KEY` | Claude 编码/蓝图转换 API Key（默认内置） | 可选 |
| `DOUBAO_API_KEY` | 豆包 Seed 2.0 Pro Key（分镜/Spec/截图审核） | 可选 |
| `OPENAI_API_KEY` | GPT-5.4 Key（代码审核用） | ✅ |
| `GEMINI_API_KEY` | Gemini Key（视频分析用） | 可选 |
| `SILICONFLOW_API_KEY` | SiliconFlow Key（PlayableAgent VLM） | 可选 |
| `LLM_MODEL_GENERATE` | AI 编码模型（默认 claude-opus-4-6） | 可选 |

### 远程重启 Unity

```bash
ssh -i /root/.ssh/worker_key Administrator@42.121.160.107 "schtasks /run /tn LaunchUnity"
```

### Worker 目录结构

```
D:\worker-repo\              # git clone 仓库根目录
├── worker/                  # Worker 代码 + 配置
│   ├── .env                 # 环境变量（不入 git）
│   ├── ecosystem.config.cjs # PM2 配置
│   ├── deploy.cmd           # 一键部署
│   └── node_modules/        # 依赖
├── server.cjs               # 主服务端代码
└── ...                      # 其他仓库文件
```

## License

Private — Soyoo AI Tools
