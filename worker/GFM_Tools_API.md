# GFM_Tools.cs — 试玩广告工具类库 API 文档

> **文件位置**：`D:\worker-repo\worker\GFM_Tools.cs`（Worker ECS）
> **本地副本**：`workspace/GFM_Tools.cs`
> **GitHub**：`soyooAiTools/blueprint` → `worker/GFM_Tools.cs`
> **用途**：AI 编码时自动注入项目，提供标准化工具类，所有类 `GFM_` 前缀防止命名冲突

---

## GFM_Audio — 音频管理
```csharp
GFM_Audio.Init(gameObject);              // 初始化（Start 里调一次）
GFM_Audio.instance.PlayBGM(clip);        // 播放背景音乐（循环）
GFM_Audio.instance.StopBGM();            // 停止背景音乐
GFM_Audio.instance.PlaySFX(clip);        // 播放音效（一次性）
GFM_Audio.instance.PlayPitch(clip, idx); // 音阶播放
GFM_Audio.instance.SetMute(true/false);  // 静音/取消静音
```

## GFM_Pool — 通用对象池
```csharp
GFM_Pool.Init(gameObject);               // 初始化
GFM_Pool.instance.Preload(prefab, 10);   // 预创建 10 个
var obj = GFM_Pool.Get(prefab);          // 从池中获取
GFM_Pool.Return(obj);                    // 归还到池
GFM_Pool.ReturnAfter(obj, 2f);          // 2 秒后自动归还
```

## GFM_Event — 事件系统
```csharp
GFM_Event.Init(gameObject);              // 初始化
GFM_Event.Subscribe(1001, handler);      // 订阅事件
GFM_Event.Unsubscribe(1001, handler);    // 取消订阅
GFM_Event.Fire(1001, sender, "data");    // 触发事件（下一帧执行）
GFM_Event.FireNow(1001, sender, "data"); // 立即触发
GFM_Event.Clear();                       // 清除所有订阅

// handler 签名：
void OnEvent(object sender, string data) { }
```

## GFM_Utils — 通用工具方法
```csharp
GFM_Utils.IsInRange(2f, posA, posB, true);           // 两点距离 < 2（含Y轴）
GFM_Utils.IsOnScreen(transform);                      // 物体是否在屏幕内
GFM_Utils.IsPlayingAnim(animator, "Run");             // 动画是否在播放
GFM_Utils.RectsOverlap(min1, max1, min2, max2);      // 两个矩形是否重叠
GFM_Utils.WorldToUI(worldPos, canvasRect);            // 世界坐标转 UI 坐标
GFM_Utils.UpdateOffScreenIndicator(target, indicator, cam); // 屏幕边缘指示器
GFM_Utils.FindClosestByTag(origin, "Enemy", 50f);    // 根据 Tag 找最近物体
GFM_Utils.FindClosestInList(list, origin);            // 列表中找最近物体
GFM_Utils.GenerateCirclePositions(rings, pts, step, inc); // 生成圆环点位
GFM_Utils.SetNumberDisplay(parent, numSprites, 123); // 数字精灵显示
```

## GFM_Joystick — 虚拟摇杆
```csharp
var joystick = GFM_Joystick.Create(canvas, 200f);    // 创建摇杆（左下角）
float h = joystick.Horizontal;                        // -1 ~ 1
float v = joystick.Vertical;                          // -1 ~ 1
Vector2 dir = joystick.Direction;                     // 归一化方向
bool moving = joystick.IsDragging;                    // 是否在拖拽
```

## GFM_Luna — Luna 生命周期管理
```csharp
GFM_Luna.Init(gameObject);    // 初始化（默认静音，首次触摸开声）
GFM_Luna.GameOver();           // 游戏结束
GFM_Luna.GotoStore();          // 跳转商店（安装完整游戏）
GFM_Luna.IsGameOver();         // 是否已结束
```

## GFM_UI — UI 创建工具
```csharp
var canvas = GFM_UI.CreateCanvas(1080, 1920);                              // 全屏 Canvas
var btn = GFM_UI.CreateButton(canvas, "Play", pos, size, onClick);         // 按钮
var txt = GFM_UI.CreateText(canvas, "Score: 0", pos, 32);                  // 文字标签
GFM_UI.AddWorldLabel(targetObj, "Enemy", 1.5f);                            // 3D 物体上方标签
var bar = GFM_UI.CreateProgressBar(canvas, pos, size, Color.green);        // 进度条（bar.value = 0.5f）
```

## GFM_Create — 3D 物体快捷创建
```csharp
GFM_Create.InitMaterialFromScene();                                        // 从场景获取基础材质
GFM_Create.SetBaseMaterial(mat);                                           // 手动设置材质
var cube = GFM_Create.Obj(PrimitiveType.Cube, pos, scale, "Building");    // 创建带标签的物体
var ground = GFM_Create.Ground(50, 50);                                    // 创建地面
GFM_Create.SetColor(obj, new Color(0.5f, 0.5f, 0.5f));                   // 设置颜色
```

## GFM_Pathfinding — A* 寻路系统
```csharp
// 创建网格
var grid = new GFM_Grid(20, 20, 1f, Vector3.zero);   // 20x20 网格，格大小 1，起点原点

// 设置障碍
grid.SetWalkable(5, 5, false);                         // 单格
grid.SetWalkableRect(3, 3, 8, 8, false);              // 矩形区域
grid.SetWalkableByWorldPos(new Vector3(5,0,5), false); // 世界坐标
grid.DetectObstacles(layerMask, 10f);                  // 射线自动检测障碍

// 寻路
List<Vector3> path = GFM_Pathfinding.FindPath(grid, startPos, endPos); // 返回路径点列表（null=无法到达）
path = GFM_Pathfinding.SimplifyPath(path);                              // 简化路径（去共线点）

// 移动（Update 中调用）
transform.position = GFM_Pathfinding.MoveAlongPath(path, ref pathIndex, transform.position, speed * Time.deltaTime);

// 配置
GFM_Pathfinding.allowDiagonal = false;                 // 只走四方向（默认允许对角线）
GFM_Pathfinding.maxSteps = 6000;                       // 最大搜索步数

// 辅助
GFM_GridNode nearest = grid.FindNearestWalkable(pos);  // 找最近可通行格
GFM_GridNode node = grid.GetNodeFromWorldPos(pos);     // 世界坐标转网格节点
Vector3 wp = grid.NodeToWorldPos(node);                // 网格节点转世界坐标
```

---

## Luna 兼容性注意事项
- 无泛型（MonoSingleton 泛型已移除）
- 无 Coroutine
- 无 C# 7.0+ 语法（no pattern matching, no tuples）
- 无 LINQ
- 无 ScriptableObject 依赖
- 无 Odin Inspector 依赖
- 所有类 `GFM_` 前缀，永不与 AI 代码冲突

## 文件结构
```
GFM_Tools.cs (999 lines)
├── GFM_Audio          (音频管理)
├── GFM_Pool           (对象池)
├── GFM_ReturnTimer    (对象池自动归还计时器，内部使用)
├── GFM_Event          (事件系统)
├── GFM_Utils          (通用工具 — static)
├── GFM_Joystick       (虚拟摇杆)
├── GFM_Luna           (Luna 生命周期)
├── GFM_UI             (UI 创建 — static)
├── GFM_Create         (3D 物体创建 — static)
├── GFM_GridNode       (A* 节点)
├── GFM_Grid           (A* 网格)
└── GFM_Pathfinding    (A* 寻路 — static)
```
