# Reference Clone Mode — 竞品试玩广告复刻

**Date:** 2026-03-29
**Status:** Draft
**Author:** AI + User

## Summary

新增"竞品参考"模式：用户提交竞品 playable ad 的 URL 或 HTML 文件，系统自动分析其交互流程、阶段划分、实体组成和视觉风格，生成 V4 blueprint，然后走现有 pipeline（Claude Code → 编译 → CUA 验证）产出可运行的试玩广告。

## Motivation

当前 Blueprint 项目的输入方式：
1. 手动在蓝图编辑器画节点
2. 上传 PDF/图片文档 → 分镜 → 蓝图
3. 上传游戏视频 → 蓝图（Video-to-Blueprint）

缺少一个常见场景：**参考竞品试玩广告**。广告投放团队经常拿到竞品的 playable ad（HTML 文件或在线链接），希望快速复刻类似玩法。目前只能人工拆解再手动建蓝图，效率低。

## User Flow

```
1. 用户新建项目 → 选择"竞品参考"tab
2. 粘贴 URL 或上传 HTML 文件 + 可选文字描述
3. 点击"分析并生成蓝图"
4. 系统展示 SSE 进度流：
   - 获取资源...
   - 运行截图分析...
   - 提取交互流程...
   - AI 生成蓝图...
5. 完成 → 自动跳转蓝图编辑器，用户可微调
6. 用户提交构建 → 走现有 pipeline
```

## Architecture

```
竞品 HTML/URL
     │
     ▼
┌──────────────────┐
│  reference-fetcher │  URL→Playwright抓取 / HTML→直接读取
│                    │  输出: { html, resources }
└────────┬─────────┘
         ▼
┌──────────────────┐
│ reference-analyzer │  Playwright加载运行:
│                    │  - 首屏截图
│                    │  - 自动交互探测(tap/drag/swipe)
│                    │  - 阶段切换检测(截图diff)
│                    │  - CTA检测(Install按钮)
│                    │  - 辅助静态分析(DOM/事件/资源)
│                    │  输出: { screenshots[], interactions[], entities[], cta }
└────────┬─────────┘
         ▼
┌──────────────────────┐
│ reference-to-blueprint │  截图+分析摘要 → Gemini 2.5 Pro
│                        │  输出: V4 blueprint JSON
└────────┬─────────────┘
         ▼
┌──────────────────┐
│  蓝图编辑器(现有)   │  用户微调实体/阶段/行为
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 现有构建 pipeline  │  Claude Code → Bridge.NET → CUA
└──────────────────┘
```

## Module Design

### 1. reference-fetcher.js (~150 lines)

**职责:** 获取和标准化竞品 HTML 资源

**输入:**
- `url` (string, optional) — 竞品试玩广告在线地址
- `htmlFile` (Buffer, optional) — 上传的 HTML 文件

**输出:**
```json
{
  "html": "string — 完整HTML源码",
  "htmlPath": "string — 本地文件路径",
  "metadata": {
    "title": "页面标题",
    "fileSize": 1234567,
    "hasCanvas": true,
    "framework": "cocos|pixi|phaser|unity|unknown"
  }
}
```

**实现要点:**
- URL 模式: Playwright 导航并等待加载完成, `page.content()` 获取完整 HTML
- 文件模式: 直接存储到 `server-data/uploads/ref_<projectId>.html`
- 框架检测: 正则匹配 `cc.game` (Cocos), `PIXI` (Pixi), `Phaser` (Phaser), `UnityLoader` (Unity WebGL)
- 超时 30s, 失败 fallback 到纯文件读取

### 2. reference-analyzer.js (~400 lines)

**职责:** 运行竞品广告, 截图各阶段, 提取交互流程

**输入:** `{ htmlPath, metadata }`

**输出:**
```json
{
  "screenshots": [
    { "stage": "initial", "path": "/tmp/ref_xxx_0.png", "timestamp": 0 },
    { "stage": "after_tap_1", "path": "/tmp/ref_xxx_1.png", "timestamp": 1200 },
    { "stage": "phase_2", "path": "/tmp/ref_xxx_2.png", "timestamp": 3500 },
    { "stage": "cta", "path": "/tmp/ref_xxx_3.png", "timestamp": 8000 }
  ],
  "interactionFlow": [
    { "action": "wait", "duration": 1000 },
    { "action": "tap", "x": 200, "y": 400, "result": "phase_change" },
    { "action": "drag", "from": [100,300], "to": [300,300], "result": "entity_move" }
  ],
  "detectedEntities": [
    { "type": "character", "description": "主角人物, 屏幕中央" },
    { "type": "ui_button", "description": "右下角操作按钮" }
  ],
  "ctaDetected": true,
  "totalDuration": 8000,
  "phaseCount": 3
}
```

**实现要点:**

a) **首屏截图:**
- Playwright 打开 HTML, 等待 `load` + 额外 2s
- viewport 设为 `390x844` (iPhone 14 Pro)
- 截图保存

b) **自动交互探测:**
- 在画面中心和四象限各尝试 tap, 截图对比 (pixel diff > 5% = 有效交互)
- 检测是否有引导手指动画 (常见的 tutorial hand)
- 尝试 swipe/drag 手势
- 每次有效交互后截图记录

c) **阶段切换检测:**
- 截图 diff > 30% = 新阶段
- 连续截图 diff < 1% 且持续 3s = 阶段稳定

d) **CTA 检测:**
- DOM 查询: `a[href*="store"]`, `button` 含 "Install/Download/Play Now"
- 视觉检测: 截图中出现商店图标区域

e) **静态辅助分析:**
- `document.querySelectorAll('canvas')` — canvas 数量和尺寸
- `document.querySelectorAll('img')` — 图片资源列表
- 注入 JS 拦截 `addEventListener` 调用 — 记录事件类型

f) **容错:**
- 运行超时 30s 则终止, 返回已收集的截图
- 无交互响应则标记 `interactionFailed: true`
- 页面崩溃则 fallback 到纯静态分析

### 3. reference-to-blueprint.js (~300 lines)

**职责:** 将分析结果合成 V4 blueprint

**输入:** `{ screenshots, interactionFlow, detectedEntities, userDescription, metadata }`

**输出:** V4 blueprint JSON (同现有 `convertToV4` 输出格式)

**实现要点:**

调用 Gemini 2.5 Pro (与现有 `parseAndBlueprint` 同模型), prompt 结构:

```
## 角色
你是试玩广告分析师。根据竞品广告的截图和分析数据，生成 V4 蓝图。

## 竞品分析结果
- 框架: {framework}
- 阶段数: {phaseCount}
- 总时长: {totalDuration}ms
- 交互流程: {interactionFlow}
- 检测到的实体: {detectedEntities}

## 截图
[附带 N 张阶段截图]

## 用户补充描述
{userDescription}

## 输出要求
输出标准 V4 blueprint JSON，包含:
- entities[]: 每个实体的 name, type(static/dynamic), visual, behaviors
- phases[]: 每个阶段的 activateCondition, endCondition, guide, entities
- globalSettings: camera, background, orientation

## V4 格式参考
{V4 schema example}
```

**复用:**
- Gemini API 调用逻辑复用 `server.cjs` 中 `callGemini()`
- V4 schema 验证复用 `convertToV4` 的校验逻辑
- SSE 进度推送复用 `parseStoryboard` 的模式

### 4. Frontend: ProjectList 竞品参考 Tab (~200 lines)

**位置:** `frontend/src/components/ProjectList.jsx` 新建项目弹窗

**UI:**
```
┌─ 新建项目 ──────────────────────────┐
│                                      │
│  项目名称: [________________]        │
│                                      │
│  [空白项目] [文档导入] [竞品参考]     │
│                         ^^^^ 新增    │
│                                      │
│  ┌─ 竞品参考 ──────────────────────┐ │
│  │ 竞品URL: [____________________] │ │
│  │      或                          │ │
│  │ 上传HTML: [选择文件] ref.html   │ │
│  │                                  │ │
│  │ 补充描述(可选):                  │ │
│  │ [三消游戏，3关，每关30秒____]    │ │
│  └──────────────────────────────────┘ │
│                                      │
│              [分析并生成蓝图]          │
└──────────────────────────────────────┘
```

**交互:**
- URL 和 HTML 二选一, 互斥
- 点击"分析并生成蓝图" → 创建项目 + 调用 analyze-reference
- SSE 进度展示 (同分镜解析)
- 完成后跳转蓝图编辑器

### 5. Server Endpoint (~150 lines)

**位置:** `server.cjs`

```
POST /api/projects/:id/analyze-reference
Content-Type: multipart/form-data
Body: { url?, htmlFile?, description? }
Response: SSE stream
```

**SSE 事件序列:**
```
data: {"stage":"fetching","message":"获取竞品资源..."}
data: {"stage":"analyzing","message":"运行截图分析...","progress":0.2}
data: {"stage":"analyzing","message":"探测交互流程...","progress":0.4}
data: {"stage":"analyzing","message":"提取实体信息...","progress":0.6}
data: {"stage":"generating","message":"AI生成蓝图...","progress":0.8}
data: {"stage":"done","blueprint":{...}}
```

**处理流程:**
1. 解析 multipart (busboy)
2. `referenceFetcher.fetch(url || htmlFile)`
3. `referenceAnalyzer.analyze(htmlPath, metadata)`
4. `referenceToBluprint.generate(analysisResult, description)`
5. 保存 blueprint 到项目
6. 返回完成事件

## Integration with Existing Pipeline

**复用的部分 (不需修改):**
- V4 blueprint schema 和编辑器
- Claude Code 代码生成 (`claude-code-coder.js`)
- Bridge.NET 编译验证
- CUA 自动验收 (`worker-cua-verify.js`)
- 代码审查 (`code-reviewer.js`)
- 前端蓝图编辑器和审核页

**新增的部分:**
- 3个后端模块: fetcher, analyzer, to-blueprint
- 1个前端 tab: 竞品参考输入界面
- 1个 API 端点: analyze-reference

**修改的部分:**
- `server.cjs`: 新增路由和 handler
- `ProjectList.jsx`: 新增 tab

## Risks & Mitigations

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| 混淆 JS 无法静态分析 | 高 | 低 | 以 Playwright 截图为主, 静态分析仅辅助 |
| 自动交互探测不准确 | 中 | 中 | 用户可补充描述; 蓝图可手动微调 |
| 竞品有防运行保护/DRM | 低 | 中 | fallback 纯截图+用户描述模式 |
| 生成蓝图实体映射不准 | 中 | 中 | 蓝图编辑器可人工修正后再提交 |
| Playwright 运行竞品广告崩溃 | 低 | 低 | 超时保护, fallback 静态分析 |

## Implementation Order

1. **P0 - reference-fetcher.js**: URL抓取 + HTML文件处理 (基础能力)
2. **P0 - reference-analyzer.js**: Playwright运行+截图 (核心分析)
3. **P0 - reference-to-blueprint.js**: LLM合成蓝图 (核心输出)
4. **P0 - server.cjs endpoint**: API路由 + SSE
5. **P1 - 前端 tab**: 竞品参考输入界面
6. **P2 - 自动交互探测优化**: 更智能的手势识别
7. **P2 - 框架特定解析器**: 针对 Cocos/Pixi 的专用提取逻辑

## Success Criteria

- 用户提交竞品 HTML → 5分钟内生成 V4 蓝图
- 生成的蓝图包含正确的阶段数量 (±1)
- 生成的蓝图实体类型基本准确 (>70%)
- 蓝图提交后走完整 pipeline 能产出可运行代码
- 端到端: 竞品 HTML → 可运行试玩广告 < 30分钟
