# Blueprint 生产事故记录

## 2026-04-01: 凌晨6项目全部失败

### 影响范围
6个项目全部 failed：卖水(pt2ysl)、救人泡澡(z43qrz)、子弹模具(wxfmbx)、制作子弹(1sjld8)、太空卖氧气(k0rbwx)、回收子弹(mwduot)

### 根因分析

**根因 1：CUA API 临时故障被误判为代码问题**
- 凌晨 CUA API（OpenAI computer-use-preview）返回 401/503
- luna-agent.js 静默重试 15 轮，产生空报告
- worker 把空报告判定为"代码有问题"，触发 AI 重写代码
- 实际上代码没问题，是 API 暂时不可用

**根因 2：autoPlayVerify 降级通道从未执行**
- quickPlayTest 在 headless 环境检测到 rendererCount=0（Luna 的已知假阳性）
- quickTest 失败后直接 `return { passed: false }`，跳过了所有下游逻辑
- autoPlayVerify 只存在于 luna-agent 返回报告后的分支中，quickTest 的 early return 永远到不了

**根因 3：学习系统断路 — 270条规则、40条黑屏规则，AI 完全不知道**
- pending-rules.json 积累了 270 条生产失败规则
- 但 AI 编码 prompt 里没有注入任何历史教训
- promotion 算法用关键词匹配，把 "Camera.main" 拆词后匹配失败
- 结果：同样的黑屏、Camera.main、CreatePrimitive 错误反复出现

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| API 故障早期检测 | luna-agent.js | 连续5次 API 错误提前退出，标记 `api_failure` |
| quickTest→autoPlay 降级 | worker-cua-verify.js | quickTest 失败先尝试 autoPlay 再放弃 |
| api_failure→autoPlay 降级 | worker-cua-verify.js | CUA API 不可用时自动降级 |
| 基础设施/代码区分 | linux-worker-client.js | infraFailure 不触发代码重写 |
| 指数退避重试 | server.cjs | 基础设施失败 5→80 分钟退避，最多5次 |
| 历史教训注入 | prompt-v5-basetemplate.js | top 10 跨项目规则注入 AI 编码 prompt |
| 动态规则审核 | codex-reviewer.js | promoted + pending 规则注入 Codex 审核 |
| promotion 算法重写 | code-reviewer.js | 按 rule 分类聚合替代关键词匹配 |

### 提交
- commit: `993b09d` fix: 凌晨6项目全部失败根因修复

### 后续措施
- pending-rules.json 从 270 条清理至 30 条（去重、合并同类、清理 CUA 运行时噪音）
- 建立规则定期维护机制（见 build-pipeline.md）

---

## 2026-04-01: Pipeline 模型大迁移

### 背景
原 Pipeline 大量依赖 GPT-5.4（sub.mindrix.app 中转）和 Gemini（sub.mindrix.app 中转）。
凌晨 CUA API 故障导致 6 项目全部失败（见上方事故），暴露了单点依赖风险。
决定全面替换为多模型分工方案。

### 迁移清单

| 环节 | 旧模型 | 新模型 | 文件 |
|------|--------|--------|------|
| 分镜文件→蓝图帧 | GPT-5.4 (primary) + Gemini (fallback) | **豆包 Seed 2.0 Pro** | `storyboard-parser.cjs`, `python/storyboard_parser.py` |
| 一键PDF→V4蓝图 | GPT-5.4 | **豆包 Seed 2.0 Pro** | `python/pdf_to_blueprint.py` |
| 蓝图帧→V4实体蓝图 | GPT-5.4 | **Claude Opus 4.6** (fallback: 豆包) | `python/blueprint_converter.py`, `server.cjs` |
| Spec 提取 | Gemini | **豆包 Seed 2.0 Pro** | `spec-extractor.cjs` |
| AI 编码 | Claude Opus 4.6 | 不变 | `worker/worker-coder.js` |
| 代码审核 | GPT-5.4 | **GPT-5.4** (保留) | `worker/code-reviewer.js` |
| 截图审核 | Gemini | **豆包 Seed 2.0 Pro** | `screenshot-review/screenshot-review.cjs` |
| CUA 验证 | GPT-5.4 CUA (luna-agent.js) | **PlayableAgent** (Qwen2.5-VL-72B) | `worker/worker-playableagent.js`, `server-cua-review.cjs` |
| 竞品参考→蓝图 | Gemini 2.5 Pro | **豆包 Seed 2.0 Pro** | `worker/reference-to-blueprint.js` |
| 视频分析→蓝图 | Gemini 2.5 Pro | **Gemini** (保留) | `worker/video-to-blueprint.cjs` |
| API 健康检查 | ping GPT-5.4 + Gemini | **Claude + 豆包 + Gemini** | `server.cjs` |

### PlayableAgent 替换 CUA 详细说明
- 旧方案：`luna-agent.js` 调 GPT-5.4 CUA (computer-use-preview) 操控浏览器
  - 依赖 `OPENAI_API_KEY` + 代理，凌晨 401/503 导致全线失败
- 新方案：`worker-playableagent.js` 调 `blueprint_verify.py` (Python 3.8)
  - VLM 截图分析 (Qwen2.5-VL-72B via SiliconFlow) + `__gameState` API 读取 Phase 进度
  - Xvfb + Playwright 非 headless 模式渲染 WebGL
  - 同接口: `runCUAVerification(buildDir, blueprint, taskId, log) → {passed, issues, report}`
  - 三个入口全部替换: `worker-client.js`, `linux-worker-client.js`, `server-cua-review.cjs`

### 备份文件
- `python/storyboard_parser.py.bak.gpt54`
- `python/blueprint_converter.py.bak.gpt54`
- `python/pdf_to_blueprint.py.bak.gpt54`
- `storyboard-parser.cjs.bak.gemini`
- `spec-extractor.cjs.bak.gemini`
- `screenshot-review/screenshot-review.cjs.bak.gemini`
- `worker/code-reviewer.js.bak.claude`
- `worker/luna-agent.js.bak.gemini`

### 影响
- GPT-5.4 仅保留：代码审核 (`code-reviewer.js`) + 图片生成 (`gpt-image-1`)
- Gemini 仅保留：视频分析 (`video-to-blueprint.cjs`)
- 豆包成为分镜解析/Spec/截图审核/竞品参考的主力
- Claude 成为编码/蓝图转换的主力
- PlayableAgent 完全替代 CUA，消除 OpenAI CUA API 单点依赖

---

## 2026-04-02: Luna 7.1.0 升级后黑屏 — 双重根因修复

### 背景
从 Luna 6.4.0 升级到 7.1.0，同时将 90 个无颜色池对象替换为 160 个预烘焙颜色池对象。
升级后所有构建产出均为黑屏。

### 根因分析

**根因 1：Bridge.NET 类重复定义**
- Luna 7.1.0 的 stage4 模板 engine/scripts.js 已包含 stub `Bridge.define("GameFlowManagerMain", {Start:function(){},Update:function(){}})`
- 构建时将用户编译的 JS 直接拼接到引擎末尾，再次 `Bridge.define("GameFlowManagerMain", ...)`
- Bridge.NET 运行时检测到重复类定义，抛出 `"Class 'GameFlowManagerMain' is already defined"` 异常
- 异常为 Promise rejection，无明显堆栈，表现为静默黑屏

**根因 2：引擎 loadSettings 空指针崩溃**
- 7 个 `loadSettings` 函数（loadSortingLayerSettings 等）直接访问 `e[te.sortingLayers].length`
- 当项目设置数据缺失时，返回 null，导致空指针崩溃
- 表现为引擎初始化阶段崩溃 → 黑屏

### 排查过程
1. 初始怀疑：`convertToSingleHTML` 的 XHR 拦截器不兼容新引擎 → 排除（cache/*.js 是非必要文件）
2. 尝试用旧引擎 + 新 bundle → 不兼容（Deserializers 格式不匹配）
3. 搭建 CDP（Chrome DevTools Protocol）调试环境，捕获运行时异常
4. 定位到 exception at line 304 col 258789 → Bridge.NET class registration throw
5. 确认 `Bridge.define("GameFlowManagerMain")` 在引擎中出现 2 次

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| stub 类剥离 | `worker/linux-bridge-build.js` | `assembleStage4()` 拼接前用正则去除模板中的 stub GameFlowManagerMain |
| 引擎 null guards | `/opt/luna/stage4-template/engine/scripts.js` | 7 个 loadSettings 函数添加 `if(!n)return;` |

### 验证结果
- 173 个实体全部加载，160 个池对象确认存在
- 0 个 JS 异常
- 截图中确认 Red/Blue/Green/Yellow/Purple 颜色正确渲染
- 构建耗时 6 秒，HTML 7MB

### 提交
- blueprint: `08faf21` fix: strip stub GameFlowManagerMain from engine to prevent class redefinition crash
- luna-base-template: `9b89483` fix: add patched stage4 engine with null guards for loadSettings functions

### 教训
1. **拼接引擎 + 用户代码时，必须检查命名冲突** — 模板引擎已有 stub 类，用户代码再定义同名类会崩溃
2. **Promise rejection 在 headless Chrome 中几乎不可见** — 需要通过 CDP `Runtime.exceptionThrown` 才能捕获
3. **Luna 7.1.0 单文件格式的 cache/*.js 是非必要文件** — 它们引用 `decompressArrayBuffer` 等未定义函数，说明不应被加载
4. **headless Chrome 需要 20+ 秒才能完成 6MB JS 引擎的解析和执行** — 不要因为前 10 秒无响应就认为加载失败
