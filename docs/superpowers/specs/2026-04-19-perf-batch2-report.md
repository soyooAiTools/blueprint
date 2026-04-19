# Codegen Performance Batch 2 — 实施报告

**日期**：2026-04-19
**计划**：`docs/superpowers/plans/2026-04-19-codegen-perf-batch2.md`
**执行模式**：Subagent-Driven Development（Task 0/7/8/9 主执行；Task 1-6 subagent）

---

## 摘要

Batch 2 全部 3 条动态改造已落地并通过测试。**核心收益**：修复 1 个 P0 逻辑 bug（采集无冷却，每帧都能触发 AddResource → 1/6 秒装满 10 格）+ 1 个 P1 性能缺陷（IsNear 同一 target 重复计算 + scoreText 每帧拼接）。所有改动都在**模板/skeleton/schema 层**，对**所有 idle-game 类项目**生效。

---

## 落地改动（7 次 commit）

| Commit | Task | 类型 | 说明 |
|--------|------|------|------|
| `6843c15` | — | 计划 | Batch 2 实施计划 |
| `4ac1e5f` | T1 | skeleton | collect cooldown 基础设施（3 字段 + 1 行 tick-down） |
| `190229b` | T2 | 模板 | resource-flow buildCollectBlock 加 cooldown gate + scoreText diff |
| `96d7ccb` | T3 | 模板 | collect-interaction 加 cooldown gate，保留双路径 Done 标志 |
| `e58356b` | T4 | 模板 | score-display 加 _lastScoreText diff gate |
| `b516c1e` | T5 | 模板 | resource-flow buildPhaseBlocks 按 target 合并 IsNear |
| `529093a` | T6 | schema | gameConfig.collectCooldown 可配字段（0.1-2.0s, default 0.3） |

---

## 改造细节

### T2-2 采集冷却（P0 逻辑 bug）

**根因**：`buildCollectBlock` / `collect-interaction.cjs` / 未来模板各自独立判定"靠近+采集"，没有全局 cooldown。玩家在采集范围内时，`Update()` 每帧（~60Hz）都命中 `IsNear(src) && carried < max` 分支 → maxCarry=10 的资源袋 ~1/6 秒填满。

**修复方案**：skeleton 提供 3 个共享字段（`collectCooldownInterval` / `_collectCooldown` / `_lastScoreText`），3 个采集模板共用同一冷却时钟。

| 字段 | 类型 | 默认 | 作用 |
|------|------|------|------|
| `collectCooldownInterval` | float | 0.3f | 冷却间隔，读 schema `gameConfig.collectCooldown` |
| `_collectCooldown` | float | 0f | 冷却倒计时，Update 每帧 -= deltaTime |
| `_lastScoreText` | string | "" | 上次 scoreText.text 值，diff 后才赋值避免 Bridge alloc |

**为什么用共享而不是 per-resource**：YAGNI。玩家一次只能采集一个资源源，共享时钟语义正确；且共享设计避免了模板间约定重复命名字段（若每个模板定义自己的 `_collectCooldown_SpaceDebris` 会在 multi-source 场景污染 IL）。

**应用点**：
- `resource-flow.cjs buildCollectBlock`：`if (_collectCooldown <= 0f && IsNear(...))` 包裹 AddResource+置 cooldown
- `interactions/collect-interaction.cjs`：同上，且保留 `xxxDone = true` **双路径写法**（OnAutoPlayArrive + Update，遵 `feedback_done_flag_dual_path.md`）
- `interactions/score-display.cjs`：`if (_lastScoreText != display) { scoreText.text = display; _lastScoreText = display; }`

### T2-1 IsNear 按 target 合并（P1 性能）

**根因**：`buildPhaseBlocks` 对每个 deliver resource 生成独立 `if (IsNear(target, 2f)) { ... }` 块 → 若一个 target 有 3 个资源可卖，IsNear 被调用 3 次。IsNear 含 sqrMagnitude 计算，每帧 3× 浪费。

**修复**：按 `trigger.entity` 分组，单次 IsNear 外层 if + 多个 deliver body 嵌入：

```csharp
if (IsNear(forgeWorkshop, 2f)) {
    // deliver resource A
    // deliver resource B
    // deliver resource C
}
```

**辅助**：抽出 `buildDeliverBody()`（不含外层 if），替换原 `buildDeliverBlock()`。

### T2-3 可配 collectCooldown（配置灵活性）

`adapters/schema/game-schema.json` `gameConfig.properties` 新增 `collectCooldown`：
- `minimum: 0.1` / `maximum: 2.0` / `default: 0.3`
- schema-driven codegen 会把此字段透传到 specs.gameConfig，skeleton 读取作为 `collectCooldownInterval` 初值

---

## 测试覆盖

```
Jest: 116 passed, 116 total (11 test suites)
```

测试数量演进：
- Batch 3 结束：100
- Task 1 (+5)：105 — skeleton cooldown 基础设施
- Task 2 (+4)：109 — resource-flow collect gate + diff
- Task 3 (+3)：112 — collect-interaction gate
- Task 4 (+2)：114 — score-display diff
- Task 5 (+2)：116 — IsNear 合并（单独一个 describe 块，复用 resource-flow.test.cjs）

新增测试文件：
- `test/batch2-skeleton-cooldown.test.cjs` — 5 tests
- `test/batch2-resource-flow.test.cjs` — 6 tests（T2 的 4 + T5 的 2）
- `test/batch2-collect-interaction.test.cjs` — 3 tests
- `test/batch2-score-display.test.cjs` — 2 tests

---

## HEAD Skeleton 端到端验证

用 `proj_1776347813541_17tyoq`（idle-game 项目：joystick + collect）跑 skeleton-generator：

```
bytes: 62633
has collectCooldownInterval: true          ✅
has _collectCooldown: true                  ✅
has _lastScoreText: true                    ✅
update-new-vector-in-hot-path total: 0     ✅ Batch 3 blocking 仍 0 命中
chained-if-same-var-no-else total: 1       — TODO_AUTOPLAY_INTERACT stub（预期）
string-concat-in-update total: 0           ✅ 维持清洁
```

字段位置：
- L167-169：3 个字段声明（`if (isIdleGame)` 内）
- L525：`if (_collectCooldown > 0f) _collectCooldown -= Time.deltaTime;`（Update 内）

**isIdleGame gate 校验**：用 xrbkl1（click-based，无 move_to:）生成发现 3 个字段**不**emit——符合 gate 设计（cooldown 基础设施仅在 joystick+collect 项目出现）。对 click-only 项目，采集 bug 不存在（click 本身已有节流），冷却无需注入。

---

## Task 8 CUA 回归（跳过，已记录）

**原因**：API `/api/projects` 只列出 1 个项目 `urbib0`（太空捡垃圾），status=failed，不满足 Task 8 入口条件（需 committed + null lastFailure）。xrbkl1/2p50o1 也非 idle-game（click-only），不是 T2-2 改造目标。

**替代方案**：下个 idle-game 新项目进入 pipeline 时自然观察——
1. codegen 阶段检查 Main.cs 是否含 `_collectCooldown` / `collectCooldownInterval`
2. 生成的 collect 块是否走 `if (_collectCooldown <= 0f && IsNear(...))` 而不是裸 `if (IsNear(...))`
3. Luna 构建 + CUA 运行期：`__gameState.carried` 增长应为 ~3/秒（原来 ~60/秒）

**如异常**：回退到单 commit 级 revert（`git revert <hash>`），每 task 独立 commit。

---

## 风险 & 回滚

- **T2-2 风险**：冷却默认 0.3s，若某项目玩法设计上需要"连续快采"（未遇到），调 `specs.gameConfig.collectCooldown = 0.1` 即可；schema 已支持 0.1-2.0 范围。
- **T2-1 风险**：buildPhaseBlocks 重写。保留 buildDeliverBody 接口契约（被 buildCollectBlock 以外代码引用的可能性低——grep 确认无外部引用），已删除原 buildDeliverBlock。
- **T2-3 风险**：schema 新增 optional 字段，向后兼容——老 specs 不含此字段时 skeleton 用硬编码 0.3f 默认。
- **回滚粒度**：6 条功能 commit 独立，任意一条 `git revert` 不影响其他。

---

## 完成判据（全部达成）

- [x] Jest 116/116 全绿
- [x] Skeleton 在 idle-game 项目上正确 emit 3 个冷却字段 + 1 行 tick-down
- [x] 3 个采集模板共享同一 cooldown 时钟
- [x] buildPhaseBlocks 按 target 合并 IsNear
- [x] schema 新增可配字段，minimum/maximum/default 满足计划约束
- [x] Batch 3 静态规则在新 skeleton 上保持清洁（blocking 0 命中）
- [x] 7 次独立 commit（含 plan）
- [x] Design doc status 行已更新

---

## 下一步建议

1. **观察窗口**：下 1-2 个 idle-game 新项目进 pipeline，在 dashboard 看：
   - codegen 产物是否正确 include 冷却逻辑
   - CUA `__gameState.carried` 增速是否为 ~3/秒（验证 0.3s 冷却生效）
   - 是否触发任何新 FATAL（回归信号）
2. **FPS 对比**（原计划验收项）：需 Puppeteer harness + idle-game healthy 项目对照。目前无健康样本项目，延后到有稳定样本项目后做。
3. **模板扩展提醒**：未来如新增第 4 个采集类模板，记得复用 skeleton 3 字段，不要重新声明同名字段——已在 skeleton `[SKELETON] Batch 2 collect cooldown infra — shared across all collect templates` 注释中标记。

---

## 附录：提交历史（Batch 2 窗口）

```
529093a perf(schema): T2-3 gameConfig.collectCooldown 可配字段 (0.1-2.0s, default 0.3)
b516c1e perf(template): T2-1 resource-flow 按 target 合并 IsNear 块
e58356b perf(template): T2-2c score-display 加 _lastScoreText diff gate
96d7ccb perf(template): T2-2b collect-interaction 加 cooldown gate
190229b perf(template): T2-2a resource-flow 采集加 cooldown gate + scoreText diff
4ac1e5f perf(skeleton): Batch 2 collect cooldown + lastScoreText 基础设施
6843c15 docs(perf): Batch 2 implementation plan — 采集逻辑 bug + IsNear 合并
```
