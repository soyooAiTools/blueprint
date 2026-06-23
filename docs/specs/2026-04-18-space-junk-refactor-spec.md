# 太空捡垃圾 2026-04-18 Pipeline 重跑改造 Spec

> 状态：历史复盘文档，已被 2026-06-23 gmp-v14 legacy / unitycomponent-v1 双 profile 程序员交付口径取代。本文中的直接 `GameObject.Find("__Pool_*")`、旧 pool manifest、ScriptActivator/GameSceneCtrl 方案只用于解释当时问题，不是当前 prompt 或最终 Unity 交付约束。当前默认 `gmp-v14` legacy 交付以 AIBridge/Editor hydration、`GMP_SceneEntityRefs` / serialized refs、`GMP_Pool` 和 Core/Tool/Game 三层为准；显式 `unitycomponent-v1` 交付以 UnityComponent(3) 原生 `Assets/SLGFrameWork/Scripts/{Base,Component,Entity,Manager,Prefab}`、`Entity` / `BaseComponent` / `EntityManager` / `GameEntry`、UnityDeliverySpec 和 v1 hardgate 为准；HTML/WebGL 一致性红线仍不可改写。

## 摘要

把 `proj_1776391516726_urbib0`(太空捡垃圾)重新跑一遍 pipeline,用今日(2026-04-18)所有新规则+模板重生成 C#,**不改 blueprint 本身**,只验证今日改造的回归收益。

**成功判据**:
1. CUA 一次性通过(上次烧到 round 6 才过)
2. AI fill 比例 < 20%(现在 `TODO_CUSTOM` 里有 ~200 行手写逻辑,应该被 resource-flow + upgrade-logic + cost-gated-click + multi-source-collect 模板替代)
3. 零 `__Pool_Building_*` / `__Pool_Ship_*` / `__Pool_Vehicle_*` 错误引用(3B 只有 `Cube/Sphere/Cylinder/Plane × 10 色 × 4`)
4. 零 `Resources.GetBuiltinResource` 调用(被 `builtin-resource` blocking 规则拦截)
5. C# 行数 < 900 行(现在 1410 行,去除冗余后目标 850-900 行)

---

## 1. 当前状态(2026-04-17 生成,已保存到 project-sources)

| 项 | 值 |
|---|---|
| status | reviewing(CUA round 6 通过) |
| 生成时间 | 2026-04-17T07:37Z(failure=review aborted,但最终 08:41 build 完成) |
| GameFlowManagerMain.cs | 1410 行 |
| GameFlowManagerMain.Systems.cs | 22 行 |
| GFM_Tools.cs | 1218 行(**旧版 monolithic**,今日已拆 11 文件) |
| phase 数 | 11 |
| entity 数 | 20 |

---

## 2. 违反今日规则的具体点(调研结果)

### 2.1 Pool 对象命名不匹配新 manifest 🔴

**违反**:3B 新 pool manifest = `Cube/Sphere/Cylinder/Plane × 10 色 × 4 份 = 160 个`。

现有代码里非法引用(来自 GameFlowManagerMain.cs:506-531):
```csharp
RecyclingStation = GameObject.Find("__Pool_Building_Blue_01");  // ❌ 没有 Building 形状
PlayerSingleDrill = GameObject.Find("__Pool_Ship_Yellow_01");   // ❌ 没有 Ship 形状
CrusherVehicle = GameObject.Find("__Pool_Vehicle_Orange_01");   // ❌ 没有 Vehicle 形状
SpaceJunk = GameObject.Find("__Pool_Cube_Gray_01");              // ❌ 没有 Gray 颜色
```

**新 pool 10 色**:Red/Blue/Green/Yellow/Orange/Purple/Cyan/Pink/White/Brown。  
**修复**:entity→pool 映射全部重排,必须落在合法 `Cube/Sphere/Cylinder/Plane × 上述10色` 交叉集内。

### 2.2 完全没用 ScriptActivator 🟡

**违反**:Phase 3A 预烘焙 160 个 `ScriptActivator` 组件,AI 代码应调 `GetComponent<ScriptActivator>().Activate(role, behavior, ...)` 让 SpaceJunk 漂浮/旋转、PlayerDrill 绕目标轨道,不用手写 Update 里的 transform 操作。

**现状**:0 次 ScriptActivator 调用。Update 里的移动全靠 skeleton 的 `MovePlayer()`(joystick driven)。视觉呆板。

**建议**:非必需,但推荐给 `SpaceJunk/SpaceJunk2/SpaceJunk3` 加 `behavior="bob"`(上下浮动)提升视觉,CUA 截图唯一性也更好。

### 2.3 用 monolithic GFM_Tools.cs 🟡

**违反**:今日拆成 11 个 GFM_*.cs + ScriptActivator + GameSceneCtrl,由 `worker/gfm-files.cjs` 统一 copy 到 `Assets/Program/Script/Commons/`。

**现状**:项目源码归档里还是 1218 行的老 GFM_Tools.cs(向后兼容保留,不影响新 build)。

**修复**:重跑时自动走新 copy 流程,归档会更新。

### 2.4 AI 手写代码量过大 🔴(主要收益点)

现有 `TODO_CUSTOM` 段(GameFlowManagerMain.cs:591-890 约 300 行)手写实现了:

| 手写片段 | 行数 | 今日可替换模板 |
|---|---|---|
| TODO_CUSTOM_1: SpaceJunk 采集 3 处 IsNear+AddResource | ~30 | `multi-source-collect.cjs`(已识别 SpaceJunk/SpaceJunk2/SpaceJunk3 同类) |
| TODO_CUSTOM_2: 库存满 guide text | ~6 | `inventory-feedback.cjs` |
| TODO_CUSTOM_3: 出售换金 | ~12 | `deliver-sell.cjs` |
| TODO_CUSTOM_4: 花金升级(ForgeWorkshop→TripleDrill→CrusherVehicle→HydraulicVehicle) | ~30 | `cost-gated-click.cjs` + `upgrade-logic.cjs` |
| TODO_CUSTOM_5: 形态切换 | ~25 | `form-auto-switch.cjs`(基于 State==2 自动 SwitchForm) |
| TODO_CUSTOM_6-9: 其他资源/分数/CTA | ~80 | `score-display.cjs` + `cta-handler.cjs` |
| TODO_CUSTOM_10: 建筑建造(Canteen/Dorm/Pasture) | ~60 | `cost-gated-click.cjs` × 3 实例化 |
| AutoPlay mirror(每 phase 一套 IsNear+action+Done) | ~80 | `autoplay-mirror.cjs`(已是模板,但 AI 重写了) |

**目标**:TODO_CUSTOM 代码量 300 → 30-50 行,剩下的全让模板引擎产出。

### 2.5 Font 加载无风险 ✅

现有 1410 行未出现 `Resources.GetBuiltinResource`;skeleton 本来就不生成。
新 blocking 规则 `builtin-resource`(static-check.cjs:41)兜底即可。

### 2.6 Done 标志双路径 ✅

skeleton 已在 Update 的 mouse down 分支里做了 xxxDone/xxxActed 翻转(行 577-588),符合 `interactive-done-flag-dead` blocking 规则。不用改。

---

## 3. 改造策略(不改 blueprint,只重跑)

### 3.1 流程

```
1. 前端项目列表 → 找到"太空捡垃圾" → 触发 "重新编码" 按钮(走 POST /api/projects/:id/feedback,feedback="重跑")
   或 直接改 status 为 submitted,让 worker pull 走新 pipeline
2. Pipeline 自动:
   - stage spec-validate → 用新 5 层实体名级联(phase-context 消歧)
   - stage complexity-gate → 算分 expected ≤200(11 phase=110 + 3 formSwitch=45 + 1 control=40 = 195)✅
   - stage codegen-schema → Haiku 生成 JSON game schema
   - stage codegen-template → 8 interaction + 12 NPC + resource-flow + upgrade-logic 填模板
   - stage codegen-legacy → Opus 只填剩下的 TODO_CUSTOM(目标 <50 行)
   - stage method-check → 扫 Update/CheckEventRules 调用
   - stage review → Codex GPT-5.4
   - stage compile → 编译修复最多 10 轮
   - stage build → Luna 7.1.0 构建
   - stage cua-verify → ~132s autoPlay,5 phases 用 5x 速度,11 phases 用 2x + 20s gate
3. 构建成功 → 自动进 reviewing → 同时视觉审核
```

### 3.2 触发方式

**最安全(推荐)**:前端走"重新编码"流程,让 feedback 走完整 pipeline。

**直接触发(适合调试)**:
```bash
# 读出当前项目 → 改 status 为 submitted → 下次 worker poll 会接 task
node -e "
const fs=require('fs');
const p='/opt/blueprint-editor/server-data/projects/proj_1776391516726_urbib0.json';
const d=JSON.parse(fs.readFileSync(p));
d.status='submitted';
d.autoCodingTaskId=null;
d.lastFailure=null;
d.failureHistory=(d.failureHistory||[]).slice(0,5); // 保留历史,不清零
fs.writeFileSync(p, JSON.stringify(d,null,2));
console.log('reset to submitted');
"
```

### 3.3 entity→pool 映射表(必须在 blueprint.entities 里刷新)

新 pool manifest 只有 `Cube/Sphere/Cylinder/Plane × Red/Blue/Green/Yellow/Orange/Purple/Cyan/Pink/White/Brown × 4 份`。

| entity | 旧映射 | 新映射(合法) | 理由 |
|---|---|---|---|
| PlayerSingleDrill | Ship_Yellow_01 | **Cube_Yellow_01** | 玩家=黄色立方 |
| PlayerTripleDrill | Ship_Yellow_02 | Cube_Yellow_02 | 同色升级 |
| CrusherVehicle | Vehicle_Orange_01 | Cube_Orange_01 | |
| HydraulicVehicle | Vehicle_Purple_01 | Cube_Purple_01 | |
| SpaceJunk/2/3 | Cube_Gray_01/02/03 | **Sphere_Brown_01/02/03** | 球形+棕色=垃圾感 |
| MetalShard | Cube_Cyan_01 | Cube_Cyan_01 | 已合法 |
| RecyclingStation | Building_Blue_01 | **Cylinder_Blue_01** | 圆柱形塔 |
| ForgeBlueprint/Workshop | Cube_Red_01/02 | Cube_Red_01/02 | 已合法 |
| CanteenBlueprint/Canteen | Cube_Blue_04/Cube_Yellow_01 | Cube_Blue_03/**Plane_Green_01** | Plane=建筑地基 |
| DormBlueprint/Dormitory | Cube_Green_02/Cube_Orange_01 | Cube_Green_01/Plane_Green_02 | |
| PastureBlueprint/Pasture | Cube_Yellow_03/Cube_Purple_01 | Cube_Green_03/Plane_Green_03 | |
| CrusherUpgrade/HydraulicUpgrade | N/A | Cube_White_02/03 | 升级标记 |
| CTAButton | Cube_White_01 | Cube_White_01 | 已合法 |
| GoldUI/GuideUI | N/A(UI,不占 pool) | N/A | |

**实现方式**:adapters/pool-mapper.cjs(如果已存在)自动映射;否则 codegen-schema LLM prompt 里注入 pool manifest allowlist,Haiku 自行选合法 pool。

### 3.4 Spec 无需改动

11 phase specs 在 2026-04-17 已通过 spec-validate。今天 spec-extractor.cjs 又加了 phase-context 消歧(e587069),对 `drill` 这类模糊实体名会更准。不用改 specs。

---

## 4. 验证计划

### 4.1 静态检查(重跑前本地可验证)

```bash
cd /opt/blueprint-editor
node -e "
const { runStaticCheck } = require('./engine/static-check.cjs');
const fs = require('fs');
const src = fs.readFileSync('server-data/project-sources/proj_1776391516726_urbib0/GameFlowManagerMain.cs','utf8');
const r = runStaticCheck(src);
console.log('violations:', r.violations.length);
console.log('blocking:', r.violations.filter(v => v.blocking).length);
r.violations.filter(v => v.blocking).forEach(v => console.log('  BLOCK:', v.ruleId, v.line, v.snippet));
"
```

**预期**:当前旧代码至少命中 `pool-name-typo`(Building/Ship/Vehicle 前缀)若规则覆盖,或无命中但重跑后 pool 映射自动修正。

### 4.2 重跑后 CUA 指标对比

| 指标 | 旧值(2026-04-17) | 目标 |
|---|---|---|
| CUA 轮数 | 6 | ≤2 |
| CUA 总耗时 | ~45min | ≤15min(11 phase × 2x 速度 × 12s = ~132s + buffer) |
| 编译修复轮数 | ? | ≤3 |
| silent-pass 信号 | 未知 | 0 |
| 生成的 C# 总行数 | 1410 | ≤900 |
| TODO_CUSTOM 手写行数 | ~300 | ≤50 |

### 4.3 视觉审核

feedbacksystem sub-agent 评分 ≥85(原 review aborted,这次应该一次过)。

---

## 5. 风险 & 回退

| 风险 | 触发条件 | 回退方案 |
|---|---|---|
| 新 pool manifest 映射失败 | pool-mapper 报错或找不到合法 Cube/Sphere 组合 | 检查 `/opt/luna-base-template/Assets/Scenes/templeteScene.unity` 是否真有 160 个且命名对;不对回到 golden reference `/opt/blueprint-editor/docs/reference-builds/stage4-scriptactivator-verified-20260418.zip` 比对 |
| 模板引擎不认识 multi-source 场景 | codegen-template 漏掉 SpaceJunk2/3 的 collect | 临时回退 codegen-legacy-only 路径(adapters/codegen.cjs 有 fallback) |
| CUA 依然 round 6 失败 | phase tracking 断裂或 visual freeze | 立即停任务,打开 dashboard → failureClassifications,查 failureHistory 对比旧失败指纹 |
| Font 崩溃 | DefaultFont.ttf meta GUID 不对 | 验证 `/opt/luna-base-template/Assets/Resources/DefaultFont.ttf.meta` 存在且 git tracked |

**不改项**(不在本 spec 范围):
- blueprint 节点结构、specs、globalSettings 不动
- skeleton-generator.cjs 不动
- 不引入新模板(8 interaction + 12 NPC + 2 kit 足够覆盖)

---

## 6. 决策点(执行前需用户确认)

1. **pool 映射由谁做**:LLM 自动选还是我手写 entity→pool 表塞进 blueprint.entities?推荐后者(确定性高)。
2. **ScriptActivator 视觉增强**:要不要给 SpaceJunk 加 `behavior="bob"` 动画?推荐要(提升 CUA phase 区分度)。
3. **触发方式**:前端"重新编码"按钮 vs 后端改 status?推荐后端(可控,失败便于调试)。
4. **保留旧归档**:现有 `server-data/project-sources/proj_1776391516726_urbib0/` 是否改名保留为 `*.v1/`?推荐保留以便对比。

---

## 附录 A:今日(2026-04-18)新规则清单(完整列表)

### A.1 静态检查 v7 新增 11 条(static-check.cjs 总 59 条)

| ID | 类型 | 触发 |
|---|---|---|
| `builtin-resource` | BLOCKING | Resources.GetBuiltinResource() |
| `sbyte-type` | BLOCKING | SByte 类型 |
| `navmesh-usage` | BLOCKING | NavMesh/NavMeshAgent |
| `js-class-name-conflict` | BLOCKING | class 名 = Number/JSON/Math/Object/Array/String |
| `new-input-system` | BLOCKING | UnityEngine.InputSystem |
| `input-getkey-mouse` | warn | Input.GetKey(KeyCode.Mouse0) |
| `physics2d-simulate` | warn | Physics2D.Simulate() |
| `ongui-method` | warn | OnGUI() |
| `destructor-syntax` | warn | ~ClassName() |
| `system-math-lib` | warn | System.Math / Unity.Mathematics |
| `scene-buildindex` | warn | GetActiveScene().buildIndex |
| `json-utility` | 修正 | Newtonsoft.Json 不再误判 |

### A.2 新模板(template 引擎覆盖 95%)

- **12 NPC 模板**:patrol / chase_attack / static_target / ranged_shooter / spawner / wander / evade / defend / circle / group_attack / flee_on_hit / boss_multiphase
- **8 交互模板**:collect / deliver-sell / cost-gated-click / inventory-feedback / form-auto-switch / score-display / cta-handler / multi-source-collect
- **2 核心 kit**:resource-flow / upgrade-logic

### A.3 Luna 基准模板重构(Phase 2A/2B/3A/3B)

见 `/root/.openclaw/workspace/skills/blueprint/SKILL.md#luna-基准模板重构2026-04-18`。

### A.4 Pipeline 硬核门控

- complexity-gate(≤200 pass / 201-250 warn / >250 fail+retry3)
- method-check(扫未定义方法,feedback 回 fix-loop)
- spec-validate 5 层实体名级联(exact→ci→substring→phase-context→edit-distance)
- CUA 复杂度自适应(≤8 phase=5x 速度 / >8=2x+20s gate)
- observe_mode 6 层防御(含截图唯一性/phase 顺序/初始污染)
- silent-pass 4 层跨层检测(zero-actions/uniform-timing/phase-order/all-vars-zero)

---

## 附录 B:执行 checklist(待用户 OK 后)

```
[ ] (1) 备份当前 project-sources 到 v1 目录
[ ] (2) 更新 blueprint.entities 的 pool 映射(if 选自己写方案)
[ ] (3) 清零 lastFailure + 保留 failureHistory
[ ] (4) status: reviewing → submitted
[ ] (5) 观察 worker poll 接 task
[ ] (6) 监控 complexity-gate 输出 expected ≤200
[ ] (7) 监控 codegen-template 日志:template 填充率
[ ] (8) 监控 method-check 输出:未定义方法数
[ ] (9) 监控 CUA 轮数:目标 ≤2
[ ] (10) 构建完成后对比新旧 C# 行数 + TODO_CUSTOM 行数
[ ] (11) 视觉审核评分 ≥85
[ ] (12) pass → 更新 memory(记录今日改造数据)
```
