# Codegen Performance Batch 1 — 实施报告

**日期**：2026-04-19
**计划**：`docs/superpowers/plans/2026-04-19-codegen-perf-batch1.md`
**执行模式**：Subagent-Driven Development（每 task 独立 subagent，TDD，commit-after-green）

---

## 摘要

Batch 1 全部 5 项模板级改动已落地并通过 Jest 88/88 验证。**皮线级 FPS 对照（task 6）因项目既有 semantic 故障未能完成**，与 Batch 1 改动无关。建议维持现有改动，进入 Batch 2/3。

---

## 落地改动（6 次 commit）

| Commit | Task | 文件 | 改动 |
|--------|------|------|------|
| `1206f3c` | T0 | `scripts/fps-baseline.cjs` (新) | Puppeteer-core + rAF 采样 FPS harness；目标 `server-data/webgl/<id>/index.html`；输出 `server-data/perf-baseline/*.json` |
| `59cdc2b` | T1-3 | `adapters/templates/autoplay-mirror.cjs` | 多 phase 的 `currentPhaseName` 判定改为 `if / else if` 链，短路不再扫全部分支 |
| `2109ada` | T1-4 | `adapters/codegen-template-engine.cjs` | `generateUpdateBody` 中 autoplay interaction 判定同样改 else-if |
| `365438d` | T1-5 | `adapters/skeleton-generator.cjs` | `IsNear()` 从 `Vector3.Distance` 改为 XZ 平方距离，消除每次 sqrt + 1 个 Vector3 alloc |
| `1a8b302` | T1-1 | `adapters/skeleton-generator.cjs` | `PlaceObj/HideObj/SetScale`（4 个 helper）改为 struct-copy 模式（`var p = x.transform.position; p.x = …; x.transform.position = p;`），移除 `new Vector3`，加 null 守卫 |
| `77838b1` | T1-2 | `adapters/skeleton-generator.cjs` | `MovePlayer` joystick 分支用 `Vector3 _moveBuf` 字段复用，移除每帧 `new Vector3` |

---

## 测试覆盖

```
Jest: 88 passed, 88 total
```

新增测试：
- `test/codegen-template-perf.test.cjs` — T1-3/T1-4 else-if 链（正则匹配）
- `test/skeleton-generator-perf.test.cjs` — T1-5 dx*dx 形式、T1-1 struct-copy 无 `new Vector3`、T1-2 `_moveBuf` 字段 + joystick 零 alloc

Fixture 修正：PhaseSpec 使用 `Array<PhaseSpec>` 原生形状（非包装 `{phases: [...]}`），`requiredInteractions: ['move_to:Target', 'collect:Metal']` 触发 `isIdleGame` gate 让 IsNear/MovePlayer helpers 实际出码。

---

## Before 基线（task 0）

`server-data/perf-baseline/proj_1776391516726_urbib0-before.json`

```json
{ "avgFps": 60.15, "frames": 602, "frameMs": { "p50": 16.70, "p95": 16.80, "p99": 16.80 } }
```

**注释**：headless SwiftShader vsync 锁 60fps，rAF 预算 ~16.6ms。**FPS 无法作为主指标，改用 `new Vector3` 计数作为主指标，FPS 作 regression 侦测辅助**（按 Option A 执行）。

---

## After 基线（未完成）

**task 6 状态：pipeline 未能重跑到 CUA 阶段**。

- 触发方式：`POST /api/projects/proj_1776391516726_urbib0/feedback` → `taskQueue.resubmit()`
- 失败模式：6 轮 review fix-loop 后仍因**项目固有 semantic 错误**被阻断（invalid pool names / player not initialized / autoplay concept names / HydraulicVehicle pool mapping / `lastFailure = "Cannot read properties of undefined (reading 'length')"`）
- 历史记录核对：同项目在 Batch 1 改动**之前**的多次运行也是同一失败栈，即**不是 Batch 1 引入的回归**。

因此 after 基线无法对 before 做同口径比较。

---

## 静态验证（替代 after 基线）

在 HEAD 上跑 skeleton-generator 针对真实 specs（`spec-data/proj_1776297105366_xrbkl1/specs.json`），输出 `/tmp/skeleton-head.cs`（56501 字节），模式计数：

| 模式 | 计数 | 预期 |
|------|------|------|
| `new Vector3(` | 0 | ✅ 消除 |
| `PlaceObj` struct-copy（`var pos = obj.transform.position`） | 1 | ✅ |
| `HideObj / SetScale` struct-copy | present | ✅ |
| `IsNear` XZ 平方距离 | present | ✅ |
| `_moveBuf` 字段 + joystick 复用 | present | ✅ |

**关于 skeleton L591 的 12 处 `bare if`（非 else-if）**：这是 `TODO_AUTOPLAY_INTERACT_START/END` 区块内的 **pre-codegen stub**，会在 codegen 阶段被 `autoplay-mirror.cjs` 的 else-if 版本**整段覆盖**。独立跑 skeleton 不会触发 mirror 阶段，所以看到的是 stub，**属于正常流程，不是 bug**。

---

## 风险评估

**T1-1（struct-copy）风险项**：Bridge.NET C# → JS 转译中，Unity `transform.position` getter 在 Bridge 下是否真的返回 struct copy 还是 reference 不明确。若为 reference，struct-copy 模式退化为直接改源 position + 再赋值（两次无害），不会引入语义错误，但也拿不到 alloc 改善。

**目前证据**：
- Jest 静态验证通过（代码形状正确）
- 无运行时回归证据（pipeline 没有跑到 CUA）
- 无运行时改善证据（同上）

**建议**：**不 revert**。理由：
1. 改动本身在 C# 语义上无害（struct-copy 在 Unity runtime 一定安全）
2. 即便 Bridge 下等价于零改善，也不会变差
3. revert 需要再改 3 个 helper + 跑 Jest，成本 > 收益

---

## 结论与下一步

- ✅ Batch 1 模板级改动全部落地、Jest 通过、静态验证通过
- ⚠️ Pipeline 级 FPS 对照因项目既有 semantic 问题阻断（与 Batch 1 无关）
- 🟰 无证据证明 Batch 1 引入回归；无运行时证据证明 Batch 1 带来改善

**推荐路径**：
1. 进入 Batch 2/3 规划（更粗粒度的改动，收益更明确）
2. 或：挑一个**健康项目**做 FPS 对照验证（需先筛选出编译+CUA 都稳定的项目）
3. 暂不 revert T1-1

---

## 附录：提交历史

```
77838b1 perf(skeleton): MovePlayer reuses _moveBuf field, no per-frame alloc (T1-2)
1a8b302 perf(skeleton): PlaceObj/HideObj/SetScale use struct-copy pattern (T1-1)
365438d perf(skeleton): IsNear uses XZ sqr distance, no sqrt or Vector3 alloc (T1-5)
2109ada perf(codegen): template-engine TODO_UPDATE uses else-if chain (T1-4)
59cdc2b perf(codegen): autoplay-mirror uses else-if chain (T1-3)
1206f3c feat(perf): add FPS baseline harness + before baseline (Batch 1 prep)
```
