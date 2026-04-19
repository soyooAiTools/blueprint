# Codegen Performance Batch 3 — 实施报告

**日期**：2026-04-19
**计划**：`docs/superpowers/plans/2026-04-19-codegen-perf-batch3.md`
**执行模式**：Subagent-Driven Development（Task 0/4/5 主执行；Task 1/2/3 subagent）

---

## 摘要

Batch 3 全部 3 条静态规则已落地并通过测试，锁住 Batch 1 在 skeleton/模板层的性能清理成果。`update-new-vector-in-hot-path` blocking 规则在 HEAD skeleton 上零命中 → Batch 1 的整治在 static-check 层面被固化，后续任何 AI 改动或新模板再次污染 hot path 都会在 codegen 阶段被直接阻断返工。

---

## 落地改动（4 次 commit）

| Commit | Task | 类型 | 规则 ID | blocking |
|--------|------|------|---------|----------|
| `d6febc1` | T3-1 | 新规则 | `update-new-vector-in-hot-path` | ✅ 是 |
| `d841caa` | T3-2 | 新规则 | `chained-if-same-var-no-else` | ❌ warn |
| `4fdf383` | T3-3 | 新规则 | `string-concat-in-update` | ❌ warn |
| `3fa4623` | — | 收尾 | RULES count assertion 59 → 62 | — |

---

## 规则细节

### T3-1 `update-new-vector-in-hot-path` (blocking)

**扫描范围**：`Update()` / `MovePlayer()` / `CheckEventRules()` / `AutoPlayUpdate()` 四个热点函数体。
**定位方式**：strip comments/strings → 正则定位签名 → brace-depth walker 找函数体范围。
**命中模式**：`\bnew\s+Vector3\s*\(args\)`，豁免 `new Vector3()` / `new Vector3(0)` / `new Vector3(0,0,0)` 零向量。
**影响**：codegen 阶段返工（blocking），注入 feedback 给 fix-loop。
**目的**：Batch 1 已清理 skeleton 自身的 hot path new Vector3；此规则防止 AI 生成的自定义逻辑再把 `new Vector3` 写回 hot path。

### T3-2 `chained-if-same-var-no-else` (warn)

**命中条件**：≥3 个连续 `if (X == "...")` 且 X 为同一标识符、彼此之间无 `else` 介入。
**实现**：扫 `(\belse\s+)?\bif\s*\(\s*(\w+)\s*==\s*""`，按连续同标识符分组并计数；遇 `else` 前缀则 reset。
**影响**：non-blocking，警告引导改 else-if 链或 switch。
**目的**：防 AI 学坏 bare-if 样板（Phase 判定模式）。Skeleton 自身的 TODO_AUTOPLAY_INTERACT pre-codegen stub 命中 1 次，但会被 autoplay-mirror 在 codegen 阶段覆盖为 else-if 版本 → 实际最终产物不会命中。

### T3-3 `string-concat-in-update` (warn)

**扫描范围**：同 T3-1 四个热点函数。
**命中模式**：`\.text\s*=\s*(?:""|\w+)\s*\+`（`.text = "..." + ...` 或 `.text = var + ...`）。
**影响**：non-blocking，警告引导"仅数值变化时赋值"模式。
**目的**：防 UI 文本每帧拼接 → Luna/Bridge.NET 下临时 string 对象。

---

## 测试覆盖

```
Jest: 100 passed, 100 total
```

测试数量演进：
- Batch 1 结束：88
- Task 1 后（+5 tests T3-1）：93
- Task 2 后（+4 tests T3-2）：97
- Task 3 后（+3 tests T3-3）：100

RULES 数量：60 → 63（+3）。Assertion `toBeGreaterThanOrEqual` 从 59 提到 62（保留 1 的裕度）。

---

## HEAD Skeleton 命中报告（验收关键）

用 xrbkl1 真实 specs 跑 skeleton-generator 在 `/tmp/batch3-skeleton.cs`（51943 字节），对三条规则过一遍：

| 规则 | total | blocking | 说明 |
|------|-------|----------|------|
| T3-1 `update-new-vector-in-hot-path` | **0** | **0** | ✅ 验收关键 — Batch 1 清理到位 |
| T3-2 `chained-if-same-var-no-else` | 1 | 0 | TODO_AUTOPLAY_INTERACT stub（L170-244），codegen 阶段会被覆盖 |
| T3-3 `string-concat-in-update` | 0 | 0 | skeleton 已用合理策略处理 scoreText |

**结论**：**T3-1 blocking=0** 是核心验收项。如果 skeleton 在自己的 hot path 里还有 new Vector3，启用 blocking 规则会让所有新项目直接 codegen 返工。实际 0 命中证明 Batch 1 改动可以放心锁住。

---

## 风险 & 回滚

- **T3-1 blocking 风险**：如果某个未覆盖的模板分支偷偷 `new Vector3` 进 Update（例如 `resource-flow.cjs` 或某个交互模板），第一次生成时会 codegen 返工。目前 HEAD 零命中，风险低。
- **回滚**：每条规则独立 commit，`git revert <hash>` 即可。blocking → warn 可以只改规则 `blocking: true` 字段。
- **T3-2/T3-3 warn 不阻断 pipeline**，只进 fix-loop feedback，最差情况是 AI 收到一条没用的警告。

---

## 完成判据（全部达成）

- [x] Jest 100/100 全绿
- [x] RULES 数量 63（assertion ≥62）
- [x] HEAD skeleton 上 `update-new-vector-in-hot-path` 命中 0（blocking，必须 0）
- [x] 4 次独立 commit
- [x] Design doc status 行已更新

---

## 下一步建议

1. **Batch 2**：需要 CUA 回归测试。依赖一个健康项目（编译+CUA 都稳定），urbib0 不合适（semantic 故障未修）。建议先筛项目，挑一个过 CUA 多轮的做对照。
2. **观察窗口**：Batch 3 rules 上线后，下几个新项目的 codegen 阶段会不会因 T3-1 blocking 触发返工。如果频繁触发 → 某处模板泄漏，把泄漏的 `new Vector3` 拉进 Batch 1 补漏。
3. **Batch 2 是否继续**：T2-2 的收集冷却是**逻辑 bug fix**，不仅是性能优化。风险中高（改动 CUA 时序），值得做但不急。

---

## 附录：提交历史（Batch 3 窗口）

```
3fa4623 test(static): RULES count assertion 59 → 62 (Batch 3 收尾)
4fdf383 perf(static): T3-3 warn — string concat on .text in Update (Batch 3)
d841caa perf(static): T3-2 warn — chained if on same var without else (Batch 3)
d6febc1 perf(static): T3-1 blocking — new Vector3 in Update hot path (Batch 3)
d872212 docs(perf): Batch 3 implementation plan — 3条静态规则防回归
```
