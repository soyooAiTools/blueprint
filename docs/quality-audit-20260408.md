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

1. **将 promoted rules 硬编码进 skeleton**
   - Camera.backgroundColor 写死 (0.35f, 0.55f, 0.75f)
   - 移除 GFM_Create.SetColor API 文档引用
   - Pool 对象颜色在 skeleton 注释中标注
   
2. **修复 CUA 的 INFRA/FATAL 分类**
   - API 401、CDP crash → INFRA + 重试
   - 游戏真的不能玩 → CODE + recode

### P1 — 补缺

3. **在 review 加渲染相关 static rules**
   - 检测 Camera.backgroundColor 设置值
   - 检测至少 3 个 pool 对象有 transform.position 赋值
   - 检测不包含 GFM_Create.SetColor 调用

4. **激活 lesson-extractor 自动提升链路**
   - 确认 autoPromotePendingRules() 在 pipeline 完成后被调用
   - 修复 sourceStage 和 crossProjectCount 的记录

### P2 — 加速

5. **在 compile 后加轻量截图检测**
   - 不需要 VLM，纯色/静态帧用像素分析
   - 失败直接 recode，不等到 visual-check

6. **CUA 前增加无头 phase smoke test**
   - Playwright 加载 → 等 5s → 检查 console __PHASE__ 输出
   - 有输出 = instrumentation 正常 → 交给 CUA

---

## 六、数据来源

- Metrics: `/opt/blueprint-editor/server-data/metrics/pipeline-metrics.jsonl.bak.20260408` (64 条记录)
- Promoted rules: `/opt/blueprint-editor/worker/promoted-rules.json` (12 条)
- Pending rules: `/opt/blueprint-editor/worker/pending-rules.json` (65 条)
- 代码: `/opt/blueprint-editor/engine/` 全部 stage 实现

---

*审计人: Claude Opus 4.6 | 日期: 2026-04-08*
