# Blueprint Editor — AI Playable Ad Pipeline

自动化试玩广告生产流水线：从蓝图到可投放的单文件 HTML。

## 架构

```
Blueprint Editor (Web) → Worker (Windows Server) → 渠道 HTML
```

### 完整 E2E 流程
1. **蓝图编辑** — 在 Web 端编辑试玩广告蓝图（场景+转场+交互）
2. **任务提交** — Worker 自动 poll 拉取任务
3. **SVN 更新** — 拉取最新 Unity 项目代码
4. **AI 编码** — Claude Sonnet 4.5 根据蓝图生成 Unity C# 代码
5. **编译修复** — 自动检测编译错误，LLM 修复，最多重试 3 次
6. **Luna 构建** — Unity C# → HTML5（jake pipeline, 4 stages, ~28s）
7. **渠道转换** — 多文件输出 → 单文件 AppLovin HTML（~725KB）
8. **上传通知** — zip + 渠道 HTML 上传，SSE 推送前端通知
9. **审核通过 → SVN 提交** — 自动清理缓存目录（Library/Temp/LunaTemp/obj 等）后提交代码

### 耗时
- AI 编码 + 修复: ~1 分钟
- Luna 构建: ~28 秒
- HTML 转换 + 上传: ~30 秒
- **总计: ~3 分钟**

## 目录结构

```
worker/                           # Worker 端脚本
├── worker-client.js              # v4 主任务处理
├── worker-coder.js               # v3 AI 编码 agent
├── worker-bridge-build.js        # Luna 构建模块
├── worker-patch.js               # 预构建修复
├── worker-html-converter.js      # HTML 渠道转换
├── html-templates/               # Luna 运行时模板
├── unity-scripts/                # Unity 启动脚本
└── ecosystem.config.js           # PM2 配置

docs/
└── unity-env-setup.md            # 完整部署指南（20 步清单）
```

## 快速部署

详见 [docs/unity-env-setup.md](docs/unity-env-setup.md)

## 技术栈

- **前端**: React 19 + @xyflow/react
- **后端**: Node.js (server.cjs, PM2)
- **AI**: Claude Sonnet 4.5 (Anthropic Messages API)
- **构建**: Unity 2022.3 + Luna SDK 6.4.0
- **转换**: Brotli + html-minifier + 渠道 SDK 注入
- **版本控制**: SVN
