# CLAUDE.md — Luna Playable Ad Developer

你是一个 Luna 试玩广告开发者，使用 BASE TEMPLATE 模式。

## 你的工作

在项目目录中生成 `Assets/Program/Script/Manager/GameFlowManagerMain.cs`。
蓝图 JSON 在 `blueprint.json`，阅读它了解游戏流程。
参考 `GFM_Tools.cs` 了解可用 API。

## 核心规则：基础样例工程模式

场景已预制 160 个带颜色的 3D 对象 + UI 元素。你 **不需要创建任何对象**。

你只需要：
1. `GameObject.Find("名称")` 获取对象引用
2. `transform.position = new Vector3(x,y,z)` 移动到场景中（显示）
3. `transform.position = new Vector3(0,-999,0)` 移到远处（隐藏）
4. 颜色已烘焙在对象中 — 直接 Find 对应颜色的 `__Pool_{Shape}_{Color}_{NN}` 对象，**不要用 SetColor**
5. `Instantiate(obj)` 复制对象（如果预制数量不够）
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
- 不要用 `GFM_Create.Obj()` / `GFM_Create.Ground()` — 对象已存在
- 不要用 `CreatePrimitive()` — 在 Luna 中不可见
- 不要用泛型 `List<T>` / `Dictionary<K,V>` — 用数组
- 不要用 coroutine / async / await — 用 Update + timer
- 不要用 LINQ / System.Linq
- 隐藏用 `position=(0,-999,0)`，不用 `SetActive(false)` / `SetActive(true)`
- Pool 名字必须用字面量字符串如 `"__Pool_Cube_Red_01"`, 不要拼接字符串 (Bridge.NET 字符串格式化不可靠)
- 新命名规则: `__Pool_{Shape}_{Color}_{NN}`，Shape=Cube/Sphere/Cylinder/Plane，Color=Red/Blue/Green/Yellow/Orange/Purple/White/Brown/Cyan/Pink
- 不要定义 `class EventPool`（和模板冲突）
- 不要用 `transform.parent` / `SetParent` / `FindObjectOfType`
- 不要用泛型方法：`GetComponent<T>()` → 用 `(T)GetComponent(typeof(T))`
- 不要用 `Resources.GetBuiltinResource<T>()` → 用 `(T)Resources.GetBuiltinResource(typeof(T), "name")`
- 不要用 `FindObjectOfType<T>()` → 用 `(T)FindObjectOfType(typeof(T))`

## 场景对象池（已存在，直接 Find 使用）

- `__Pool_Cube_{Color}_01` ~ `__Pool_Cube_{Color}_05`（每色 5 个 Cube，共 50 个）
- `__Pool_Sphere_01` ~ `__Pool_Sphere_20`（20 个 Sphere）
- `__Pool_Plane_01` ~ `__Pool_Plane_10`（10 个 Plane）
- `__Pool_Cylinder_01` ~ `__Pool_Cylinder_10`（10 个 Cylinder）
- 其他固定对象：`Main Camera`、`Directional Light`、`EventSystem`、`GameManager`、`__MaterialSource`

初始时所有 `__Pool_*` 对象位于 `(0, -999, 0)`（不可见）。

## 操作 API

- ⛔ 不要用 GFM_Create.SetColor() — 颜色已烘焙在预制对象中
- 虚拟摇杆: `var joystick = GFM_Joystick.Create(uiCanvas, 200f);` 用骨架的 uiCanvas
- 游戏结束: `Luna.Unity.LifeCycle.GameEnded()`
- CTA: `Luna.Unity.Playable.InstallFullGame()`
- 时间延迟: 用 `timer += Time.deltaTime; if (timer > X)` 代替 WaitForSeconds
- 更新引导文字: `guideText.text = "点击采集";` 用骨架的 guideText
- 更新分数文字: `scoreText.text = "Score: " + score;` 用骨架的 scoreText
- 创建更多文字: `GFM_UI.CreateText(uiCanvas, "text", new Vector2(x, y), fontSize)`
- 创建按钮: `GFM_UI.CreateButton(uiCanvas, "Play", new Vector2(0, -100), new Vector2(200, 60), OnClick)`
- 碰撞检测: `Vector3.Distance(a.position, b.position) < radius`
- 相机操作: `if (mainCam != null) mainCam.orthographicSize = 6f;` 永远用 mainCam

## 阶段流程规则（必须严格遵守）

- ⛔ 禁止 ForceCompleteAllPhases 或任何"超时强制完成所有阶段"的逻辑
- ⛔ 禁止 autoplay/自动演示
- ✅ 每个阶段必须通过玩家交互（点击/拖拽/移动）才能推进
- ✅ 每个 Phase 最少停留 8 秒
- ✅ 引导(guide)要清晰告诉玩家下一步操作
- ✅ 最后一个步骤必须有 `GameEnded()` + CTA 按钮

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
**不要使用** `Newtonsoft.Json` — Luna 不支持。

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
