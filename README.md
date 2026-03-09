# Blueprint — AI Playable Ad Pipeline

自动化试玩广告生产流水线：从策划文案到可投放的单文件 HTML，全程 AI 驱动。

- **线上地址**: https://playcools.top/blueprint/
- **耗时**: 策划文案提交 → 可预览试玩广告 ≈ **3 分钟**

## 架构

```
策划文案 → 分镜解析 → 蓝图编辑 → AI 编码 → Luna 构建 → 渠道 HTML
                                    ↑                        |
                                    └── 反馈迭代 ←── 审核预览 ←┘
```

### E2E 流程

| 阶段 | 耗时 | 说明 |
|------|------|------|
| 1. 分镜解析 | ~30s | PDF/文案 → AI 拆帧 → 线稿图 → HTML 分镜板 |
| 2. 蓝图编辑 | 人工 | 分镜转蓝图节点，在 Web 端编辑场景/交互/逻辑/数值 |
| 3. AI 编码 | ~1min | Claude Opus 4.6 读蓝图 → Unity C#，编译失败自动修复（最多 10 轮） |
| 4. Luna 构建 | ~38s | jake pipeline（4 stages）+ MSBuild Rebuild |
| 5. 渠道转换 | ~30s | 多文件 → 单文件 AppLovin HTML（~725KB） |
| 6. 审核迭代 | 人工 | 预览 → 反馈 → 重新编码 → 再构建，直到满意 |

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + @xyflow/react 12 + Vite 7 |
| 后端 | Node.js (server.cjs, PM2) |
| AI 编码 | Claude Opus 4.6 (中转 API: crs.mindrix.app) |
| 分镜 AI | Gemini 2.5 Flash（解析）+ Gemini 3 Pro（配图） |
| 构建 | Unity 2022.3 + Luna SDK 6.4.0 |
| 转换 | Brotli + html-minifier + 渠道 SDK 注入 |
| 版本控制 | SVN + Git |

## Luna 构建方案

绕过 Unity Bridge（18801），直接用 MSBuild + Bridge.NET 编译 C# → JS。

```
1. jake project:build       Stage1-4（用 stage1 缓存，~30s）
2. 清 MSBuild obj 缓存      rmdir /s /q LunaCompiler/Scripts/obj
3. MSBuild Rebuild           Bridge.NET 编译 .cs → JS（~8s）
4. JS 复制到 stage4          替换 UnityScriptsCompiler.js
5. Runtime polyfill 注入     CreatePrimitive/Font/Material 兼容
```

**要点**：
- Bridge 18801 离线不影响构建（stage1 缓存存在即可）
- `luna.json` 必须设 `forceSourcesBasedCompilation: true`
- `GameFlowManagerMain.cs` 是 AI 入口文件（不在 SVN 中，每次任务由 AI 创建）

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
├── storyboard-parser.cjs         # 分镜解析 + 配图生成（Gemini API）
├── dashboard.html                # Worker Pool 监控仪表盘
├── package.json
│
├── worker/                       # Unity Worker（Windows Server, 部署到 D:\worker-repo\worker）
│   ├── worker-client.js          # 任务轮询 + SVN + 构建编排（入口，加载 dotenv）
│   ├── worker-coder.js           # AI 编码（Claude Opus 4.6, Luna 制作规范 + 工程上下文）
│   ├── worker-cua-verify.js      # CUA 蓝图流程验证（GPT-5.4 操控，pass/fail）
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
| 引擎 | Unity 2022.3 + Luna 6.4.0 | Cocos Creator 3.8.8 |
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

## CUA 蓝图流程验证

AI 编码 → 构建完成后，自动运行 CUA（Computer Use Agent）验证蓝图流程：

- **模型**：GPT-5.4（OpenAI CUA）
- **判定方式**：纯 pass/fail，不打分
- **通过标准**：
  1. 蓝图所有 shot 都能操作覆盖
  2. CTA 按钮可到达并可点击
  3. 游戏不卡死/白屏/崩溃
- **不通过时**：把未覆盖 shot + 问题描述反馈给 AI 重新编码，最多 3 轮
- **到达 CTA 终局** → 自动判定通过（忽略非关键问题）

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
| `OPENAI_API_KEY` | OpenAI API Key（CUA 验证用） | ✅ |
| `GEMINI_API_KEY` | Google Gemini API Key | ✅ |
| `HTTPS_PROXY` | 网络代理（国内需要） | ✅ |
| `LLM_API_KEY` | AI 编码中转 API Key（默认内置） | 可选 |
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
