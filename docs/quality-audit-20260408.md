# Blueprint 质量审计报告 — 2026-04-08

## 审计范围

从业务角度全面评估 Blueprint 试玩广告自动生成流水线的：
1. 输出质量（端到端成功率）
2. 审核质量（质量门控有效性）
3. Harness Engineering 架构符合度
4. 改进优先级建议

---

## 一、核心指标

| 指标 | 数值 | 评价 |
|------|------|------|
| 端到端成功率 | **0/64 (0%)** | 无可交付产出 |
| 平均运行时长 | 1470s (~24min) | 资源消耗大 |
| FATAL 占比 | 93% (60/64) | 分类器过于激进 |
| 独立任务数 | 3 | 样本有限 |

### 各阶段失败分布

| 阶段 | 失败次数 | 占比 | 说明 |
|------|---------|------|------|
| codegen | 25 | 39% | AI 代码生成直接失败 |
| compile | 10 | 16% | Bridge.NET 编译失败 |
| cua-verify | 9 | 14% | API 401 + CDP crash |
| visual-check | 9 | 14% | 纯色屏幕/静态画面 |
| review | 8 | 12% | 审核轮次耗尽 |
| clone | 3 | 5% | 模板拉取失败 |

---

## 二、三个致命短板

### 短板 1：Codegen "能编译不能渲染"

- Review + Compile 通过率 100%，但 visual-check 通过率 0%
- AI 生成代码语法正确但渲染为纯色屏幕
- 根因：Camera 背景色混色、SetColor GL_INVALID_OPERATION、SafeColor 无限递归
- 这些已在 promoted-rules 中记录，但**未硬编码进 skeleton**

### 短板 2：Review 阶段形同虚设

- Static check 50 条规则仅覆盖 API 禁用，不检测渲染问题
- LLM review 无法执行代码，看不到渲染结果
- Spec conformance 只检查结构（有没有 AddCompletedPhase），不检查语义
- **100% 放行了后续 100% 失败的代码**

### 短板 3：CUA 验证可靠性不足

- 94% 以 FATAL 退出（API 401、CDP 断连被错误分类为 FATAL）
- Phase coverage 全是 0/N — ReportPhase 从未触发
- CUA 作为硬性门控，自身可靠性不足以承担此角色

---

## 三、审核体系评估

| 层 | 状态 | 问题 |
|----|------|------|
| 50 条 static rules | 运行正常 | 仅覆盖 API 禁用 |
| 12 条 promoted rules | 已提取但未自动注入 | crossProjectCount 全为 0，sourceStage 全为 None |
| 65 条 pending rules | 堆积 | 37 条 info 级别永远不会被提升 |
| LLM review | 无效 | 100% 放行失败代码 |
| Spec conformance | 弱 | 只检查调用存在性 |

**核心问题**：学习 -> 提升 -> 注入 链条断裂。Promoted rules 是手动写入而非自动学习提升。

---

## 四、Harness Engineering 符合度

| 设计原则 | 设计 | 实际 |
|----------|------|------|
| 8 阶段隔离 | 完整 | 已实现 |
| 每阶段 fix loop | 完整 | 大部分第 1 轮 FATAL 退出，loop 无机会发挥 |
| 错误分类驱动恢复 | INFRA/CODE/GATE/FATAL | 93% FATAL，粒度太粗 |
| 知识自动提取闭环 | failure->lesson->pending->promoted->prompt | 链条断裂 |
| 质量门控递进 | assertBefore + stage gate | 前置门控太弱 |
| Checkpoint 恢复 | 完整 | 正常工作 |
| Metrics 可观测 | JSONL + dashboard | 部分 duration 为 0s |

**结论**：架构正确，但存在"设计完成但未激活"的空转。

---

## 五、改进优先级

### P0 — 立竿见影

1. **将 promoted rules 硬编码进 skeleton** ✅ 已完成 (a7a6826)
   - Camera.backgroundColor 预设 (0.45, 0.52, 0.62)，skeleton 注释禁止修改
   - 移除所有 GFM_Create.SetColor/Obj 调用，改用 pool 对象 Find
   - 移除 Destroy 调用，改用 pooled text element
   - Pool 对象颜色在 PlaceObj 注释中标注
   - skeleton 头部添加 7 条渲染规则 + 3 条 anti-autoplay 规则
   
2. **修复 CUA 的 INFRA/FATAL 分类** ✅ 已完成 (a7a6826)
   - FATAL 模式收紧: `/not available/i` → `/(?:generator|reviewer|coder).*not available/i`
   - 新增 11 个 CUA INFRA 模式 (Xvfb/PlayableAgent/SiliconFlow/Qwen)
   - PlayableAgent skipped 不再返回 passed:true，改为 passed:false + INFRA 错误
   - cua-verify 区分 skipped(INFRA 重试) vs passed

### P1 — 补缺

3. **在 review 加渲染相关 static rules** ✅ 已完成 (a7a6826)
   - `safe-color-recursion`: SafeColor 递归模式检测
   - `renderer-material-color`: material.color 赋值检测
   - `new-material`: new Material() 检测
   - `render-no-objects`: phase 1 至少 3 个 PlaceObj/position 赋值

4. **激活 lesson-extractor 自动提升链路** ✅ 已完成 (a7a6826 + bc6d37d)
   - pipeline 成功/失败/gate 三条路径均调用 autoPromotePendingRules()
   - autoPromotePendingRules 已导出供 pipeline.cjs 调用
   - promoted rules 正确记录 crossProjectCount 和 sourceStage
   
5. **skeleton anti-autoplay 交互门控** ✅ 已完成 (a7a6826)
   - buildRealCondition() 不再 fallback 到纯 timer 条件
   - 无交互/无实体 phase → 生成 InteractionDone 标志位
   - playerMustAct + 有实体无交互 → 生成 PlayerActed 标志位
   - 所有交互标志位自动声明为 bool 变量

### P2 — 加速

6. **metrics JSONL rotation** ✅ 已完成 (a7a6826)
   - 文件超过 10MB 自动 rename 为 `.bak.{日期}` 并创建新文件

7. **在 compile 后加轻量截图检测** — 待实施
   - 不需要 VLM，纯色/静态帧用像素分析
   - 失败直接 recode，不等到 visual-check

8. **CUA 前增加无头 phase smoke test** — 待实施
   - Playwright 加载 → 等 5s → 检查 console __PHASE__ 输出
   - 有输出 = instrumentation 正常 → 交给 CUA

---

## 六、数据来源

- Metrics: `/opt/blueprint-editor/server-data/metrics/pipeline-metrics.jsonl.bak.20260408` (64 条记录)
- Promoted rules: `/opt/blueprint-editor/worker/promoted-rules.json` (12 条)
- Pending rules: `/opt/blueprint-editor/worker/pending-rules.json` (65 条)
- 代码: `/opt/blueprint-editor/engine/` 全部 stage 实现

---

## 七、修复记录

### 2026-04-08 第二批修复 (a7a6826 + bc6d37d)

**修改文件 (8个):**
| 文件 | 改动 |
|------|------|
| `worker/worker-playableagent.js` | 4处 skipped→passed 改为 skipped→failed |
| `engine/stages/cua-verify.cjs` | 区分 skipped(INFRA重试) vs passed |
| `engine/error-classifier.cjs` | FATAL收紧 + 新增11个CUA INFRA模式 |
| `adapters/skeleton-generator.cjs` | 移除SetColor/Obj/Destroy + anti-autoplay标志位 |
| `engine/static-check.cjs` | 新增4条渲染类规则 |
| `engine/pipeline.cjs` | 三路径调用autoPromotePendingRules |
| `worker/code-reviewer.js` | 导出autoPromote + 修复promoted字段 |
| `engine/metrics.cjs` | JSONL >10MB自动rotation |

**预期影响:**
- visual-check 通过率: 0% → 预计 >50% (消除纯色屏根因)
- CUA 误分类为 FATAL: 93% → 预计 <20% (INFRA 正确重试)
- 学习闭环: 断裂 → 自动运转 (pending→promoted→prompt)
- autoplay 误通过: 高 → 低 (skeleton 强制交互门控)

---

*审计人: Claude Opus 4.6 | 日期: 2026-04-08 (更新)*
