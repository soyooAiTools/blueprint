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
| 3. AI 编码 | ~1min | Claude Sonnet 读蓝图 → Unity C#，编译失败自动修复（最多 10 轮） |
| 4. Luna 构建 | ~38s | jake pipeline（4 stages）+ MSBuild Rebuild |
| 5. 渠道转换 | ~30s | 多文件 → 单文件 AppLovin HTML（~725KB） |
| 6. 审核迭代 | 人工 | 预览 → 反馈 → 重新编码 → 再构建，直到满意 |

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + @xyflow/react 12 + Vite 7 |
| 后端 | Node.js (server.cjs, PM2) |
| AI 编码 | Claude Sonnet 4.5 (Anthropic Messages API) |
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

## 目录结构

```
blueprint-editor/
├── server.cjs                    # HTTP 服务端（API + 静态文件，端口 3901）
├── storyboard-parser.cjs         # 分镜解析 + 配图生成（Gemini API）
├── dashboard.html                # Worker Pool 监控仪表盘
├── package.json
│
├── worker/                       # Unity Worker（Windows Server）
│   ├── worker-client.js          # 任务轮询 + SVN + 构建编排
│   ├── worker-coder.js           # AI 编码（Luna 制作规范 + 工程上下文）
│   ├── worker-bridge-build.js    # Luna jake + MSBuild 构建
│   ├── worker-html-converter.js  # 单文件 HTML 渠道转换
│   ├── worker-patch.js           # 预构建修复（scenes, luna.json）
│   ├── ecosystem.config.js       # PM2 配置
│   └── html-templates/           # Luna 运行时模板
│
├── worker-cocos/                 # Cocos Worker（备选引擎）
│   ├── worker-client.js          # 任务轮询（Cocos 流程）
│   ├── worker-coder.js           # AI 编码（TypeScript）
│   ├── worker-cocos-build.js     # Cocos Creator CLI 构建
│   └── worker-html-converter.js  # HTML 转换（PNG→WebP + zlib）
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

## 部署

### 快速启动

```bash
# 服务端
npm install && node server.cjs

# 前端开发
npm run dev

# Worker（Windows Server）
cd worker && pm2 start ecosystem.config.js
```

### 生产部署

```bash
# 主 ECS（Linux）— 部署 server.cjs
scp server.cjs root@120.55.70.226:/opt/blueprint-editor/
ssh root@120.55.70.226 "pm2 restart blueprint"

# Worker ECS（Windows）— 部署 worker 文件（经主 ECS 跳板）
scp <file> root@120.55.70.226:/tmp/
ssh root@120.55.70.226 "sshpass -p '***' scp /tmp/<file> Administrator@42.121.160.107:C:/worker/"
ssh root@120.55.70.226 "sshpass -p '***' ssh Administrator@42.121.160.107 'pm2 restart worker-client'"
```

### 远程重启 Unity

```bash
ssh root@120.55.70.226 "sshpass -p '***' ssh Administrator@42.121.160.107 'schtasks /run /tn LaunchUnity'"
```

自动启动 Unity + 点掉管理员弹窗。

## Gemini 配置

| 变量 | 说明 |
|------|------|
| `GEMINI_API_KEY` | Google Gemini API Key |
| `HTTPS_PROXY` | 代理地址（国内需要） |

模型：`gemini-2.5-flash`（分镜解析）+ `gemini-3-pro-image-preview`（配图生成）

## License

Private — Soyoo AI Tools
