# Cocos Worker 环境搭建与部署

> 最后更新: 2026-02-20, E2E 含 AI 编码实测全通 (231s)

## 架构概览

```
前端蓝图编辑器 → 后端 API (主 ECS) → 任务队列 JSON → Worker (Win Server)
                   ↑                                      ├── SVN checkout/update
                   │                                      ├── AI 编码 (Claude Sonnet)
                   │                                      ├── Cocos Creator CLI build
                   │                                      ├── PNG→WebP + zlib → 单文件 HTML
                   └──────────── upload HTML ──────────────┘
```

## 服务器信息

### 主 ECS (Linux, 后端 + Nginx)
- **IP**: 120.55.70.226
- **SSH**: root / Soyoo2026!Ecs
- **后端路径**: `/opt/blueprint-editor-cocos/`
- **入口文件**: `server.cjs` (不在 git repo，直接在 ECS 维护)
- **PM2**: `blueprint-cocos` (id=15), port 3902
- **Nginx**: `playcools.top/blueprintEditorCocos/` → `127.0.0.1:3902`
- **任务队列**: `/opt/autoCoding-tasks-cocos/queue/`
- **静态文件**: `/opt/blueprint-editor-cocos/data/webgl/` (构建产物 + HTML)
- **Node.js**: v20.x
- **OS**: CentOS / Alibaba Cloud Linux

### Worker ECS (Windows, 构建机)
- **IP**: 42.121.160.107
- **SSH**: Administrator / Soyoo2026!Ecs (从主 ECS 跳板: `sshpass -p 'Soyoo2026!Ecs' ssh Administrator@42.121.160.107`)
- **Worker 代码**: `D:\worker-cocos\`
- **Cocos Creator**: `D:\CocosCreator-v3.8.8-win-121518\CocosCreator.exe` (v3.8.8)
- **SVN 项目目录**: `D:\work\<project-dir>\`
- **Node.js**: v20+
- **OS**: Windows Server 2025 (headless, 无 GUI)
- **依赖**: sharp (`npm install sharp` in `D:\worker-cocos\`)

### SVN
- **地址**: `svn://47.101.191.213:3690/`
- **账号**: openclaw / openclaw

## Worker 部署步骤

### 1. 初始安装 (首次)

```bash
# 从主 ECS 跳板到 Worker
ssh root@120.55.70.226
sshpass -p 'Soyoo2026!Ecs' ssh Administrator@42.121.160.107

# 在 Worker 上
mkdir D:\worker-cocos
cd D:\worker-cocos
npm init -y
npm install sharp
```

### 2. 部署 Worker 代码

```bash
# 方式 A: 用 deploy 脚本 (从本地)
node scripts/deploy.cjs --all

# 方式 B: 手动 SCP (经跳板)
scp worker-client.js root@120.55.70.226:/tmp/worker-cocos/
ssh root@120.55.70.226 "sshpass -p 'Soyoo2026!Ecs' scp /tmp/worker-cocos/worker-client.js Administrator@42.121.160.107:D:/worker-cocos/"
```

需要部署的文件 (6个):
- `worker/worker-client.js` → `D:\worker-cocos\worker-client.js`
- `worker/worker-coder.js` → `D:\worker-cocos\worker-coder.js`
- `worker/worker-cocos-build.js` → `D:\worker-cocos\worker-cocos-build.js`
- `worker/worker-patch.js` → `D:\worker-cocos\worker-patch.js`
- `worker/worker-html-converter.js` → `D:\worker-cocos\worker-html-converter.js`
- `worker/ecosystem.config.js` → `D:\worker-cocos\ecosystem.config.js`

### 3. Cocos Creator 首次初始化

Cocos Creator 首次打开项目需要建立 library 缓存，否则 headless build 会失败:

```bash
# 在 Worker 上运行一次（会弹 GUI，需 RDP 或 VNC）
D:\CocosCreator-v3.8.8-win-121518\CocosCreator.exe --project D:\work\test-cocos
# 等 library 目录生成后即可关闭
```

### 4. 启动 Worker

```bash
# 方式 A: 直接运行
node D:\worker-cocos\worker-client.js

# 方式 B: PM2
cd D:\worker-cocos && pm2 start ecosystem.config.js

# 方式 C: Windows 计划任务 (推荐，持久化)
schtasks /create /tn "WorkerClientCocos" /tr "node D:\worker-cocos\worker-client.js" /sc onstart /ru Administrator
```

## 后端部署 (server.cjs)

```bash
# 编辑
ssh root@120.55.70.226
vi /opt/blueprint-editor-cocos/server.cjs

# 验证语法
node -c /opt/blueprint-editor-cocos/server.cjs

# 重启
pm2 restart 15  # 或 pm2 restart blueprint-cocos
```

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/:id` | 获取项目详情 |
| PUT | `/api/projects/:id` | 更新项目 |
| POST | `/api/projects/:id/blueprint` | 保存蓝图 |
| POST | `/api/projects/:id/submit` | 提交编码任务 |
| GET | `/api/worker/poll?workerId=X` | Worker 拉取任务 |
| POST | `/api/worker/status` | Worker 上报状态 |
| POST | `/api/worker/heartbeat` | Worker 心跳 |
| GET | `/api/tasks/:id/blueprint` | 获取任务蓝图 |
| POST | `/api/tasks/:id/upload-html` | 上传单文件 HTML |
| POST | `/api/tasks/:id/upload-build` | 上传构建 zip (可选) |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| WORKER_ID | workerA-cocos | Worker 标识 |
| BASE_URL | https://playcools.top/blueprintEditorCocos | 后端地址 |
| COCOS_CREATOR | D:\CocosCreator-v3.8.8-win-121518\CocosCreator.exe | Cocos Creator 路径 |
| LLM_API_KEY | (内置) | Claude API Key (`crs.mindrix.app`) |
| LLM_MODEL | claude-sonnet-4-5-20250929 | AI 编码模型 |
| WORK_DIR | D:\work | SVN 项目工作目录 |

## 已知问题

### Cocos exit code 36
Cocos Creator headless build 会因 missing assets (prefab/texture) 以 exit code 36 退出，但构建产物完好。
**处理**: `worker-cocos-build.js` 和 `worker-coder.js` 的 `tryCompile` 均检查 `build/web-mobile/index.html` 是否存在，存在则视为成功。

### SIGTERM in build-script
Cocos build 子进程报 `Error: Exit process with code:null, signal:SIGTERM in task build-script`，这是 Cocos 内部的非致命错误。
**处理**: `tryCompile` 的 error filter 排除包含 `SIGTERM` 和 `Exit process with code:null` 的行。

### PM2 不持久化
Worker ECS 上 PM2 daemon 不跨 SSH session 持久化。建议用 Windows 计划任务或 nssm 注册为系统服务。
