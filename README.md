# Blueprint Editor 蓝图编辑器

> 试玩广告可视化蓝图编辑、自动化构建与案例审核平台

## 项目简介

Blueprint Editor 是一个面向试玩广告（Playable Ad）制作流程的可视化蓝图编辑工具。策划人员可以通过节点拖拽的方式设计广告分镜脚本，系统对接 autoCoding 自动化流水线，实现从蓝图设计→自动编码→WebGL 构建→审核反馈的完整闭环。

## ✨ 功能特性

- **可视化蓝图编辑** — 基于 React Flow 的节点编辑器，支持分镜节点（Shot Node）拖拽、连线
- **项目管理** — 创建、编辑、删除、提交、审核完整项目生命周期
- **autoCoding 集成** — 提交蓝图后自动触发 AI Coding Agent 流水线
- **Worker Pool** — 支持分布式 Worker 轮询任务、心跳上报、状态同步
- **WebGL 预览** — 构建产物上传后可在线预览 Unity WebGL 效果
- **审核反馈** — 支持多轮反馈/修改/通过/提交 SVN 流程
- **Dashboard** — 内置 Worker Pool 监控仪表盘

## 🛠 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + Vite 7 + @xyflow/react |
| 后端 | Node.js + 原生 HTTP Server |
| 构建 | Vite |
| 文件处理 | AdmZip, JSZip, Multer |
| 部署 | PM2 + Nginx |

## 📦 安装与部署

```bash
# 克隆仓库
git clone https://github.com/soyooAiTools/blueprint-editor.git
cd blueprint-editor

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建生产版本
npm run build

# 启动服务
node server.cjs
# 或使用 PM2
pm2 start server.cjs --name blueprint-editor
```

### 环境配置

- **端口**: 默认 3901（可通过 `PORT` 环境变量修改）
- **Nginx 代理路径**: `/blueprintEditor`
- **线上地址**: `https://playcools.top/blueprintEditor`

## 📁 项目结构

```
blueprint-editor/
├── server.cjs              # 后端服务（API + 静态文件）
├── package.json
├── dashboard.html          # Worker Pool 监控页
├── public/                 # 静态资源
│   └── builds/             # WebGL 构建产物
├── data/                   # WebGL 数据
├── cases/                  # 案例数据
├── server-data/            # 运行时数据（项目JSON、WebGL文件）
│   ├── projects/           # 项目 JSON 文件
│   └── webgl/              # WebGL 构建输出
└── src/                    # React 前端源码（Vite 构建）
```

## 🔌 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 获取项目列表 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/:id` | 获取项目详情（含蓝图） |
| PUT | `/api/projects/:id` | 更新项目信息 |
| PUT | `/api/projects/:id/blueprint` | 保存蓝图数据 |
| POST | `/api/projects/:id/submit` | 提交项目到 autoCoding |
| POST | `/api/projects/:id/feedback` | 提交审核反馈 |
| POST | `/api/projects/:id/approve` | 审核通过 |
| POST | `/api/projects/:id/upload-webgl` | 上传 WebGL 构建 |
| GET | `/api/worker/poll` | Worker 轮询任务 |
| POST | `/api/worker/status` | Worker 上报状态 |
| POST | `/api/worker/heartbeat` | Worker 心跳 |
| POST | `/api/tasks/:id/upload-build` | 上传构建 ZIP |

## 📄 License

Private
