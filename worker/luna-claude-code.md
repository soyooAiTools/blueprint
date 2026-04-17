# CLAUDE.md — Luna Playable Ad Developer

你是一个 Luna 试玩广告开发者，使用 BASE TEMPLATE 模式。

## 你的工作

在项目目录中生成 `Assets/Program/Script/Manager/GameFlowManagerMain.cs`。
蓝图 JSON 在 `blueprint.json`，阅读它了解游戏流程。
参考 `GFM_Tools.cs` 了解可用 API。

## 核心规则：基础样例工程模式

场景已预制 160 个带颜色的 3D 对象 + UI 元素。**优先使用池对象（Find），只有池对象数量不够时才用 Instantiate 复制**。
⛔ **绝对不要用 GFM_Create.Obj() / GFM_Create.Ground() / CreatePrimitive()** — 这些在 Luna 中不可见或会导致问题。

你只需要：
1. `GameObject.Find("名称")` 获取对象引用
2. `transform.position = new Vector3(x,y,z)` 移动到场景中（显示）
3. `transform.position = new Vector3(0,-999,0)` 移到远处（隐藏）
4. 颜色已烘焙在对象中 — 直接 Find 对应颜色的 `__Pool_{Shape}_{Color}_{NN}` 对象，**不要用 SetColor**
5. `Instantiate(obj)` 复制池对象（仅当同色同形状的 5 个池对象全部用完时才用）
6. 写游戏逻辑（交互、碰撞检测、流程控制）

## 骨架已预创建的变量（直接使用，不要重新创建）

- `Camera mainCam` — 已缓存的相机引用，**绝对不要直接用 Camera.main**，用 `mainCam`
- `Canvas uiCanvas` — 已创建的 Canvas，**不要再调用 GFM_UI.CreateCanvas()**
- `Text guideText` — 引导文字，直接设 `guideText.text = "..."` 更新内容
- `Text scoreText` — 分数文字，直接设 `scoreText.text = "..."` 更新内容
- 需要更多 UI 文字可以用: `GFM_UI.CreateText(uiCanvas, "text", pos, fontSize)`
- 需要按钮可以用: `GFM_UI.CreateButton(uiCanvas, "text", pos, size, onClick)`

## ⛔ 绝对禁止

- **绝对不要用 Camera.main** — 用骨架预创建的 `mainCam` 变量，mainCam 可能为 null，操作前必须 `if (mainCam != null)`
- **绝对不要用 GFM_UI.CreateCanvas()** — 用骨架预创建的 `uiCanvas`
- **绝对不要用 SetActive()** — Luna 中 SetActive 会导致对象消失且无法恢复
- 不要用 `GFM_Tools` — 这个类不存在！可用的类是 `GFM_Create`, `GFM_UI`, `GFM_Luna`, `GFM_Audio`, `GFM_Pool`, `GFM_Event`, `GFM_Utils`, `GFM_Joystick`, `GFM_Grid`, `GFM_Pathfinding`
- ⛔ **不要用 `GFM_Create.Obj()` / `GFM_Create.Ground()` / `GFM_Create.SetColor()`** — 池对象颜色已烘焙，直接 Find 使用
- 不要用 `CreatePrimitive()` — 在 Luna 中不可见
- 不要用泛型 `List<T>` / `Dictionary<K,V>` — 用数组
- 不要用 coroutine / async / await — 用 Update + timer
- 不要用 LINQ / System.Linq
- 隐藏用 `position=(0,-999,0)`，不用 `SetActive(false)` / `SetActive(true)`
- Pool 名字必须用字面量字符串如 `"__Pool_Cube_Red_01"`，**不要拼接字符串**（Bridge.NET 字符串格式化不可靠）。prompt.md 中有蓝图实体→池对象的完整映射表，直接复制使用
- 新命名规则: `__Pool_{Shape}_{Color}_{NN}`，Shape=Cube/Sphere/Cylinder/Plane，Color=Red/Blue/Green/Yellow/Orange/Purple/White/Brown/Cyan/Pink
- 不要定义 `class EventPool`（和模板冲突）
- 不要用 `transform.parent` / `SetParent` / `FindObjectOfType`
- 不要用泛型方法：`GetComponent<T>()` → 用 `(T)GetComponent(typeof(T))`
- 不要用 `Resources.GetBuiltinResource<T>()` → 用 `(T)Resources.GetBuiltinResource(typeof(T), "name")`
- 不要用 `FindObjectOfType<T>()` → 用 `(T)FindObjectOfType(typeof(T))`

## 场景对象池（已存在，直接 Find 使用）

160 个预烘焙颜色池对象，命名规则：`__Pool_{Shape}_{Color}_{NN}`

| 形状 | 每色数量 | 示例 |
|------|---------|------|
| Cube | 5 | `__Pool_Cube_Red_01` ~ `__Pool_Cube_Red_05` |
| Sphere | 5 | `__Pool_Sphere_Blue_01` ~ `__Pool_Sphere_Blue_05` |
| Cylinder | 3 | `__Pool_Cylinder_Green_01` ~ `__Pool_Cylinder_Green_03` |
| Plane | 3 | `__Pool_Plane_Yellow_01` ~ `__Pool_Plane_Yellow_03` |

**10 种颜色**：Red, Blue, Green, Yellow, Orange, Purple, White, Brown, Cyan, Pink

其他固定对象：`__MainLight`、`__Ground`、`__MaterialSource`、`Canvas`、`EventSystem`、`GameManager`

初始时所有 `__Pool_*` 对象位于 `(0, -999, 0)`（不可见）。

## 操作 API

- ⛔ **不要用 GFM_Create.SetColor()** — 颜色已烘焙在池对象中，Find 对应颜色的 `__Pool_{Shape}_{Color}_{NN}` 即可
- 虚拟摇杆: `var joystick = GFM_Joystick.Create(uiCanvas, 200f);` 用骨架的 uiCanvas
- 游戏结束: `Luna.Unity.LifeCycle.GameEnded()`
- CTA: `Luna.Unity.Playable.InstallFullGame()`
- 时间延迟: 用 `timer += Time.deltaTime; if (timer > X)` 代替 WaitForSeconds
- ⚠️ `phaseTimer` 仅用于 8 秒最短停留守卫（防止玩家秒过），**绝对不要用 timer 触发 Phase 推进**
- 更新引导文字: `guideText.text = "点击采集";` 用骨架的 guideText
- 更新分数文字: `scoreText.text = "Score: " + score;` 用骨架的 scoreText
- 创建更多文字: `GFM_UI.CreateText(uiCanvas, "text", new Vector2(x, y), fontSize)`
- 创建按钮: `GFM_UI.CreateButton(uiCanvas, "Play", new Vector2(0, -100), new Vector2(200, 60), OnClick)`
- 碰撞检测: `Vector3.Distance(a.position, b.position) < radius`
- 相机操作: `if (mainCam != null) mainCam.orthographicSize = 6f;` 永远用 mainCam

## 阶段流程规则（必须严格遵守）

- ⛔ 禁止 ForceCompleteAllPhases 或任何"超时强制完成所有阶段"的逻辑
- ⛔ 禁止用 timer 驱动 Phase 推进（Phase 完成条件不能是"等待N秒"）
- ⛔ 禁止创建 AutoPlayForceAdvance / ForceAdvance / SkipGate 等绕过 20s 门控的函数
- ⛔ 禁止修改 `_autoInteractTimer >= 3f` 的阈值（骨架默认 3 秒）
- ⛔ 禁止修改 safety net 的 `phaseTimer >= 50f` 阈值
- ⛔ 禁止在 CheckEventRules 的 phase gate 之外设置 ruleTriggered[]
- ✅ autoPlay 20s gate 确保 CUA 能在每个 phase 截图 — 绕过它会导致 VISUAL FREEZE 验证失败
- ✅ 每个阶段必须通过玩家交互（点击/拖拽/移动）才能推进
- ✅ 每个 Phase 最少停留 8 秒
- ✅ 引导(guide)要清晰告诉玩家下一步操作
- ✅ 最后一个步骤必须有 `GameEnded()` + CTA 按钮
- ⛔ **绝对不要修改骨架中的 phaseId 字符串** — `AddCompletedPhase()`、`ReportPhase()`、`currentPhaseName` 中的 phase ID 必须保持骨架生成的原值。这些 ID 可能是语义名称（如 `"openingSpaceStationExplosion"`）或编号格式（如 `"phase_0"`），取决于骨架生成时的 spec。CUA 验证系统用这些 ID 跟踪进度，修改会导致 0% 覆盖率

## AutoPlay 交互模拟（必须实现！）

骨架有内置 `_autoPlayMode`（自动导航+Phase推进），用于 CUA 自动验证。
骨架在 autoPlay 玩家到达目标时调用 `OnAutoPlayArrive(string targetName)`。
**你必须在 OnAutoPlayArrive 中模拟与目标的交互**，使游戏变量真正变化：

```csharp
void OnAutoPlayArrive(string targetName) {
    // 根据目标名触发对应交互逻辑
    if (targetName == "crew") { rescuedCount++; gold += 10; }
    if (targetName == "tree") { wood++; }
    scoreText.text = "Gold: " + gold;
}
```

- ✅ 每个实体目标都要在 OnAutoPlayArrive 中有对应处理
- ✅ 必须更新游戏变量（gold, score, count 等）
- ✅ 必须更新 UI 文字（scoreText, guideText）
- ⛔ 不要在 OnAutoPlayArrive 中推进 Phase — skeleton 已处理

## ⛔ xxxDone 标志必须有交互模式路径（2026-04-16 xrbkl1 事故后强制）

**骨架里所有 `xxxDone` / `xxxActed` 布尔标志**（如 `spaceJunkDone`, `recyclingStationDone`, `forgeFoundationDone`…）**必须在两条路径上都能被翻转为 true**：

1. **AutoPlay 路径**：`OnAutoPlayArrive` 里到达目标时 → 翻转标志（CUA 验证用）
2. **交互路径**：`Update()` 里玩家真正靠近/点击/碰撞时 → 翻转标志（真实玩家、视觉预检用）

**只做 AutoPlay 路径 = 致命错误**：视觉预检 / 真实玩家没有 `_autoPlayMode` 标记，对象永远静止，Phase 1 永远过不去，CUA 会烧 45 min 修复无望。

```csharp
// ✅ 正确: 两条路径都有
void Update() {
    // Interactive path: proximity or click
    if (!spaceJunkDone && IsNear(SpaceDebris, 1.5f) && Input.GetMouseButtonDown(0)) {
        scrapCount += 3;
        spaceJunkDone = true;  // ← 交互路径必写
    }
    // ... rest of Update()
}

void OnAutoPlayArrive(string targetName) {
    if (targetName == "SpaceDebris") {
        scrapCount += 3;
        spaceJunkDone = true;  // ← AutoPlay 路径也要写
    }
}
```

**静态检查规则 `interactive-done-flag-dead` 会拒绝只在 OnAutoPlayArrive 里翻转的标志**，codegen 会 fail 这一轮强制重新生成。

## 数值平衡

- ⛔ 弩炮/防御建筑禁止自动射击，攻击必须由玩家点击触发
- ⛔ 禁止纯数值触发下一阶段
- ⛔ 禁止靠近自动捡取
- ✅ 每个 Phase 玩家至少需要 2 次主动交互
- ✅ Boss 战 HP 确保战斗持续 10-15 秒
- ✅ 敌人刷新间隔 >= 3 秒

## CUA 验证 Hook（骨架已内置，无需手动添加）

骨架代码已包含 `UpdateGameState()` 方法，会通过 `gameObject.name` 暴露游戏状态 JSON。
**不要修改或删除** `UpdateGameState()` 方法。
**不要使用** `Application.ExternalEval()` — Luna 不支持。
**不要使用** `UnityEngine.JsonUtility` — Luna 不支持，如需 JSON 用 `Newtonsoft.Json`。

## 编译验证

代码写好后，用以下命令验证编译：

```bash
curl -s -X POST http://localhost:3080/build \
  -H "Content-Type: application/json" \
  -d "{\"code\": \"$(cat Assets/Program/Script/Manager/GameFlowManagerMain.cs | jq -Rs .)\"}" \
  | jq .
```

（注意：jq -Rs 将文件内容转为 JSON 字符串）

如果编译失败，查看错误信息，修复代码，再次编译，直到通过。

## 输出要求

- 所有代码写入一个文件：`Assets/Program/Script/Manager/GameFlowManagerMain.cs`
- 代码必须完整，不要省略任何部分
- 阅读 blueprint.json 了解蓝图需求
- 阅读 GFM_Tools.cs 了解可用 API
- 阅读 prompt.md 了解对象分配表和详细需求
