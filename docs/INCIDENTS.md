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

---

## 2026-04-02: BUG-0012 磁盘满致项目丢失 + AI编码只实现3/11 phase

### 影响范围
6个项目全部不可见或失败：
- 项目列表 API 返回 500（看起来"任务丢失"）
- 3个项目 failed: 制作子弹(stub代码)、卖水(phase-skipped)、子弹模具(phase-skipped)
- 3个项目 stuck: 救人泡澡、太空卖氧气、回收子弹（ENOSPC后卡死）

### 根因分析

**根因 1：ENOSPC 导致 JSON 写入截断**
- 磁盘 93% 满，worker 写项目 JSON 时空间耗尽，文件被截断为非法 JSON
- `listProjects()` 用 `files.map(JSON.parse)`，一个文件解析失败整个 API 返回 500
- 用户看到的是"任务全部丢失"

**根因 2：Skeleton 只生成前 3 个 phase**
- `MAX_INITIAL_PHASES = 3` 限制骨架只覆盖 3/11 phase
- AI 在 `$5` budget 内来不及读完大 prompt 就耗尽预算，产出 9 行 stub 代码
- 即使代码生成成功，也只实现 3 个 phase，CUA 检测到 game_ended 后 phase-skipped

**根因 3：CUA 反馈未有效传递给 AI**
- 增量修复 prompt 写"请阅读 prompt.md 了解反馈"，但 AI 不一定会读
- 4 轮修复产出完全相同的代码（卖水 507 行，子弹模具 525 行，字节级相同）

**根因 4：Codex 审核失败后继续构建**
- Codex 连续 3 轮检测到 critical issues，但 pipeline 仍继续到 CUA
- 浪费 CUA 资源验证已知有严重问题的代码

**根因 5：FULL_GENERATION 切换时清空所有上下文**
- 连续 2 轮同一问题时切换全量重生成，但 `feedbackHistory = []` 清空了失败原因
- AI 没有任何线索知道之前为什么失败，产出相同代码

### 修复方案

| # | 修复项 | 文件 | 改动 |
|---|--------|------|------|
| 1 | listProjects 单文件容错 | `server.cjs` | map→forEach+try/catch，跳过损坏文件 |
| 2 | Budget 取消上限 | `worker/claude-code-coder.js` | `--max-budget-usd` 默认 0（不传），不再限制 |
| 3 | Skeleton 覆盖全部 phase | `worker/claude-code-coder.js` | 移除 `MAX_INITIAL_PHASES=3`，所有 phase 生成骨架 |
| 4 | Codex 审核失败阻断构建 | `worker/linux-worker-client.js` | criticalCount>0 时 return failed，不继续到 CUA |
| 5 | CUA 反馈直接注入 prompt | `worker/claude-code-coder.js` | 反馈文本直接写进 userPrompt，不依赖 AI 读 prompt.md |
| 6 | FULL_GENERATION 携带原因 | `worker/linux-worker-client.js` | 保留失败摘要+明确指令，避免产出相同代码 |

### 提交
- commit: `4f0f976` fix: 流水线5项关键修复

### 教训
1. **写文件必须有原子性保障** — JSON 写入被截断是致命的，应该 write-to-temp + rename
2. **API 容错是底线** — 单个数据文件损坏不应导致整个列表接口不可用
3. **Skeleton 限制 3 phase 是错误的优化** — 省下的 token 不值得丢失 8 个 phase 的代价
4. **$5 预算对复杂蓝图不够** — 29KB prompt + 多文件读取就耗尽预算，AI 还没开始写代码
5. **反馈必须直接注入 prompt** — 不能假设 AI 会主动去读某个文件
6. **重生成必须携带失败原因** — 否则 AI 没有任何信号避免重复同样的错误

---

## 2026-04-03: V3 代码清除 + 三项关键 Bug 修复

### 背景
4月2日重新提交6个项目后全部再次失败，深度排查发现3个根因。

### 根因分析

**根因 1：Claude Code CLI 秒退被误判为成功**
- `claude-code-coder.js` 在调用 Claude 前预写 skeleton 到 .cs 文件
- Claude 退出后检查**文件是否存在**来判断成功 → skeleton 永远存在 → 永远 "partial success"
- 结果：未修改的 skeleton（满是 `true /* TODO */` 占位符）被当作有效代码
- 游戏所有 phase 瞬间触发 → 3秒结束 → phase-skipped

**根因 2：Doubao API TLS 断连导致 spec 截断**
- mihomo (clash-meta) 运行在 `global` 模式，所有流量走海外代理
- Doubao (volces.com) 是国内服务，海外节点 TLS 握手失败 (SSL_ERROR_SYSCALL)
- spec-extractor 只提取出 1/11 个 spec，skeleton 只有 210 行
- 配置中已有 `DOMAIN-SUFFIX,volces.com,DIRECT` 规则，但 global 模式下被忽略

**根因 3：V3 蓝图格式兼容性 Bug**
- `linux-worker-client.js` 只检查 `blueprint.nodes.length`
- V4 蓝图使用 `entities[]` 而非 `nodes[]` → 4个项目被误判为空蓝图
- 下游 `worker-coder.js` 已有 V4 支持但永远执行不到

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| 骨架误判修复 | `claude-code-coder.js` | 检查文件 mtime 是否变化，而非是否存在 |
| CLI 秒退检测 | `claude-code-coder.js` | exit code≠0 + <10s + stdout<200字符 → 直接失败 |
| Spec 截断重试 | `spec-extractor.cjs` | specs 数量 < 50% frames 时自动重试（最多3次） |
| Clash 路由修复 | mihomo config | global → rule 模式，TUN 保持开启，volces.com 走直连 |
| **V3 代码全面清除** | 多文件 | 删除 ~1400 行 V3 代码，仅保留 V4 entity-driven 路径 |

### V3 清除详情

**删除的 V3 代码路径：**
- `worker-coder.js`: 删除 `parseBlueprintToPrompt`、`parseBlueprintToLegacyScenes`、V3 生成路径、`verifyCodeContent` (~1383 行)
- `server.cjs`: shotCount → entityCount/phaseCount，删除 objectRegistry/globalParams
- `linux-worker-client.js`: V3 nodes 检查 → V4 entities only
- `prompt-v4.js` / `prompt-v5-basetemplate.js`: V3 nodes fallback → 无 phases 时报错
- `worker-playableagent.js`: V3 phaseNode fallback → 要求 specs 文件

**归档到 `_deprecated_v3/`：**
- `upload-v4.cjs`、`server-utf8.cjs`、`scripts/submit-blueprint.cjs`、`scripts/frames-to-blueprint.cjs`

### 后续
- V3 格式不再支持，所有项目必须使用 V4 entity-driven 蓝图

---

## 2026-04-08: Gemini清理 + LLM链路修复 + Worker心跳/认证修复

### 影响范围
全部pipeline任务（64次历史运行0%成功率），3个在跑任务反复失败

### 根因分析

**根因 1：Worker heartbeat 始终上报 idle（linux-worker-client.js:569）**
- heartbeat 固定发 `status: 'idle'`, 无 `currentTask` 字段
- watchdog `reclaimStale(300, 180)` 5分钟后判定 desync → 强制回收正在跑的任务
- 级联效应：任务在 worker 间弹来弹去 → Claude slot lock 泄漏 → API 限流

**根因 2：Claude CLI 认证失败（claude-code-coder.js:317）**
- env 覆盖 `ANTHROPIC_API_KEY` 为 GLM key + `CLAUDE_CODE_SIMPLE: '1'` 禁用 OAuth
- 系统实际用 OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`)，不是 API key
- Claude CLI 2秒退出 exit code 1

**根因 3：Spec提取失败 — Gemini key过期 + DoubaoProvider格式错误**
- spec-extractor 硬编码 `createProvider('gemini', {})`，Gemini API key 已过期
- 改为Doubao后发现 DoubaoProvider 将 prompt 字符串直接传给 adapter
- adapter 的 `for (const c of contents)` 对字符串逐字符迭代，产生垃圾消息
- system prompt (`{system, user}` 格式) 被丢弃，temperature/maxTokens 未传递

**根因 4：dotenv 路径错误（linux-worker-client.js:15）**
- `__dirname + '/.env'` 指向 `worker/.env`（不存在）
- 实际 .env 在 `../`，导致 `DOUBAO_API_KEY` 为空

**根因 5：Slot lock 清理不完整（claude-code-coder.js:44）**
- 只靠 25min mtime 超时，不检测持锁进程是否存活
- worker crash 后 lock 残留，占位直到超时

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| heartbeat上报busy+taskId | linux-worker-client.js | activeTasks>0时报busy |
| Claude CLI OAuth认证 | claude-code-coder.js | 移除env覆盖,用OAuth |
| 去除Gemini依赖 | model-provider.cjs | 删除GeminiProvider,chain改为Doubao→Claude |
| spec-extractor直连Doubao | spec-extractor.cjs | createProvider('doubao') |
| DoubaoProvider格式修复 | model-provider.cjs | prompt→[{role,parts}],传system/temp/maxTokens |
| dotenv路径修复 | linux-worker-client.js | __dirname+'/.env' → '../.env' |
| PID存活检测 | claude-code-coder.js | process.kill(pid,0)检测死进程 |
| Gemini变量名清理 | storyboard-parser.cjs, doubao-adapter.cjs | _geminiKey→_doubaoKey等 |
| ecosystem清理 | ecosystem.config.cjs | 移除GEMINI_*环境变量 |

### 验证结果
- Spec提取：3个任务全部成功提取11个phase specs（之前100%失败）
- Claude CLI：Opus 4.6成功启动codegen（之前2秒退出）
- Heartbeat：worker正确上报busy+taskId（之前被watchdog反复抢任务）

### 教训
1. 变量命名应与实际服务一致，_geminiKey 实际是 Doubao key 造成长期混淆
2. dotenv path 用 `__dirname` 时需注意 worker 子目录 vs 项目根目录
3. LLM adapter 层必须有格式校验，字符串 vs 数组语义差异导致静默失败
4. heartbeat 是 watchdog 的唯一信号源，错误上报会级联放大为全系统故障
- `video-to-blueprint.cjs` 仍输出 V3 格式，需后续迁移至 V4
