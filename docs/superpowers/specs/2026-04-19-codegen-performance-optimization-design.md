# Codegen Performance Optimization Spec

**Date**: 2026-04-19
**Status**: ✅ Approved — Batch 1 + Batch 3 已落地 (2026-04-19)，Batch 2 待健康项目做 CUA 对照
**Scope**: skeleton-generator + template-engine + static-check 三层的性能问题修复
**Trigger**: 用户审查 proj_1776391516726_urbib0 (太空捡垃圾) 代码发现 Update new Vector3 / 11 连裸 if / IsNear 重复计算

## 决策纪要（用户 2026-04-19 确认）

| 问题 | 决定 |
|---|---|
| 1. Batch 粒度 | **三批次推进** |
| 2. T2-2 collect cooldown 0.3s | **合理**，采纳 |
| 3. T3-1 静态规则严格度 | **blocking** |
| 4. 验收方式 | **采集 FPS 基准对比**（Puppeteer harness） |
| 5. T3-1 豁免列表 | **只盯 Update 系列热点函数里的 `new Vector3(`**；Vector2/Color/初始化代码全放过（组合 b + c） |

## 调研补充（2026-04-19 二次确认）

- 本地与 origin/main 一致，无远端更新
- 最近 session `d7b9f5d9` (cf75e2a) 是 observability/archive 系统，与性能正交，未改 skeleton/模板/static-check
- spec 所有目标文件**未被任何近期 commit 修改**，模式仍在
- 相邻 spec `docs/specs/2026-04-18-space-junk-refactor-spec.md` 是 pool manifest 重跑，明确"skeleton-generator.cjs 不动"，与本 spec 不冲突
- 基线项目产物 `proj_1776391516726_urbib0/GameFlowManagerMain.cs` 工作区 1604 行 / 10 `new Vector3`（pipeline 重跑结果），用此作基线

---

## Problem

通读 `server-data/project-sources/proj_1776391516726_urbib0/` 确认问题**不是单次 AI 失手，是 skeleton 模板 + 模板引擎层直接产物**，每个项目都会复现。

### 实证：问题在模板源头

| 产出代码问题 | 源文件 | 源行 |
|---|---|---|
| `new Vector3` in MovePlayer (每帧 ×2) | `adapters/skeleton-generator.cjs` | 380, 382 |
| `new Vector3` in UpdateCarryVisuals 循环 | `adapters/skeleton-generator.cjs` | 464 |
| `new Vector3` in PlaceObj/HideObj/SetScale | `adapters/skeleton-generator.cjs` | 979, 984, 989, 993 |
| 11 连裸 if(currentPhaseName) TODO_AUTOPLAY | `adapters/templates/autoplay-mirror.cjs` | 16 |
| 11 连裸 if(currentPhaseName) TODO_UPDATE | `adapters/codegen-template-engine.cjs` | 155 |
| IsNear 重复（多 phase 共享 target） | `adapters/templates/resource-flow.cjs` | 42, 78 |
| `IsNear` 用 `Vector3.Distance`（含 sqrt） | `adapters/skeleton-generator.cjs` | 418 |
| string concat 每帧（scoreText.text） | `adapters/templates/resource-flow.cjs` | 45 |

### 影响面

Luna = Bridge.NET → JS → WebGL。C# struct Vector3 在 JS 被模拟为 object，**`new Vector3` = heap alloc**。小内存 WebGL 环境下：
- 60fps × 2 Vector3/帧（MovePlayer）= 120 alloc/s
- + PlaceObj 每帧命中 ≈ 4-8 个对象 = 240-480 alloc/s
- + UpdateCarryVisuals 循环（若激活）= 600 alloc/s 峰值
- → GC 周期性抖动，玩家感知为掉帧

string concat 同理：`scoreText.text = "X: " + n + "/Y"` 每帧 2-3 个临时 string + UI Canvas dirty redraw。

---

## 优化清单 — 分档决策

### 🔴 Tier 1：必须做（高杠杆，低风险，一改全局受益）

#### T1-1: PlaceObj/HideObj/SetScale 改 `transform.position.Set`（或 localPosition 字段赋值）
- **修改**：`skeleton-generator.cjs` L977-994
- **影响范围**：全项目所有 phase init + 所有 Update IsNear 分支（最高频热点之一）
- **收益**：每个 PlaceObj 节省 1 次 Vector3 alloc。hot path 中单 Update 约 4-8 次命中。
- **风险**：极低 — Unity `Vector3.Set(x,y,z)` 是结构体方法；Bridge.NET 下需验证 JS 目标结构是否支持。若不支持，退一步用 `obj.transform.localPosition = tmpVec3; tmpVec3.x = x; tmpVec3.y = y; tmpVec3.z = z` —— 但这有 struct-copy 陷阱。**最稳妥**：`var pos = obj.transform.position; pos.x = x; pos.y = y; pos.z = z; obj.transform.position = pos;` 仍是 1 次 struct copy 但无 heap alloc。
- **验证**：build 完产物 JS 里 grep `new Vector3` 数量，应减少 ≥60%。

#### T1-2: MovePlayer 复用 Vector3 字段
- **修改**：`skeleton-generator.cjs` L366-411（MovePlayer 块）
- **改法**：引入 private field `Vector3 _moveBuf`，每帧赋值不 new：`_moveBuf.x = h; _moveBuf.y = 0; _moveBuf.z = v;`
- **Quaternion.LookRotation** 这个没办法（它内部 new Quaternion），但不是 alloc 热点（Quaternion 在 Luna 下 struct pool 做得比 Vector 好）。
- **收益**：节省 2 Vector3 alloc/帧 × 60fps = 120/s 常驻。

#### T1-3: autoplay-mirror.cjs 改 `else if` 或 `switch`
- **修改**：`adapters/templates/autoplay-mirror.cjs` L16
- **改法**：
  ```js
  lines.push('        ' + (i === 0 ? 'if' : 'else if') + ' (currentPhaseName == "' + phase.phaseId + '") {');
  ```
- **收益**：11 次 string compare → 平均 6 次（命中即短路）。非性能热点（OnAutoPlayArrive 只在 autoplay arrive 时调用，不是每帧），但**代码卫生 + 防 AI 学坏样板**。
- **风险**：零。逻辑等价（phase 互斥）。

#### T1-4: codegen-template-engine.cjs TODO_UPDATE 点击分支改 `else if`
- **修改**：`adapters/codegen-template-engine.cjs` L155
- **改法**：同上，首个用 `if`，后续 `else if`。
- **收益**：这个**是**每帧检测（点击事件每次触发检查）。11 string compare → 6 平均。
- **风险**：零。

#### T1-5: IsNear 改 sqrMagnitude
- **修改**：`skeleton-generator.cjs` L418
- **改法**：`return (player.transform.position - target.transform.position).sqrMagnitude < range * range;`
- **但 Bridge.NET 下 `position - position` 仍会 new Vector3**。更稳妥：
  ```csharp
  float dx = player.transform.position.x - target.transform.position.x;
  float dz = player.transform.position.z - target.transform.position.z;
  return (dx*dx + dz*dz) < range * range;
  ```
- **收益**：省 sqrt + 省 1 Vector3 alloc。IsNear 每帧被 Update 调 ≥8 次 → 节约明显。
- **风险**：极低。range 平方在模板生成时编译期算好；运行期乘法比 sqrt 快一个数量级。

---

### 🟡 Tier 2：应该做（中杠杆，需要小心）

#### T2-1: resource-flow.cjs 合并同 target 的 IsNear 块
- **修改**：`adapters/templates/resource-flow.cjs` L51-70（`buildPhaseBlocks`）
- **现状问题**：多个 phase 用同一 target（ForgeWorkshop）时每个生成独立 `if (IsNear(ForgeWorkshop, 2f))` 块。太空捡垃圾项目里 PlayerTripleDrill / CrusherVehicle / HydraulicVehicle / ForgeWorkshop 各重复 2 次 IsNear 检测。
- **改法**：按 target 分组，生成单个 `if (IsNear(target, 2f)) { ... 多资源分支 ... }`。
- **收益**：IsNear 调用次数减半（8 → 4-5/帧）。
- **风险**：中 — 需确保分组后逻辑等价。**必须加单测**：现有 spec-conformance 测试覆盖；新增 resource-flow 专用单测。

#### T2-2: scoreText.text 去每帧 string 拼接
- **修改**：`adapters/templates/resource-flow.cjs` L45 + `interactions/score-display.cjs`
- **现状问题**：靠近 source 每帧触发 `MetalShardCarried++` + `scoreText.text = "MetalShard: " + n + "/10"`。**更严重的是前半截 `MetalShardCarried++` 每帧 +1 无冷却**，60fps 下 1/6 秒就装满 10 个 —— 这是**逻辑 bug，不是性能**。
- **改法**：
  1. 加收集冷却：`if (collectCooldown > 0) { collectCooldown -= Time.deltaTime; return; }` + 收集后 `collectCooldown = 0.3f;`
  2. scoreText.text 仅在数值变化时赋值：`if (_lastShardCount != n) { scoreText.text = ...; _lastShardCount = n; }`
- **收益**：彻底消除 hot path string alloc + 修复逻辑 bug。
- **风险**：中高 — 收集节奏变化会影响 CUA 和玩家手感。需要 CUA 回归测试。**建议和 T2-3 一起做，一次性回归**。

#### T2-3: collect cooldown 常量提取到 schema
- **修改**：`adapters/schema/game-schema.json` gameConfig 加 `collectCooldown: 0.3`
- **依赖**：T2-2
- **收益**：可调参数，不同游戏可配。

---

### 🟢 Tier 3：建议做（防回归，静态规则）

#### T3-1: 新增 blocking 规则 `update-new-vector-in-hot-path`
- **修改**：`engine/static-check.cjs`
- **检测**：`Update()` / `MovePlayer()` / `AutoPlayUpdate()` / `CheckEventRules()` 方法体内出现 `new Vector[234]\s*\(`（排除 `Vector3.zero` / `Vector3.one` 这类 static readonly）
- **策略**：blocking=true（codegen 返工），因为一旦 AI 学到坏样板就污染后续项目
- **例外**：skeleton 自己的 MovePlayer/PlaceObj 在重构后已消除，不豁免
- **风险**：低，但需在 skeleton 改完后才能启用，否则 skeleton 自身触发规则

#### T3-2: 新增 warn 规则 `chained-if-same-var-no-else`
- **修改**：`engine/static-check.cjs`
- **检测**：连续 ≥3 个 `if (X == "..."` 且 X 相同、无 `else if`/`else` 介入 → warn
- **策略**：non-blocking，注入 feedback 给 fix-loop：「建议改 switch 或 else if」
- **风险**：低，warn 级不阻断

#### T3-3: 新增 warn 规则 `string-concat-in-update`
- **修改**：`engine/static-check.cjs`
- **检测**：Update 方法体内 `\.text\s*=\s*"[^"]*"\s*\+` 模式
- **策略**：non-blocking warn
- **风险**：中 — 可能误报合法场景（如 score 变化时更新），需配合「仅数值变化时赋值」规则引导

---

### ⚪ Tier 4：不建议做（边际收益低或风险高）

#### T4-1: ~~把 Quaternion.LookRotation 改成手写 matrix~~
- **否决理由**：Bridge.NET 下 Quaternion 有内部 pool，收益可忽略；手写 matrix 容易出错

#### T4-2: ~~把 Vector3.Distance 全部替换成 sqrMagnitude（全局 sed）~~
- **否决理由**：skeleton 之外的 GFM_Tools.cs 是 canonical library，已在 static-check 排除名单。只改 skeleton MovePlayer/IsNear 即可

#### T4-3: ~~升级分支（Update L761-785）改 switch~~
- **否决理由**：只有 3 个分支，收益小；且这是 AI 在 TODO_CUSTOM 生成的用户自定义逻辑，不是模板固定输出 —— 改 AI 行为靠 prompt 或 T3 静态规则反馈更合适

#### T4-4: ~~GameObject.Find in AutoPlayUpdate 缓存~~
- **否决理由**：autoplay 模式下 target 切换时才 Find，且 Luna 测试时都在这模式；interactive 模式下根本不走这分支。**但**：加一行 `if (_lastAutoIdx != _autoTargetIdx) { _cachedTarget = Find(...); _lastAutoIdx = _autoTargetIdx; }` 基本无风险。**边界案例**：可以做，放 Tier 2。先不动。

#### T4-5: ~~对象池加到所有 spawn 路径~~
- **否决理由**：Luna 已经强制全部 pre-baked pool 对象（static-check 规则 `instantiate` + `add-component` blocking）。不存在真 Instantiate 路径，对象池已经是默认设定

---

## 非目标（out of scope）

1. **运行时 profiling 工具集成**：没有 WebGL profile harness，暂不建
2. **Auto-fix recipe for 性能**：性能不是 CUA 失败的直接诱因（CUA 跑 5x 速度不测 fps），不进 L5/L6 auto-fix 循环
3. **复杂度预算加入 "new Vector3" 维度**：complexity-gate 是阻断 AI 写太多代码的门，不是审核代码质量的门。质量靠 static-check
4. **改 GFM_Tools.cs 内部的 new Vector3**：canonical 库，已在 static-check 排除，且不在 Update hot path（多在 Init 里）

---

## 验证计划

### 改前基准（在修改任何文件前采集）
1. `grep -c "new Vector3" server-data/project-sources/proj_1776391516726_urbib0/*.cs` → 记录数字
2. 构建 proj 产物后 `grep -c "new\s*Vector3" <built-js>` → 记录
3. 手工跑 Luna 构建，记录 `iframe.html` 载入到 phase 1 稳定时的 FPS（DevTools Performance tab）

### 改后验证
1. **单测**：每个模板改动必须有对应单测（resource-flow 分组、template-engine `else if`、skeleton PlaceObj）
2. **回归**：`npx jest --no-coverage` 全绿（当前 81 tests）
3. **端到端**：重跑太空捡垃圾 blueprint，通过 CUA 5 轮
4. **产物 grep**：改后生成的 C# `new Vector3` 数量应降 ≥60%（预期从 Main.cs 的 ~15 处降到 ~5 处，大部分是剩余的 Color/Vector2 UI 初始化）
5. **FPS**：同场景 Luna 预览 FPS 观察（主观，非硬指标）

### 回滚策略
全部改动对应 git commit 独立，任何一项回归 CUA 失败率则单独 revert，不影响其他项。

---

## 执行顺序建议

推荐**两批次**推进，降低回归风险：

### Batch 1（纯模板改写，逻辑等价）
1. T1-3（autoplay-mirror else if）
2. T1-4（template-engine else if）
3. T1-5（IsNear 分量计算）
4. T1-1（PlaceObj/HideObj/SetScale struct copy）
5. T1-2（MovePlayer buf 复用）
6. Batch 1 结束后：`npx jest` 全绿 + 跑一次太空捡垃圾端到端

### Batch 2（逻辑变化，需 CUA 回归）
7. T2-1（resource-flow IsNear 合并）
8. T2-2 + T2-3（collect cooldown + scoreText 变化时赋值）
9. Batch 2 结束后：跑两次端到端（同项目 + 另一成功项目 xrbkl1 或 最新的 urbib0）

### Batch 3（静态规则，防回归）
10. T3-1（new-vector-in-hot-path blocking）— Batch 1 完成后再启用
11. T3-2（chained-if warn）
12. T3-3（string-concat warn）

---

## 待用户确认的开放问题

1. **Batch 粒度**：接受三批次推进，还是要一次性全做？
2. **T2-2 collect cooldown**：0.3s 是否合理？影响 CUA 5x 速度下的 phase 过渡
3. **T3-1 严格度**：blocking 还是 warn？blocking 可能误杀 AI 正常写的 Color/Vector2 字面量
4. **要不要跑 Batch 1 的 FPS 基准对比**，还是仅看产物 `new Vector3` 计数就行？
5. **静态规则 T3-1 豁免列表**：是否豁免 `Vector3.zero`/`Vector3.one`/`Vector2`/`Color`？

确认后我写实现 plan。
