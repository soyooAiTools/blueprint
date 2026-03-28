# Video-to-Blueprint Design Spec

> 从游戏视频中提取流程逻辑，直接生成蓝图 JSON（nodes + edges + objectRegistry），跳过分镜确认步骤。

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
│          - @google/genai File API 上传视频           │
│          - 通过 Gemini relay proxy 上传              │
│          - 轮询 file.state === "ACTIVE"              │
│          - Prompt 三步引导 → 输出蓝图 JSON            │
│          - responseSchema 强制 JSON 格式             │
│  Step 3: 校验 + 修补                                 │
│          - objectRegistry 物件名去重                  │
│          - shape 限定 Cube|Sphere|Cylinder|Ground|UI │
│          - shotNode 类型节点数量 8-12 个              │
│          - 最后一个 shotNode 强制注入 CTA             │
│          - 节点 id 格式 shot_0, shot_1...            │
│          - 自动生成节点 position (x: 300*i, y: 200)  │
│          - 自动生成 edges 连接相邻节点               │
│  Output: 完整 blueprint JSON                         │
│          { nodes, edges, objectRegistry }             │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
        现有构建流水线 (parseBlueprintToPrompt → AI编码 → 构建 → CUA)
```

**与现有流程的关系：**
```
现有入口:  文案/PDF → parse-storyboard → 分镜编辑 → 蓝图编辑 → 提交
新增入口:  视频     → parse-video      →          蓝图编辑 → 提交
                                         (跳过分镜)
```

两条路最终汇入同一个蓝图编辑器和 V3 构建流水线（`parseBlueprintToPrompt` 路径）。

## 蓝图输出格式

输出为 V3 图结构格式（nodes + edges），与现有蓝图编辑器和 `parseBlueprintToPrompt` 完全兼容：

```json
{
  "objectRegistry": [
    {
      "name": "Player",
      "shape": "Cube",
      "scale": [1, 2, 1],
      "color": "blue",
      "rgb": "#0000FF",
      "initiallyVisible": true,
      "firstStep": 0
    }
  ],
  "nodes": [
    {
      "id": "shot_0",
      "type": "shotNode",
      "position": { "x": 0, "y": 200 },
      "data": {
        "label": "Opening",
        "description": "Player enters the scene",
        "sceneObjects": [
          {
            "name": "Player",
            "position": [0, 1, 0],
            "visible": true,
            "actions": ["idle"]
          }
        ],
        "inputType": "none",
        "triggerChain": [
          {
            "event": "start",
            "actions": [
              { "type": "show", "target": "Player" }
            ]
          }
        ],
        "endCondition": {
          "type": "time",
          "value": 3,
          "description": "Wait 3 seconds"
        }
      }
    }
  ],
  "edges": [
    { "id": "e_0_1", "source": "shot_0", "target": "shot_1" }
  ]
}
```

**关键约束：**
- nodes 中 `type: 'shotNode'` 的节点数量: 8-12 个
- 最后一个 shotNode 的 triggerChain 必须包含 `GameEnded()` + `InstallFullGame()`
- objectRegistry shape 限定: `Cube | Sphere | Cylinder | Ground | UI`（对齐 V4 schema 和对象池）
- edges 按顺序连接相邻 shotNode
- position 自动生成，便于编辑器布局

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
- 按 nodes + edges + objectRegistry 格式输出 JSON
- objectRegistry: 所有物件 (shape 限定对象池可用类型)
- 每个 shotNode: data 中包含 sceneObjects + triggerChain + endCondition
- 数量约束: 8-12 个 shotNode 节点

**Gemini 调用方式（使用 @google/genai SDK，通过 relay proxy）：**
```javascript
const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GEMINI_API_KEY,
  httpOptions: { baseUrl: process.env.GOOGLE_GEMINI_BASE_URL }
});

// 上传视频 (File API)
const uploaded = await ai.files.upload({
  file: videoPath,
  config: { mimeType: 'video/mp4' }
});

// 轮询等待处理完成
let file = uploaded;
while (file.state === 'PROCESSING') {
  await new Promise(r => setTimeout(r, 2000));
  file = await ai.files.get({ name: file.name });
}
if (file.state !== 'ACTIVE') throw new Error('Video upload failed: ' + file.state);

// 视频理解 + 蓝图生成
const result = await ai.models.generateContent({
  model: 'gemini-2.5-pro',
  contents: [{
    parts: [
      { fileData: { fileUri: file.uri, mimeType: 'video/mp4' } },
      { text: BLUEPRINT_EXTRACTION_PROMPT }
    ]
  }],
  config: {
    responseMimeType: 'application/json',
    responseSchema: BLUEPRINT_SCHEMA
  }
});
```

**注意：** 必须使用 `GOOGLE_GEMINI_BASE_URL`（relay proxy），与 `storyboard-parser.cjs` 和 `spec-extractor.cjs` 一致。需确认 relay 支持 20MB 视频上传。

## API 接口

```
POST /api/projects/:id/parse-video
  Content-Type: multipart/form-data
  Body: { video: File (mp4/mov/webm, max 20MB) }

  Response (SSE, 与 parse-storyboard 格式一致):
    data: {"type": "progress", "percent": 10, "stage": "视频上传中..."}
    data: {"type": "progress", "percent": 30, "stage": "FFmpeg 预处理..."}
    data: {"type": "progress", "percent": 50, "stage": "Gemini 视频分析中..."}
    data: {"type": "progress", "percent": 80, "stage": "蓝图校验修补..."}
    data: {"type": "done", "data": {"blueprint": {...}, "frames": ["frame_1.jpg", ...]}}
```

SSE 格式对齐现有 `parseStoryboard` 端点的 `{type, percent, stage}` 模式，前端可复用现有进度组件。

## 文件改动清单

**新增文件（1 个）：**
- `worker/video-to-blueprint.cjs` — Gemini File API 上传 + 视频理解 + 蓝图生成，~200-300 行
  - 导出: `parseVideo(videoPath, projectId, onProgress) → blueprint JSON`

**改动文件（1 个）：**
- `server.cjs` — 新增 `POST /api/projects/:id/parse-video` 路由，~60-80 行
  - busboy 接收视频 (max 20MB)，与现有 parseStoryboard 上传模式一致
  - FFmpeg 预处理 (截断/转码/抽帧)
  - 调用 video-to-blueprint.cjs
  - SSE 流式返回

**依赖：**
- FFmpeg — 系统级，`apt install ffmpeg`（主 ECS 可能已有）
- `@google/genai` — 已有，复用（storyboard-parser.cjs 同款）

**不改动：**
- worker-coder.js — 蓝图格式不变，走 V3 `parseBlueprintToPrompt` 路径
- skeleton-generator.cjs — 照常从蓝图生成骨架
- 前端蓝图编辑器 — nodes/edges 格式一致，直接可编辑
- CUA 验证 — 不受影响

## 边界条件与约束

| 约束 | 值 | 处理 |
|------|-----|------|
| 文件大小 | max 20MB | busboy 限制，超出返回 413 |
| 时长 | max 60s | FFmpeg 截取前 60s |
| 格式 | mp4/mov/webm | FFmpeg 统一转码为 mp4 |
| 分辨率 | 不限 | Gemini 自行处理 |
| shotNode 节点数量 | 8-12 | prompt 硬约束，不足则重试 |
| objectRegistry 为空 | — | 报错，要求换视频或补充文字 |

## 失败处理

| 场景 | 策略 |
|------|------|
| Gemini JSON 输出不合法 | 重试 1 次（temperature 0.2 → 0.5） |
| Gemini 视频上传失败 | 返回错误，要求用户重试或换视频 |
| shotNode 节点 < 8 | prompt 硬约束 + 重试 1 次 |
| 识别物件 < 3 | 报错，要求用户换视频或补充文字描述 |

## 不做的事情（YAGNI）

- 不做视频裁剪/编辑 UI — 用户自己裁好再传
- 不做多视频合并 — 一次一个视频
- 不做视频缓存/去重 — 分析完视频文件可删
- 不做游戏类型自动分类 — Gemini 自己判断
- 不做音频分析 — 试玩广告音效对流程理解无价值
- 不做关键帧回退模式 — 上传失败直接报错，保持简单

## 成本估算

- Gemini 2.5 Pro 视频输入: ~$0.05-0.15/次
- 重试场景: 最多 2x 成本
