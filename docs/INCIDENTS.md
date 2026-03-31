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
