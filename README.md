# Blueprint — AI Playable Ad Pipeline

自动化试玩广告生产流水线：从分镜到蓝图到可投放的单文件 HTML。

- **线上地址**: `https://playcools.top/blueprint/`
- **GitHub**: `soyooAiTools/blueprint`

## 架构

```
Blueprint Editor (Web) → Worker (Windows Server) → 渠道 HTML
```

### 完整 E2E 流程
1. **分镜解析** — 上传策划文案（文本/doc/docx/xlsx）+ 参考图片，AI 解析为分镜帧
2. **蓝图编辑** — 分镜转蓝图节点，在 Web 端编辑试玩广告蓝图（场景+转场+交互）
2. **任务提交** — Worker 自动 poll 拉取任务
3. **SVN 更新** — 拉取最新 Unity 项目代码
4. **AI 编码** — Claude Sonnet 4.5 根据蓝图生成 Unity C# 代码（基于现有 SLG 模板工程，遵循公司 Luna 制作规范）
5. **编译修复** — 自动检测编译错误，LLM 持续修复直到通过（最多 10 轮，相同错误连续 3 次自动重新生成）
6. **Luna 构建** — Unity C# → HTML5（jake pipeline, 4 stages, ~28s）
7. **渠道转换** — 多文件输出 → 单文件 AppLovin HTML（~725KB）
8. **上传通知** — zip + 渠道 HTML 上传，SSE 推送前端通知
9. **审核通过 → SVN 提交** — 自动清理缓存目录（Library/Temp/LunaTemp/obj 等）后提交代码

### 耗时
- AI 编码 + 修复: ~1 分钟
- Luna 构建: ~28 秒
- HTML 转换 + 上传: ~30 秒
- **总计: ~3 分钟**

## 技术栈

- **前端**: React 19 + @xyflow/react 12 + Vite 7（支持 Unity / Cocos 双引擎项目）
- **后端**: Node.js (server.cjs, Express 5, PM2)
- **AI**: Claude Sonnet 4.5 (Anthropic Messages API)
- **构建**: Unity 2022.3 + Luna SDK 6.4.0
- **转换**: Brotli + html-minifier + 渠道 SDK 注入
- **依赖**: AdmZip, JSZip, Multer, CORS
- **版本控制**: SVN

## 目录结构

```
blueprint-editor/
├── server.cjs                        # HTTP 服务端（API + 静态文件）
├── dashboard.html                    # Worker Pool 仪表盘页面
├── package.json
├── package-lock.json
├── .gitignore
├── cases-api-patch.cjs               # 经验库 API 补丁（挂载到 server）
├── add-dashboard-route.sh            # 部署脚本
├── add-prefix-route.sh               # 部署脚本
├── apply-patch.sh                    # 部署脚本
│
├── cases/                            # 案例数据存储
│   └── case_*/                       # 各案例目录
│       └── metadata.json
│
├── data/                             # 数据存储
│   └── webgl/                        # WebGL 构建产物
│       └── proj_*/                   # 各项目构建
│           ├── index.html
│           ├── Build/                # WebGL 构建文件（.data.br, .wasm.br 等）
│           └── TemplateData/         # Unity 模板资源
│
├── public/                           # 静态文件目录
│   └── builds/                       # 已发布构建
│       └── proj_*/                   # 同 data/webgl 结构
│
├── docs/
│   ├── unity-env-setup.md            # Unity Worker 部署指南（20 步清单）
│   └── cocos-env-setup.md            # Cocos Worker 部署指南
│
├── worker-cocos/                     # Cocos Worker 端脚本
│   ├── worker-client.js              # 任务轮询 + 流程编排
│   ├── worker-coder.js               # AI 编码（Cocos TypeScript）
│   ├── worker-cocos-build.js         # Cocos Creator CLI 构建
│   ├── worker-patch.js               # 预构建修复（场景检测）
│   ├── worker-html-converter.js      # HTML 单文件转换（PNG→WebP + zlib）
│   └── ecosystem.config.js           # PM2 配置
│
└── worker/                           # Unity Worker 端脚本
    ├── worker-client.js              # v4 主任务处理
    ├── worker-coder.js               # v4 AI 编码 agent（Luna 制作规范 + 工程上下文感知）
    ├── worker-bridge-build.js        # Luna 构建模块
    ├── worker-patch.js               # 预构建修复
    ├── worker-html-converter.js      # HTML 渠道转换
    ├── ecosystem.config.js           # PM2 配置
    ├── html-templates/               # Luna 运行时模板
    │   ├── index.template.html
    │   └── decompressScript.js
    └── unity-scripts/                # Unity 启动脚本
        ├── auto-dismiss-unity.ps1
        └── launch-unity-auto.ps1
```

## Unity vs Cocos Worker

本仓库包含两套 Worker，分别对应 Unity 和 Cocos Creator 引擎：

| | Unity Worker (`worker/`) | Cocos Worker (`worker-cocos/`) |
|---|---|---|
| **引擎** | Unity 2022.3 + Luna SDK 6.4.0 | Cocos Creator 3.8.8 |
| **语言** | C# | TypeScript |
| **构建** | Luna jake pipeline (~28s) | Cocos Creator CLI `--build` (~17s) |
| **压缩** | Brotli + html-minifier | PNG→WebP (sharp) + zlib deflate |
| **产物** | ~725KB 单文件 HTML | ~11.5MB 单文件 HTML |
| **构建模块** | `worker-bridge-build.js` | `worker-cocos-build.js` |
| **部署路径** | `C:\worker\` | `D:\worker-cocos\` |
| **PM2 名称** | `worker-unity` | `worker-cocos` |

两者共用同一后端 API（server.cjs），通过项目的 `engine` 字段区分任务路由。统一 Worker（`worker/worker-client.js`）会根据任务的 `engine` 字段自动选择对应的构建流程。

### Cocos Worker 部署 (Worker ECS 42.121.160.107)

```powershell
cd D:\worker-cocos
npm install
npm install sharp   # PNG→WebP 转换
pm2 start ecosystem.config.js
```

- Cocos Creator 路径: `D:\CocosCreator-v3.8.8-win-121518\CocosCreator.exe`
- 详细环境搭建见 [docs/cocos-env-setup.md](docs/cocos-env-setup.md)

## API 路由

### 项目管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 项目列表 |
| GET | `/api/projects/pending` | 待处理项目 |
| POST | `/api/projects` | 创建项目（支持 `engine: "unity"\|"cocos"`） |
| GET | `/api/projects/:id` | 获取项目详情 |
| PUT | `/api/projects/:id` | 更新项目 |
| DELETE | `/api/projects/:id` | 删除项目 |
| PUT | `/api/projects/:id/blueprint` | 保存蓝图 |
| POST | `/api/projects/:id/submit` | 提交构建任务 |
| POST | `/api/projects/:id/feedback` | 提交反馈 |
| POST | `/api/projects/:id/approve` | 审核通过 |
| POST | `/api/projects/:id/parse-storyboard` | 分镜解析（支持 FormData：text/files/images + 镜头选项，参考图片会用 Gemini Vision 解析） |
| POST | `/api/projects/:id/generate-storyboard` | 为每帧生成配图（Gemini / SVG 占位） |
| POST | `/api/projects/:id/edit-frame` | AI 自然语言编辑单帧（`{ frameIndex, instruction }`） |
| GET | `/api/projects/:id/webgl` | 获取 WebGL 构建 |
| POST | `/api/projects/:id/status` | 更新状态 |
| POST | `/api/projects/:id/upload-webgl` | 上传 WebGL 包 |
| POST | `/api/projects/:id/committed` | 标记已提交 |

### Worker API
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/worker/poll?workerId=xxx` | Worker 拉取任务 |
| GET | `/api/tasks/:taskId/blueprint` | 获取任务蓝图 |
| POST | `/api/worker/status` | 上报 Worker 状态 |
| POST | `/api/worker/heartbeat` | Worker 心跳 |
| POST | `/api/tasks/:taskId/upload-build` | 上传构建产物 |

## ⚙️ Gemini API 配置

分镜解析功能使用 Gemini API（通过 yyds168 中转服务）。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GEMINI_API_KEY` | yyds168 API Key（`sk-` 开头） | 硬编码在 storyboard-parser.cjs |
| `GOOGLE_GEMINI_BASE_URL` | API 中转地址 | `https://api.yyds168.net` |

### 调用方式

- **协议**: OpenAI 兼容（`/v1/chat/completions`），但代码使用 `@google/genai` SDK + `httpOptions.baseUrl` 中转
- **认证**: `Bearer <sk-xxx>` （yyds168 发货密钥，非 Google 原生 API Key）
- **当前模型**: `gemini-3.0-pro`
- **配置文件**: `storyboard-parser.cjs` 第 22-26 行

### 可用模型（yyds168）

| 模型 | 说明 |
|------|------|
| `gemini-3.0-pro` | 当前使用 ✅ |
| `gemini-3.1-pro-high` | 最新版，thinking tokens 较多 |
| `gemini-3.1-pro-low` | 最新版，thinking tokens 较少 |
| `gemini-2.5-flash` | 快速模型 |
| `gemini-2.5-pro` | 上一代 Pro |

### 更换 Key

1. 从 yyds168 获取新的 `sk-` 开头的 Key
2. 修改 `storyboard-parser.cjs` 中的 `apiKey` 字段，或设置环境变量 `GEMINI_API_KEY`
3. `pm2 restart blueprint-editor`

> ⚠️ yyds168 的 Key 格式为 `sk-xxx`，**不是** Google 原生 `AIzaSy-xxx` 格式。两者不通用。

## 快速部署

详见 [docs/unity-env-setup.md](docs/unity-env-setup.md)

```bash
# 安装依赖
npm install

# 启动服务端（端口 3901）
node server.cjs

# 启动前端开发（Vite）
npm run dev

# Worker 端（在 Windows Server 上）
cd worker
pm2 start ecosystem.config.js
```
