# Video-to-Blueprint Design Spec

> 从游戏视频中提取流程逻辑，直接生成 V3 蓝图 JSON，跳过分镜确认步骤。

## 背景

当前 blueprint 流水线输入为「文案/PDF → 分镜帧 → 蓝图 → 代码」，无视频处理能力。需要新增视频输入通道，支持竞品试玩广告录屏、实录 gameplay、策划动画等全品类游戏视频，提取游戏流程逻辑（步骤、交互、转场），视觉用对象池重建。

## 方案选择

**选定方案：Gemini 视频原生理解（方案 A）**

直接把视频交给 Gemini 2.5 Pro（原生支持视频输入），一次性输出蓝图 JSON。

淘汰方案：
- 方案 B（关键帧提取 + 多轮分析）— 丢失帧间动态信息，合并逻辑复杂
- 方案 C（混合双通道）— 开发量大，成本翻倍，ROI 不合理

## 架构与数据流

```
┌─────────────────────────────────────────────────────┐
│                    Web Frontend                      │
│  新增: 视频上传入口 (拖拽/选择, 支持 mp4/mov/webm)    │
│  复用: 蓝图编辑器 (视频生成的蓝图可手动微调)           │
└──────────────┬──────────────────────────────────────┘
               │ POST /api/projects/:id/parse-video
               │ (FormData: video file, max 20MB)
               ▼
┌─────────────────────────────────────────────────────┐
│              server.cjs — 新增路由                    │
│                                                      │
│  1. 保存视频到 server-data/webgl/{projectId}/        │
│  2. FFmpeg 提取封面帧 (第1秒) → thumbnail.jpg        │
│  3. 调用 video-to-blueprint.cjs                      │
│  4. SSE 流式返回进度 + 最终 blueprint JSON            │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│         video-to-blueprint.cjs (新模块)              │
│                                                      │
│  Input:  视频文件路径                                 │
│  Step 1: FFmpeg 预处理                               │
│          - 视频信息 (时长/分辨率/帧率)                │
│          - 超过 60s → 截取前 60s                     │
│          - 非 mp4 → 转码为 mp4                       │
│          - 提取 ~8 张均匀配图帧 → frames/            │
│  Step 2: Gemini 2.5 Pro 视频理解                     │
│          - File API 上传视频                         │
│          - 轮询 file.state === "ACTIVE"              │
│          - Prompt 三步引导 → 输出蓝图 JSON            │
│          - responseSchema 强制 JSON 格式             │
│  Step 3: 校验 + 修补                                 │
│          - objectRegistry 物件名去重                  │
│          - shape 限定 Cube|Sphere|Cylinder|Plane|    │
│            Ground|UI                                 │
│          - shotNodes 数量 8-12 个                    │
│          - 最后 shotNode 强制注入 CTA                │
│          - shotNode id 格式 shot_0, shot_1...        │
│  Output: 完整 blueprint JSON (V3 格式)               │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
        现有 V5 流水线 (skeleton → AI编码 → 构建 → CUA)
```

**与现有流程的关系：**
```
现有入口:  文案/PDF → parse-storyboard → 分镜编辑 → 蓝图编辑 → 提交
新增入口:  视频     → parse-video      →          蓝图编辑 → 提交
                                         (跳过分镜)
```

两条路最终汇入同一个蓝图编辑器和 V5 构建流水线。

## Gemini Prompt 设计

三步引导策略：

**Step 1: 观察 — "你看到了什么"**
- 列出所有可见游戏对象 (角色、障碍物、UI元素、背景物件)
- 识别每个对象的形状、颜色、大小、首次出现时间

**Step 2: 理解 — "发生了什么"**
- 识别游戏阶段/关卡转换点
- 识别玩家交互方式 (tap/swipe/drag/joystick)
- 识别触发条件 (碰撞、时间、点击、距离)

**Step 3: 结构化 — "输出蓝图"**
- 按 V3 schema 输出 JSON
- objectRegistry: 所有物件 (shape 限定对象池可用类型)
- shotNodes: 每个阶段的 sceneObjects + triggerChain + endCondition
- 数量约束: 8-12 个 shotNodes

**输出约束：**
- `responseMimeType: 'application/json'` + `responseSchema` 强制格式
- objectRegistry 中 shape 限定: `Cube | Sphere | Cylinder | Plane | Ground | UI`
- 最后一个 shotNode 强制包含:
  - `Luna.Unity.LifeCycle.GameEnded()`
  - `Luna.Unity.Playable.InstallFullGame()`
- shotNode id 格式: `shot_0`, `shot_1`, ...

**Gemini 调用方式：**
```javascript
const file = await fileManager.uploadFile(videoPath, { mimeType: 'video/mp4' });
await waitForFileActive(file);

const result = await model.generateContent({
  contents: [{
    parts: [
      { fileData: { fileUri: file.uri, mimeType: 'video/mp4' } },
      { text: BLUEPRINT_EXTRACTION_PROMPT }
    ]
  }],
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: BLUEPRINT_SCHEMA
  }
});
```

## API 接口

```
POST /api/projects/:id/parse-video
  Content-Type: multipart/form-data
  Body: { video: File (mp4/mov/webm, max 20MB) }

  Response (SSE):
    event: status
    data: {"step": "uploading", "message": "视频上传中..."}

    event: status
    data: {"step": "preprocessing", "message": "FFmpeg 预处理..."}

    event: status
    data: {"step": "analyzing", "message": "Gemini 视频分析中..."}

    event: status
    data: {"step": "validating", "message": "蓝图校验修补..."}

    event: complete
    data: {"blueprint": {...}, "frames": ["frame_1.jpg", ...]}
```

## 文件改动清单

**新增文件（1 个）：**
- `worker/video-to-blueprint.cjs` — Gemini File API 上传 + 视频理解 + 蓝图生成，~200-300 行
  - 导出: `parseVideo(videoPath, projectId, onProgress) → blueprint JSON`

**改动文件（1 个）：**
- `server.cjs` — 新增 `POST /api/projects/:id/parse-video` 路由，~60-80 行
  - multer 接收视频 (max 20MB)
  - FFmpeg 预处理 (截断/转码/抽帧)
  - 调用 video-to-blueprint.cjs
  - SSE 流式返回

**依赖：**
- FFmpeg — 系统级，`apt install ffmpeg`（主 ECS 可能已有）
- `@google/generative-ai` — 已有，复用

**不改动：**
- worker-coder.js — 蓝图格式不变
- skeleton-generator.cjs — 照常从蓝图生成骨架
- 前端蓝图编辑器 — 格式一致，直接可编辑
- CUA 验证 — 不受影响

## 边界条件与约束

| 约束 | 值 | 处理 |
|------|-----|------|
| 文件大小 | max 20MB | multer 限制，超出返回 413 |
| 时长 | max 60s | FFmpeg 截取前 60s |
| 格式 | mp4/mov/webm | FFmpeg 统一转码为 mp4 |
| 分辨率 | 不限 | Gemini 自行处理 |
| shotNodes 数量 | 8-12 | prompt 硬约束，不足则重试 |
| objectRegistry 为空 | — | 报错，要求换视频或补充文字 |

## 失败处理

| 场景 | 策略 |
|------|------|
| Gemini JSON 输出不合法 | 重试 1 次（temperature 0.2 → 0.5） |
| Gemini 视频上传失败 | 回退关键帧模式：FFmpeg 抽 8 帧 → 图片模式逐帧分析 → 合并 |
| shotNodes < 8 | prompt 硬约束 + 重试 |
| 识别物件 < 3 | 报错，要求用户换视频或补充文字描述 |

## 不做的事情（YAGNI）

- 不做视频裁剪/编辑 UI — 用户自己裁好再传
- 不做多视频合并 — 一次一个视频
- 不做视频缓存/去重 — 分析完视频文件可删
- 不做游戏类型自动分类 — Gemini 自己判断
- 不做音频分析 — 试玩广告音效对流程理解无价值

## 成本估算

- Gemini 2.5 Pro 视频输入: ~$0.05-0.15/次
- 重试场景: 最多 2x 成本
- 回退关键帧模式: 8 帧图片 ~$0.02-0.05/次
