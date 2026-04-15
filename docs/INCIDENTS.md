# Blueprint 生产事故记录

## 2026-04-15 16:40: Port-Guard 把 PM2 God Daemon 当端口占用者 SIGTERM 之 — 4 分钟全站下线

### 影响范围
`pm2 reload blueprint-editor` 触发级联下线: blueprint-editor + linux-worker-1 + linux-worker-2 三个 apps 同时 `Deleting process`, PM2 daemon 自身优雅退出。nginx 反代 `3901` 无后端 → 外部访问 `playcools.top/webgl/*` 全部 404/502, 持续 4 分钟 (16:40:32 ~ 16:44:54) 直到 `pm2 resurrect`。期间 CUA 太空捡垃圾任务 (bqh33t) 被 SIGINT 中断, 好在 2026-04-09 的 checkpoint 修复救了场, 恢复后继续跑。

### 根因
**`lib/port-guard.cjs` 与 PM2 cluster 模式的致命冲突**。

`server.cjs` 启动时调用 `killPortOccupier(3901)`, port-guard 用 `ss -tlnp sport = :3901` 找占用者 → SIGTERM。这在「手动 `node server.cjs` 忘了 kill 再启动」场景下是对的, 但 **PM2 cluster 模式下监听 socket 不是 worker 进程持有的**, 而是 PM2 God Daemon 自己持有再分发给 cluster workers:

```
ss -tlnp
LISTEN 0 511 *:3901 users:(("PM2 v6.0.14: Go",pid=2349527,fd=3))
```

所以新 cluster worker 启动时:
1. port-guard 查 3901 → 看到 PID 2349527
2. `process.kill(2349527, 'SIGTERM')` → **自杀 PM2 God Daemon**
3. Daemon 优雅退出 → 杀掉所有 managed apps

只要 cluster 模式 + port-guard 同时存在, 每次 `pm2 reload` (甚至 `pm2 restart`) 都会触发这个 bug。原先的 `feedback_pm2_reload_cascade.md` 错把根因归咎于 `pm2 reload` 语义, 实际上跟 reload/restart 无关 —— 是 port-guard 在 cluster 模式下根本不该运行。

### 修复方案 (双重防护)
| # | Fix | 文件 | 改动 |
|---|-----|------|------|
| 1 | PM2 下跳过 port-guard | `server.cjs` | `if (!process.env.pm_id) { killPortOccupier(PORT); }` — `pm_id` 是 PM2 注入的环境变量, 存在即 run under PM2, PM2 自己会处理端口移交 |
| 2 | 识别 PM2 拒绝杀 | `lib/port-guard.cjs` | 读 `/proc/<pid>/comm`, 正则匹配 `^PM2\b` 或 `God\s*Daemon` 则 return 不杀 — 防御纵深, 即使未来别的代码路径调用 killPortOccupier 也不会误杀 |

### 陷阱 / 教训
1. **cluster 模式的 app 不要跑 port-guard/lsof-kill/fuser-k 类逻辑** —— 监听 socket 是 God Daemon 持有的, 杀它就是自杀 daemon → 杀所有 apps
2. **fork 模式 worker 反而安全** —— linux-worker-1/2 是 fork 模式 (不监听端口), port-guard 不影响它们
3. **判断是否 run under PM2** 用 `process.env.pm_id` (或 `NODE_APP_INSTANCE`)
4. **诊断「pm2 突然全挂」** 第一时间看 `/root/.pm2/pm2.log` 有没有 `pm2 has been killed by signal` —— 正常 reload 不会出现, 只有外部 SIGINT/SIGTERM 到 daemon 才会

### 提交
- commit: `aae59bb` fix: port-guard SIGTERM PM2 God Daemon 致 4 分钟级联下线

---

## 2026-04-15: 3 任务无限烧钱 + Dashboard 状态停滞 (6 项 fix-loop 修复 + 5 项 dashboard 修复)

### 影响范围
3 个任务 (bqh33t, dmda29, yjrgmn) 连续运行 >2 小时未退出,每个任务烧掉预估 >50 美元 token; 与此同时 dashboard 首屏加载 ~10 秒、workers 永远显示 0/3 online、cancelled 状态永远不同步到项目 JSON — 运维侧完全看不到真实状态无法介入,形成"跑飞+瞎眼"复合故障。

### 根因分析

**根因 1: fix-loop `beforeRoundFn` 未 await, 导致 round 计数与实际执行错位**
- `engine/fix-loop.cjs` 的 retry hook 通过 fire-and-forget 调用,`round++` 继续而副作用还在 pending
- cua-verify 的 claude-code 生成在第 N 轮还在执行时,日志里已经是第 N+1 轮,circuit breaker 用 round 计数永远触发不到
- 表象: 3 任务都看到 "CUA round X failed, AI re-coding..." 循环但无退出

**根因 2: 同 CODE error 反复出现但从无熔断**
- fix-loop 只对连续 round 无进展做检查,同一条错误 A->B->A->B 振荡时每次都 reset counter
- `visual-check` 的 "Could not parse analysis response" 错误重复 3 轮后仍继续 recode,每轮 ~7 分钟
- 同理 `compile.cjs` 的 same-error exit 原本用"连续匹配",A->B->A->B 也能逃过

**根因 3: CUA visual_freeze 被错误分类为 CODE 继续重试**
- error-classifier 的 `CUA_FATAL_PATTERNS` 只有 `CUA total time limit`,visual_freeze 没进 FATAL
- 画面冻结通常是 Camera/Canvas/初始化问题,claude-code incremental-fix 根本改不动
- 每轮烧 $5-10 的 claude-code 调用,跑满 10 round 纯浪费

**根因 4: 手动 cancel 无法传到 worker, pipeline 继续烧钱**
- 无论从 dashboard 点 cancel 还是改 task status,worker 端完全没有机制感知
- 只能等 worker 任务跑完(或崩溃)才会停下

**根因 5: Watchdog reclaimStale 无限循环没有 retry counter**
- 任务被 watchdog reclaim 后回到 pending,下一个 worker 拿到后又走 processing,又超时又被 reclaim
- 无 `infra_retry_count` 限制 → 永远不会走到 permanent_fail
- 配合根因 1/2/3 形成复利,3 任务反复消耗 token 预算

**根因 6: Watchdog 抢任务 — worker 刚启动就被抢走 checkpoint**
- worker 重启后在 recover checkpoint(需要几秒到几十秒),watchdog 一轮是 120s
- 如果 worker 启动时刻正好临近 watchdog cycle,会在 checkpoint 还没稳定时被当成 stale reclaim
- 表象: bqh33t 在 worker-1 重启后立刻被 watchdog 判定 stale 放回 pending

**根因 7 (dashboard): workers 永远 offline — UTC 时区 bug**
- `lib/task-queue.cjs` stats() 的 `new Date(last_seen)` 没有 `'Z'` 后缀
- SQLite 存 UTC 但 JS 按本地时间 (CST) 解析,差 8h
- `(now - heartbeat) < 90s` 永远 false,所有 worker 显示 offline,online=0

**根因 8 (dashboard): 首屏加载 ~10 秒**
- `/api/dashboard/api-health` 每次请求同步 ping Doubao (~5.5s) + Claude (~0.4s)
- 前端 dashboard mount 时调用,阻塞首屏渲染
- 没有缓存、没有并发去重

**根因 9 (dashboard): 状态机 cancelled 完全缺失**
- `lib/state-machine.cjs` PROJECT_TRANSITIONS 根本没有 cancelled 条目,大部分非终态也没有 `→ cancelled` 转出
- `forceTransition` 对无效转换只 warn 不抛,但 cancelled 项目的 status 永远停留在 processing/failed
- 配合 F14-desync 缺失,UI 上看不到任何 cancelled 项目

**根因 10 (dashboard): Phase 2 F14-desync 只覆盖 3 个 case**
- `api/dashboard.cjs` runWatchdogCycle 的 desync 检测是硬编码的 3 个分支
- cancelled/done/cua_passed 都没覆盖,task 已经结束但项目文件还是 processing/failed
- 没有扫描 cancelled tasks → 手动 cancel 后永远不同步

**根因 11 (日志污染): Worker 每次 fix round 都触发 "Invalid transition: processing → processing"**
- `api/worker.cjs` workerStatus 每次收到 worker 汇报都 `projectSM.forceTransition`
- 没有 no-op/regression guard,相同状态/退化转换全部打印 warn
- 日志被刷屏,真正的问题被掩盖

### 修复方案

| # | Fix | 文件 | 改动 |
|---|-----|------|------|
| A | retry counter | `lib/task-queue.cjs` | `reclaimStale()` 给每次 reclaim 累加 `infra_retry_count`,超过 5 次直接 permanent_fail |
| B | uptime grace | `lib/task-queue.cjs` | worker uptime <180s 的不抢任务 (让刚重启的 worker 稳定 checkpoint) |
| C | beforeRoundFn await | `engine/fix-loop.cjs` | hook 改成 Promise.resolve().then().catch(),确保下一 round 拿到完成的状态 |
| D | 同 CODE 错误熔断 | `engine/fix-loop.cjs` | 签名前 120 字符匹配,连续 3 轮同一错误 → 抛 `FIX_LOOP_CIRCUIT_BREAKER` |
| D' | 同 build 错误计总数 | `engine/stages/compile.cjs` | `errSigCounts` 按签名累计 (不是连续),A->B->A->B 振荡也能触发 |
| E1 | visual_freeze → FATAL | `engine/error-classifier.cjs` | `CUA_FATAL_PATTERNS` 加 `/Visual freeze FATAL/i` |
| E2 | visual_freeze 3 轮熔断 | `engine/stages/cua-verify.cjs` | `stuckDiagnosis.rootCause === 'visual_freeze'` 且 `_noProgressRounds >= 3` 直接 throw |
| F1 | status/cancel 端点 | `api/worker.cjs` `api/router.cjs` | 新增 `GET /api/tasks/:id/status` + `POST /api/tasks/:id/cancel` |
| F2 | worker poller | `worker/linux-worker-client.js` | processTask 起 30s 间隔 `checkTaskCancelled`,检测到 cancelled 置 `ctx._cancelled` |
| F3 | pipeline unwind | `engine/pipeline.cjs` | `runNext()` 开头检查 `ctx._cancelled` 抛 `TaskCancelledError`; tryExecute.catch 放行不重试 |
| F4 | worker catch 识别 | `worker/linux-worker-client.js` | 外层 catch 见 `TaskCancelledError` → 清 checkpoint + 静默 return, 不 `reportStatus('failed')` |
| G | UTC 时区 fix | `lib/task-queue.cjs` | `new Date(workers[j].last_seen + 'Z')` 强制按 UTC 解析 |
| H | api-health 缓存 | `api/dashboard.cjs` | 模块级 `apiHealthCache` + 启动 prime + `setInterval(refresh, 30s)`; 请求路径只读缓存 |
| I | 状态机补 cancelled | `lib/state-machine.cjs` | 所有非终态 PROJECT/TASK TRANSITIONS 加 `→ cancelled`; 终态加 `cancelled: []` |
| J | F14-desync 扩展 | `api/dashboard.cjs` | `TASK_TO_PROJECT` 映射表覆盖所有 task status (target + compatible[]); 额外扫 `taskQueue.list('cancelled')` 立即同步 |
| K | no-op/regression 抑制 | `api/worker.cjs` | `workerStatus` 在 forceTransition 前检查 `isNoop` 和 `isRegression` (building→processing 等),跳过不打印 |
| L | uptime 进 heartbeat | `worker/linux-worker-client.js` | heartbeat payload 加 `uptime: (Date.now() - WORKER_START_TIME)/1000`,配合 Fix B |

### 陷阱 / 教训
1. **`var { projectSM } = require(...)` 写进 docblock** — 编辑文件头部时,require 不小心插到 `/** ... */` 之间,`node -c` 通过但运行时 `ReferenceError: projectSM is not defined`,F14-desync 首次触发整个 watchdog 崩溃一整轮。教训: 追加顶部 require 必须以 `*/` 之后的行为锚点。
2. **ScheduleWakeup 无法取代监督闭环** — 没有 dashboard + F14-desync + cancel 机制,"跑飞任务"完全不可见。任何长期 pipeline 必须有外部杀开关,不能只靠内部 circuit breaker。
3. **UTC vs local time** — SQLite `datetime('now')` 存 UTC (无后缀),JS `new Date(x)` 对无后缀字符串按本地时间解析,差 8h。这个 bug 可以潜伏数月,只要整个链路都在本地读写就不暴露,一旦跨 timezone 比较就全线翻车。
4. **fix-loop 的 fire-and-forget hook** — JS 的 async 没有强制 await,代码看起来能跑,但 round 计数和实际执行会错位。所有 hook 必须返回 Promise 且被 await。
5. **docblock 内的 require 陷阱** — 见 `~/.claude/projects/-root/memory/feedback_require_in_docblock.md`。

### 提交
- commit: `86a1469` fix: 3 任务无限烧钱 + dashboard 瞎眼 — fix-loop/状态机/desync 12 项修复
- commit: `ad6a2ee` feat: dashboard 4-API 健康展示 + Claude /v1/v1 URL bug + GPT-5.4 preflight 原因细化

### 验证结果
- Watchdog Run #1 (post fix): 检出 yjrgmn + dmda29 两个 "失败但 task=cancelled" desync,两条 fix 执行成功,项目文件写入 `status=cancelled`
- `/api/dashboard/api-health` 延迟: 6-10s → 5ms
- Workers online 显示: 0/3 → 2/3 (真实在线的)
- bqh33t 继续在 worker-2 checkpoint 恢复跑,未被本次重启打扰 (只重启了 blueprint-editor + idle 的 worker-1)
- 无 "Invalid transition" 日志

---

## 2026-04-14: 3 worker 全线 compile 失败级联 (5 根因 + 1 环境修复)

### 影响范围
3 个 worker 所有 compile 任务 ECONNRESET / csCode required / ENOENT iframe.html / codegen 同步崩溃。持续近 1 小时才完整定位,每次修一层又出下一层。

### 根因分析

**根因 1:双 .env 路径不匹配,LINUX_BUILD_URL 静默 fallback 到僵尸远端**
- `linux-worker-client.js:15` dotenv 加载 `__dirname/../.env` → **parent `.env`**(API 密钥),
  而 `LINUX_BUILD_URL` 等 10 个键写在 `worker/.env` 里
- 子 `.env` 从未被读到,worker 走硬编码 fallback `http://120.55.70.226:3080`
- 该端口 LISTEN 但响应 `Empty reply from server`(僵尸服务),所有请求 ECONNRESET
- 表象指向网络/服务挂了,实际是配置加载错了文件

**根因 2:build-api 字段重命名 `code` → `csCode`,helpers.cjs 未同步**
- `/opt/luna-poc/build-api.js`(新)要求 `csCode`,legacy `linux-bridge-build.js` 要求 `code`
- `helpers.cjs:buildRequest` 和 `claude-code-coder.js:247` 的 Python payload 都只发 `code`
- 修复根因 1 后立即暴露:`{ok:false,error:"csCode required"}`

**根因 3:`/build-html` 端点被移除,HTML 改为 `htmlBase64` 内联**
- 新 build-api 只有 `/build`,返回 `{ok, buildTime, htmlSize, htmlBase64}`
- `compile.cjs:49` 还在调 `helpers.buildRequest(buildUrl, '/build-html', ...)` 期望 Buffer
- 修复根因 2 后立即暴露:`/build-html` 404

**根因 4:`if (skeleton.split)` 方法名 truthy 陷阱**
- `claude-code-coder.js:158` 想判断 skeleton 是 split-mode 对象(generator 返回 `{main,systems,split:true}`)
- 但字符串也有 `.split` — `String.prototype.split` 是函数,**永远 truthy**
- ≤10 phases 返回普通字符串时,分支误入多文件路径,`fs.writeFileSync(path, skeleton.main)` = undefined → 同步 throw
- 4 个 codegen round 同一秒全失败(特征:时间戳相同 = 同步错误,非 LLM/网络)
- 以前被"first 3 phases limit"掩盖,改成 all phases 后命中 10 phases 临界

**根因 5:stage4-template 缺 `iframe.html`(环境,非代码)**
- `linux-bridge-build.js:621` `convertToSingleHTML` 无存在检查 `fs.readFileSync(stage4Dir + '/iframe.html')`
- `/opt/luna/stage4-template/` 只有 `index.html`,没有 `iframe.html`
- 用户手动将 iframe.html 放入模板目录后解决
- 代码侧建议后续在 `convertToSingleHTML` 加 existsSync + generateIframeHTML() fallback(generator 函数已存在但从未被调用)

### 修复方案

| 修复项 | 文件 | 改动 |
|--------|------|------|
| LINUX_BUILD_URL 配置到被加载的 .env | `/opt/blueprint-editor/.env` | 新增 `LINUX_BUILD_URL=http://127.0.0.1:18860` |
| BUILD_URL fallback 去掉僵尸远端 | `worker/linux-worker-client.js:327` | `120.55.70.226:3080` → `127.0.0.1:18860` |
| buildRequest 双字段兼容 shim | `engine/helpers.cjs` | 同时发 `csCode` 和 `code`,`/build-html` 路由到 `/build` + base64 解码 |
| build-test.sh Python payload | `worker/claude-code-coder.js:247` | `{'code':code}` → `{'csCode':code, 'code':code}` |
| skeleton 分支判断改为 typeof | `worker/claude-code-coder.js:158` | `if (skeleton.split)` → `if (typeof skeleton === 'object' && skeleton.split === true)` |
| pending-rules.json 清理污染 | `worker/pending-rules.json` | 移除 outage 期间误捕获的 csCode required / iframe.html 条目(它们是环境失败,不是代码质量问题) |

### 验证结果
- Worker 2 proj_1776165800102_yjrgmn 首次完整通过 compile:`Build OK in 7s, HTML: 1.1MB`
- `[prompt-cache]` 日志显示 CLAUDE.md sha1=`a21fff93e02c` 跨 worker 一致 — prompt cache 应命中
- Worker 1 zxpzt4 突破 codegen 同步崩溃,进入正常 INCREMENTAL_FIX 流程

### 教训
1. **dotenv 路径一定要确认加载的是哪个文件** — `grep -l KEY .env worker/.env` 秒验;不要假设近邻的 `.env` 被读到
2. **fallback 默认值不要是死服务地址** — 宁愿 throw 也不要静默降级到僵尸
3. **JS `if (obj.X)` 陷阱** — 当 X 是常见方法名(`split`/`map`/`length`/`forEach`)时一定要 `typeof` 或显式比较值
4. **"N 轮同秒失败"特征** — 几乎一定是同步 throw,不要先怀疑 LLM/网络/超时,直接搜 throw 路径
5. **Auto-learner 需要 failClassification 白名单** — pending-rules.json 自动捕获机制对 `compile stage failure` 无差别收录,会把环境/网络错误当代码问题注入下次 prompt,长期会放大噪声
6. **多层级联修复的副作用** — 每修一层就暴露下一层,耗时很长;遇到这种场景要提前假设"这不是最后一层"并做好流水线 health check

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
