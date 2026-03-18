# 基础样例工程设计文档

> 日期: 2026-03-18 | 状态: 设计确认 | 作者: 小白 + Nick

## 1. 背景与问题

当前 Blueprint 流水线中，AI 每次从零生成全部 C# 代码（创建对象、设材质、配光照、写逻辑），导致：

- **编译失败**：GFM API 参数写错、泛型语法、Luna 不支持的 C# 特性
- **构建黑屏**：CreatePrimitive 不可见、材质 shader 为 null、Update() 不被调用
- **加载卡进度条**：stage4 文件不完整、data.blob 版本不匹配
- **场景为空**：SVN revert 覆盖模板、AI 不用 GFM_Create.Obj
- **颜色丢失**：材质链断裂、内置 shader 不序列化

CUA 修复循环中，这些底层问题反复出现，5 轮修不好 → 任务失败。

## 2. 核心方案

### 2.1 思路

**预制一个"已验证能跑"的 Unity 基础工程**，包含天空盒、光照、~280 个预摆放的 3D 对象。

AI 代码职责从"创建一切 + 写逻辑"收窄为"Find 对象 + 移动/显隐/改色 + 写逻辑"。

```
之前: AI 从零创建 → 编译 → 构建 → 祈祷不崩
之后: 基础工程(已验证) → AI 只写逻辑 → 编译 → 构建 → 稳定产出
```

### 2.2 基础工程内容

#### 环境

- 天空盒: Unity 默认 Skybox
- 光照: Directional Light（不挂自定义脚本）
- 相机: 默认 Main Camera
- `__MaterialSource`: 使用 URP/Lit shader（非 Default-Material）
- Canvas: 预创建，含 ScoreText / HPBar / CTA_Button / ResourcePanel / GuideHand / Timer
- GameFlowManagerMain.cs: 已挂载，Start/Update 已验证能跑

#### 预制对象清单（~280 个）

所有对象初始位置 `y = -999`（不可见），用 GFM_Create.Obj 创建并在编辑器保存。
对象按语义命名，AI 通过 `GameObject.Find("名称")` 获取引用。

**通用**

| 预设名 | 形状 | 颜色 | 数量 |
|--------|------|------|------|
| Player | Cube | 蓝(0.2,0.4,0.9) | 1 |
| Ground | Plane | 棕绿(0.35,0.3,0.15) | 1 |
| Wall_1~10 | Cube(扁长) | 深灰(0.3,0.3,0.3) | 10 |
| Coin_1~15 | Sphere(小) | 金(1,0.85,0) | 15 |
| Gem_1~10 | Sphere(小) | 紫(0.6,0.2,0.8) | 10 |

**SLG/塔防**

| 预设名 | 形状 | 颜色 | 数量 |
|--------|------|------|------|
| Building_1~8 | Cube(大) | 棕(0.85,0.7,0.4) | 8 |
| Turret_1~8 | Cylinder(小) | 灰(0.5,0.5,0.55) | 8 |
| Castle_1~2 | Cube(超大) | 石灰(0.75,0.75,0.7) | 2 |
| Farm_1~5 | Cube(扁) | 浅绿(0.5,0.75,0.3) | 5 |
| Mine_1~5 | Cube | 深棕(0.4,0.25,0.1) | 5 |
| Barracks_1~3 | Cube(中) | 暗红(0.6,0.2,0.2) | 3 |
| Worker_1~8 | Cube(小) | 橙(0.9,0.6,0.2) | 8 |
| Soldier_1~10 | Cube(小) | 军绿(0.3,0.45,0.2) | 10 |
| Archer_1~8 | Cylinder(小) | 棕(0.6,0.35,0.1) | 8 |
| Flag_1~5 | Cylinder(细高) | 红(0.85,0.15,0.15) | 5 |
| Shield_1~5 | Sphere(扁) | 银(0.8,0.8,0.85) | 5 |

**射击/战斗**

| 预设名 | 形状 | 颜色 | 数量 |
|--------|------|------|------|
| Enemy_1~15 | Sphere | 红(0.85,0.15,0.15) | 15 |
| Boss_1~3 | Sphere(大) | 暗红(0.5,0.1,0.1) | 3 |
| Arrow_1~15 | Cube(细长) | 白(0.9,0.9,0.9) | 15 |
| Bullet_1~15 | Sphere(极小) | 黄(1,0.9,0.2) | 15 |
| Bomb_1~8 | Sphere(中) | 黑(0.15,0.15,0.15) | 8 |
| Sword_1~5 | Cube(细长) | 银(0.8,0.8,0.85) | 5 |

**太空**

| 预设名 | 形状 | 颜色 | 数量 |
|--------|------|------|------|
| Spaceship_1~5 | Cube(流线) | 银蓝(0.6,0.7,0.85) | 5 |
| Satellite_1~5 | Sphere+Cube | 银(0.8,0.8,0.8) | 5 |
| Asteroid_1~10 | Sphere(大) | 深灰棕(0.4,0.35,0.3) | 10 |
| SpaceStation_1~2 | Cube(超大) | 白灰(0.85,0.85,0.85) | 2 |
| Planet_1~3 | Sphere(大) | 蓝绿(0.2,0.5,0.7) | 3 |
| Rocket_1~5 | Cylinder(长) | 白红(0.9,0.3,0.2) | 5 |

**装饰/环境**

| 预设名 | 形状 | 颜色 | 数量 |
|--------|------|------|------|
| Tree_1~15 | Cylinder+Sphere | 绿(0.1,0.55,0.1) | 15 |
| Rock_1~10 | Sphere(扁) | 灰(0.5,0.5,0.45) | 10 |
| Bush_1~8 | Sphere(小) | 深绿(0.15,0.4,0.1) | 8 |
| Water_1~3 | Plane | 浅蓝(0.3,0.6,0.9) | 3 |
| Road_1~8 | Cube(扁长) | 灰白(0.65,0.65,0.6) | 8 |
| Bridge_1~3 | Cube(扁长) | 木色(0.6,0.35,0.1) | 3 |

**UI（Canvas 子对象）**

| 预设名 | 类型 | 数量 |
|--------|------|------|
| CTA_Button | Button | 1 |
| ScoreText | Text | 1 |
| HPBar_1~3 | Slider(ProgressBar) | 3 |
| ResourcePanel | Panel | 1 |
| GuideHand | Image | 1 |
| Timer | Text | 1 |

**总计: ~280 个 3D 对象 + 7 个 UI 元素**

### 2.3 AI 代码职责

#### ✅ AI 需要做的

```csharp
// 1. 获取预制对象引用
GameObject player = GameObject.Find("Player");
GameObject enemy1 = GameObject.Find("Enemy_1");

// 2. 移动到指定位置（显示）
player.transform.position = new Vector3(0, 1, 0);

// 3. 隐藏（移回远处）
enemy1.transform.position = new Vector3(0, -999, 0);

// 4. 改颜色
GFM_Create.SetColor(player, new Color(0.2f, 0.4f, 0.9f));

// 5. 复制（需要更多同类时）
GameObject enemy6 = Instantiate(enemy1);
enemy6.name = "Enemy_Extra_1";

// 6. 绑交互逻辑、事件规则、流程控制
// 7. UI 文字更新
// 8. Luna.Unity.LifeCycle.GameEnded() + CTA
```

#### ❌ AI 不再需要做的

- ~~GFM_Create.Obj()~~ — 对象已存在
- ~~GFM_UI.CreateCanvas()~~ — Canvas 已存在
- ~~材质/shader 处理~~ — 已配好
- ~~光照/天空盒设置~~ — 已配好
- ~~GFM_Create.Ground()~~ — Ground 已存在

## 3. 构建流程变化

```
之前:
  SVN update → AI 写全部代码 → 编译(常失败) → Luna 构建 → 常黑屏/卡加载

之后:
  基础工程(SVN, stage1-cache 已缓存)
    → AI 只写 GameFlowManagerMain.cs（逻辑代码）
    → MSBuild 编译（只编译 C#，不重跑 jake stage1）
    → stage4 组装（复用 stage1-cache）
    → 稳定产出 HTML
```

### 关键技术点

1. **stage1-cache 固化**: 基础工程 jake 构建一次后，stage1 目录（assets/meshes/shaders/scenes）永久缓存，后续只跑 stage2-4
2. **SVN revert 安全**: revert 后恢复的是基础场景（有内容），不是空模板
3. **`_invokeOverload` patch 保留**: worker-bridge-build.js 的 script1.js patch 继续生效
4. **60 文件整体部署**: stage4 产物整体上传，不部分更新

## 4. Prompt 改造

### 4.1 prompt-v4.js 变化

**删除**:
- GFM_Create.Obj / GFM_Create.Ground / GFM_UI.CreateCanvas 的 API 说明
- "必须创建的对象清单" 章节
- 大量 "不要用 XXX" 约束（不再需要创建对象）

**新增**:
- "基础工程预制对象清单" — 列出所有可用对象名
- "使用方式" — Find / Move / Show/Hide / SetColor / Instantiate 示例
- 骨架代码模板（正面示例）

### 4.2 新 Prompt 结构（草案）

```
# 任务
在 GameFlowManagerMain.cs 中实现试玩广告逻辑。
场景已包含 ~280 个预制对象，你只需要：
1. GameObject.Find("名称") 获取引用
2. 移动位置显示/隐藏
3. 写游戏逻辑

# 可用对象清单
[自动从蓝图实体列表生成 → 匹配预制对象名]

# 骨架代码
```csharp
public class GameFlowManagerMain : MonoBehaviour {
    // 对象引用
    GameObject player, enemy1, building1;
    
    void Start() {
        // 获取引用
        player = GameObject.Find("Player");
        enemy1 = GameObject.Find("Enemy_1");
        
        // 摆放初始场景
        player.transform.position = new Vector3(0, 1, 0);
        
        // 隐藏不需要的
        // enemy1 已在 y=-999，不需要操作
    }
    
    void Update() {
        // 游戏逻辑
    }
}
```

# 规则（精简版）
- 不要用 CreatePrimitive / GFM_Create.Obj（对象已存在）
- 不要用泛型、coroutine、async/await
- 显示: transform.position = 目标位置
- 隐藏: transform.position = new Vector3(0, -999, 0)
- 结束: Luna.Unity.LifeCycle.GameEnded()
- CTA: Luna.Unity.Playable.InstallFullGame()

# 蓝图逻辑
[实体定义 + 事件规则，同 V4]
```

## 5. 实施计划

### Phase 1: 搭建基础工程（需要 Unity 编辑器）

1. 在 Worker ECS 的 Unity 中打开 `D:\work\test-luna\Client`
2. 在场景中手动摆放 ~280 个对象（或用脚本批量生成后保存场景）
3. 配置天空盒、光照、`__MaterialSource`(URP/Lit)
4. 写一个最简 GameFlowManagerMain.cs（Find Player + 移到 (0,1,0) + CTA）
5. Luna jake 构建 → 验证 HTML 能跑、不黑屏、不卡加载
6. SVN commit 基础工程
7. 保存 stage1-cache 到 worker

### Phase 2: 改造 Worker 代码

1. **prompt-v4.js** — 重写为"Find+Move"模式 prompt
2. **worker-coder.js** — 移除 GFM_Create 相关的 pre-build 验证，新增 Find 模式���证
3. **worker-bridge-build.js** — 确认 stage1-cache 复用路径正确
4. **worker-client.js** — SVN update 后保留基础场景（不 revert 为空模板）

### Phase 3: 端到端验证

1. 用现有蓝图（取木射箭 qmjs）提交任务
2. 验证：编译通过 → Luna 构建成功 → 不黑屏 → 不卡进度条 → CUA 能操控
3. 对比新旧方案的成功率

## 6. 预期收益

| 指标 | 之前 | 之后 |
|------|------|------|
| 首次编译通过率 | ~60% | ~95%+ |
| 构建黑屏率 | ~30% | ~0% |
| 加载卡进度条 | 偶发 | 消除 |
| 场景为空 | ~20% | 消除 |
| CUA 修复轮次 | 平均 3-4 轮 | 预计 1-2 轮 |
| Prompt 长度 | ~300 行 | ~100 行 |

## 7. 风险

| 风险 | 缓解 |
|------|------|
| Instantiate 在 Luna 中行为不确定 | 验证阶段测试复制对象，不行则改用预制更多对象 |
| GameObject.Find 性能 | 只在 Start() 中调用一次，缓存引用 |
| 对象数量不够 | 预留足够数量，不够时加新的 SVN commit |
| 某些游戏类型需要特殊形状 | 用 Cube 组合近似，或后续扩展预制清单 |
