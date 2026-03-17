# 蓝图系统 V4 改造方案：实体驱动架构

> 从"按镜头写状态机"→"以实体为中心 + 事件触发链"
> 
> 核心理念：没有"时间线"概念，只有"条件满足 → 激活实体/触发动作"

---

## 一、核心思想

**现状（V3）**：AI 按 Shot 顺序写 10 个 `UpdateShotN()` 函数，每个函数是独立状态机，对象生命周期被 Shot 切碎。

**目标（V4）**：每个游戏实体自己知道"怎么触发、触发后做什么、和谁关联"。不存在全局时间线，只有实体之间的**事件触发链**——A 完成了 → 激活 B → B 满足条件 → 激活 C。

```
V3:  策划分镜 → Shot1{状态机} → Shot2{状态机} → ...
V4:  策划分镜 → 实体行为表 → 触发链（条件→动作）→ 统一调度器
```

---

## 二、实体行为模型

### 2.1 每个实体的完整定义

```
ConveyorBelt:
  ┌─ 基础属性 ──────────────────────────┐
  │ shape: Cube(4×0.3×1)                │
  │ color: (0.5,0.5,0.55)               │
  │ position: (0, 0, 2)                 │
  │ role: interactive                    │
  └──────────────────────────────────────┘
  ┌─ 生命周期 ──────────────────────────┐
  │ spawnPhase: 1                        │  ← 何时出生
  │ spawnStyle: fadeIn / popUp / instant │  ← 出生动画
  │ persistent: true                     │  ← 是否持续存在
  └──────────────────────────────────────┘
  ┌─ 触发条件 ──────────────────────────┐
  │ triggerType: proximity               │  ← 靠近触发
  │ triggerRadius: 2.0                   │  ← 触发距离
  │ triggerCost: { gold: 1 }             │  ← 触发消耗
  │ triggerOnce: true                    │  ← 只触发一次
  └──────────────────────────────────────┘
  ┌─ 触发动作 ──────────────────────────┐
  │ actions:                             │
  │   1. playAnim: buildProgress(1.5s)   │  ← 播放建造进度条
  │   2. playAnim: popUp(0.5s)           │  ← 弹出动画
  │   3. setState: working               │  ← 进入工作状态
  │   4. activate: [WoodLog_Spawner]     │  ← 激活关联实体
  └──────────────────────────────────────┘
  ┌─ 持续行为 ──────────────────────────┐
  │ onState(working):                    │
  │   every 3s: spawn WoodLog at (2,0,4) │  ← 定时产出
  └──────────────────────────────────────┘
```

### 2.2 行为模板分类

| 模板 | 适用对象 | 核心逻辑 |
|------|---------|---------|
| **Buildable** | 传送带、木屋、炮塔 | 靠近/点击 → 扣资源 → 建造动画 → 激活 |
| **Spawner** | 发电机、刷怪点 | 定时生成子实体 |
| **Shooter** | 弩炮、炮塔 | 检测范围内敌人 → 发射弹药 → 造成伤害 |
| **Mover** | 敌人、工人 | 朝目标移动 → 到达后执行动作 |
| **Collectible** | 金币、木材 | 可拾取 → 加资源 → 消失 |
| **Draggable** | 木材拖放 | 拖拽到目标位置 → 触发建造 |
| **Damageable** | 敌人、Boss、基地 | 有血量 → 受伤 → 死亡动作 |
| **Upgradeable** | 基地 | 点击 → 扣资源 → 外观变化 → 属性提升 |
| **Static** | 地面、树、栅栏 | 无行为，纯装饰 |

### 2.3 取木射箭的实体定义（示例）

```yaml
entities:
  # --- 静态装饰 ---
  Ground:
    template: Static
    shape: Ground(40×1×40), color: (0.35,0.25,0.15)
    spawnPhase: 1

  PineTree_L:
    template: Static
    shape: Cylinder(0.5×3×0.5), color: (0.1,0.55,0.1)
    position: (-5, 0, 3)
    spawnPhase: 1

  # --- 核心玩法实体 ---
  Player:
    template: Mover
    shape: Cube(1×2×1), color: (0.2,0.4,0.9)
    position: (-2, 0, -4)
    spawnPhase: 1
    input: virtualJoystick
    moveSpeed: 5

  ConveyorBelt:
    template: Buildable
    shape: Cube(4×0.3×1), color: (0.5,0.5,0.55)
    position: (0, 0, 2)
    spawnPhase: 1
    spawnStyle: blueprint  # 先显示半透明轮廓
    trigger: { type: proximity, radius: 2, cost: { gold: 1 }, once: true }
    buildTime: 1.5
    onBuilt: [ activate(WoodLog_Spawner) ]

  Crossbow_L:
    template: Shooter
    shape: Cube(1×1.5×1), color: (0.5,0.5,0.55)
    position: (3, 0, 5)
    spawnPhase: 2
    trigger: { type: click, once: false }
    fireRate: 1.5
    projectile: Arrow
    damage: 1
    targetTag: enemy
    range: 10

  Enemy_A:
    template: Mover + Damageable
    shape: Cube(0.8×1.6×0.8), color: (0.85,0.15,0.15)
    spawnPhase: 2
    spawnStyle: spawner  # 由 EnemySpawner 生成
    hp: 3
    moveSpeed: 2
    moveTarget: Base
    onDeath: [ drop(GoldCoin, 1) ]

  EnemySpawner:
    template: Spawner
    spawnPhase: 2
    position: (15, 0, 0)  # 屏幕右侧外
    spawnEntity: Enemy_A
    spawnInterval: 3
    maxAlive: 5

  Boss:
    template: Mover + Damageable
    shape: Cube(1.5×3×1.5), color: (0.7,0.1,0.1)
    spawnPhase: 8
    hp: 20
    moveSpeed: 1.5
    moveTarget: Base
    onDeath: [ trigger(phase_advance) ]
```

---

## 三、Phase 时间线（极简）

Phase 只管两件事：**激活实体** 和 **转场条件**。

```yaml
phases:
  - id: 1
    name: "建造传送带"
    activate: [Ground, Player, Base, WoodFence, PineTree_L, PineTree_R, Generator, ConveyorBelt]
    endWhen: ConveyorBelt.state == "working"
    camera: { lookAt: ConveyorBelt, zoom: 8 }
    guide: "移动到传送带位置建造它"

  - id: 2
    name: "弩炮防御"
    activate: [Crossbow_L, Crossbow_R, EnemySpawner]
    endWhen: Enemy_A.killed >= 3
    camera: { lookAt: Crossbow_L, zoom: 10 }
    guide: "点击弩炮射击敌人"

  - id: 3
    name: "修建木屋"
    activate: [WoodLog, WoodHouse]
    endWhen: WoodHouse.state == "built"
    guide: "拖拽木材到木屋位置"

  # ...

  - id: 8
    name: "迎战Boss"
    activate: [Boss]
    endWhen: Boss.hp <= 0
    guide: "消灭Boss！"

  - id: 10
    name: "结局"
    endWhen: always
    actions: [ GameEnded(), showCTA() ]
```

对比 V3 的 triggerChain：
- V3: "玩家移动到传送带蓝图位置 → 检测距离小于2 → 判断金币够不够 → 扣除金币 → 显示建造进度条 → ..." （自然语言，AI 自由发挥）
- V4: `trigger: { type: proximity, radius: 2, cost: { gold: 1 } }` （结构化，AI 按模板生成）

---

## 四、AI 代码生成方式变化

### 4.1 Prompt 结构

```
你需要在 GameFlowManagerMain.cs 中实现以下试玩广告。

## 架构要求
采用实体驱动模式：
1. 每个实体一个 UpdateXxx() 方法，管理自己的行为
2. PhaseManager 负责按时间线激活实体
3. Update() 中遍历所有已激活实体，调用其 Update 方法

## 实体定义
[实体列表，含模板类型、属性、触发条件、动作]

## Phase 时间线
[Phase 列表，含激活实体和转场条件]

## 行为模板参考
Buildable 模板：
  - 初始显示半透明轮廓
  - 满足触发条件时开始建造（进度条）
  - 建造完成后切换外观、执行 onBuilt 动作

Shooter 模板：
  - 被触发后进入射击状态
  - 按 fireRate 间隔检测 range 内最近的 targetTag 实体
  - 生成 projectile，朝目标飞行，命中后造成 damage

[...其他模板]
```

### 4.2 AI 生成的代码结构

```csharp
public class GameFlowManagerMain : MonoBehaviour
{
    // ===== 全局状态 =====
    int currentPhase = 0;
    float phaseTimer = 0;

    // ===== 实体数据 =====
    struct EntityData {
        public GameObject go;
        public bool active;
        public int state;
        public float timer;
        public float hp;
    }
    EntityData[] entities = new EntityData[30];

    // ===== 资源 =====
    int gold = 1;
    int wood = 0;

    void Start() {
        InitEntities();     // 创建所有对象（初始隐藏）
        StartPhase(1);      // 开始第一阶段
    }

    void Update() {
        float dt = Time.deltaTime;
        UpdatePlayer(dt);           // 玩家控制（始终运行）
        UpdateActiveEntities(dt);    // 遍历已激活实体
        CheckPhaseTransition();      // 检查阶段切换
    }

    // ===== 实体行为（每个实体一个方法）=====

    void UpdateConveyorBelt(float dt) {
        // Buildable 模板逻辑
        if (entities[E_CONVEYOR].state == 0) {
            // 等待触发：检测玩家距离
            if (DistToPlayer(E_CONVEYOR) < 2f && gold >= 1) {
                gold -= 1;
                entities[E_CONVEYOR].state = 1;
                entities[E_CONVEYOR].timer = 0;
            }
        } else if (entities[E_CONVEYOR].state == 1) {
            // 建造中
            entities[E_CONVEYOR].timer += dt;
            UpdateProgressBar(E_CONVEYOR, entities[E_CONVEYOR].timer / 1.5f);
            if (entities[E_CONVEYOR].timer >= 1.5f) {
                entities[E_CONVEYOR].state = 2; // working
                ActivateEntity(E_WOODLOG_SPAWNER);
            }
        }
    }

    void UpdateCrossbow(int idx, float dt) {
        // Shooter 模板逻辑
        if (entities[idx].state == 0) return; // 未激活
        entities[idx].timer += dt;
        if (entities[idx].timer >= 1.5f) {
            int target = FindNearestEnemy(entities[idx].go.transform.position, 10f);
            if (target >= 0) {
                SpawnArrow(entities[idx].go.transform.position, entities[target].go.transform.position);
                entities[idx].timer = 0;
            }
        }
    }

    void UpdateEnemy(int idx, float dt) {
        // Mover + Damageable 模板
        if (entities[idx].hp <= 0) { OnEnemyDeath(idx); return; }
        MoveToward(idx, basePosition, 2f * dt);
        if (DistTo(idx, basePosition) < 1f) { DamageBase(1); }
    }

    // ===== Phase 管理 =====

    void StartPhase(int phase) {
        currentPhase = phase;
        switch(phase) {
            case 1: ActivateEntities(E_GROUND, E_PLAYER, E_BASE, ...); break;
            case 2: ActivateEntities(E_CROSSBOW_L, E_CROSSBOW_R, E_SPAWNER); break;
            // ...
        }
    }

    void CheckPhaseTransition() {
        switch(currentPhase) {
            case 1: if (entities[E_CONVEYOR].state == 2) StartPhase(2); break;
            case 2: if (enemyKillCount >= 3) StartPhase(3); break;
            // ...
        }
    }
}
```

### 4.3 对比

| 维度 | V3（Shot 状态机） | V4（实体驱动） |
|------|------------------|---------------|
| 代码组织 | 按时间线（Shot1/2/3...） | 按实体（ConveyorBelt/Crossbow/Enemy...） |
| 对象生命周期 | 跨 Shot 容易丢状态 | 实体自管理，始终一致 |
| 行为复用 | 每个 Shot 各写一遍 | 同模板共享逻辑 |
| 改需求 | 改一个触发时机要重写 Shot | 改 spawnPhase 一个数字 |
| AI 出错概率 | 高（自由发挥空间大） | 低（模板约束明确） |
| Prompt 长度 | 长（自然语言描述） | 短（结构化数据） |

---

## 五、前端改造

### 5.1 物件清单面板（升级）

现有字段保留（name/shape/color/scale/role/interactionType），新增：

```
┌─ 物件编辑 ─────────────────────────────┐
│ 名称: ConveyorBelt    标签: 传送带      │
│ 形状: Cube    尺寸: 4×0.3×1            │
│ 颜色: (0.5,0.5,0.55)  [■]             │
│ 角色: 🔧可交互   交互: 靠近触发         │
│                                        │
│ ▼ 行为模板: [Buildable ▼]              │  ← 新增
│   建造时间: [1.5] 秒                    │
│   建造花费: [gold: 1]                   │
│   建造完成后: [激活 WoodLog_Spawner ▼]   │
│                                        │
│ ▼ 触发条件                              │  ← 新增
│   类型: [靠近触发 ▼]                     │
│   距离: [2.0]                           │
│   只触发一次: [✓]                        │
│                                        │
│ ▼ 持续行为                              │  ← 新增（Spawner 等）
│   （按模板类型显示不同字段）              │
└─────────────────────────────────────────┘
```

### 5.2 时间线面板（简化）

Step 卡片从现在的复杂表单 → 变成极简的 Phase 卡片：

```
┌─ Phase 1: 建造传送带 ──────────────────┐
│ 激活: [Ground ✓] [Player ✓] [Base ✓]   │  ← checkbox
│       [ConveyorBelt ✓] [Generator ✓]   │
│ 结束条件: [ConveyorBelt.state == built] │  ← 下拉选
│ 引导文案: [移动到传送带位置]             │
│ 镜头: [看向 ConveyorBelt, 缩放 8]      │
└─────────────────────────────────────────┘
```

**不再需要**：
- ❌ triggerChain（实体自带触发逻辑）
- ❌ sceneObjects 文本（由 Phase 的激活列表替代）
- ❌ 步骤级参数表（全在实体定义里）

### 5.3 ReactFlow 画布

节点从 ShotNode → **PhaseNode**，更轻量：
- 标题 + 激活实体列表 + 结束条件
- 节点之间的连线 = Phase 顺序（可分支）

---

## 六、Prompt 层改造

### 6.1 parseBlueprintToPrompt() V4

```
=== ENTITY DEFINITIONS ===
[20 个实体，每个含：模板类型 + 属性 + 触发条件 + 动作]

=== BEHAVIOR TEMPLATES ===
[Buildable/Shooter/Mover/... 的标准实现模式]

=== PHASE TIMELINE ===
Phase 1 → 激活 [A,B,C]，结束条件: X
Phase 2 → 激活 [D,E]，结束条件: Y
...

=== GLOBAL PARAMS ===
[参数表]

=== LUNA CONSTRAINTS ===
[不变]
```

### 6.2 行为模板文档

给 AI 提供每种模板的标准实现范式（作为 prompt 的一部分）：

```
### Buildable 模板
实现方式：
- state 0: 显示半透明轮廓，等待触发
- state 1: 播放建造进度条（timer / buildTime）
- state 2: 建造完成，切换为实体外观，执行 onBuilt

### Shooter 模板
实现方式：
- 被激活后进入射击状态
- timer 累加，达到 fireRate 时：
  - FindNearest(targetTag, range)
  - 生成 projectile，设置飞行方向
  - projectile 命中后造成 damage，回收到对象池
```

这些模板文档是**固定的**，不随项目变化。相当于给 AI 一本"设计模式手册"。

---

## 七、实施路线

### Phase 1：数据层（1-2天）
- [ ] 定义实体行为 JSON Schema（template/trigger/actions/持续行为）
- [ ] 在 worker-coder.js 中新增 `parseBlueprintToPromptV4()`
- [ ] 编写行为模板文档（Buildable/Shooter/Mover/Spawner/Collectible/Damageable）
- [ ] 用取木射箭项目手动构建 V4 实体数据测试 prompt 输出

### Phase 2：Prompt + AI 验证（2-3天）
- [ ] 用 V4 prompt 手动调 AI，观察代码结构是否符合预期
- [ ] 迭代模板文档直到 AI 稳定输出正确的实体驱动代码
- [ ] 对比 V3 和 V4 生成的代码质量
- [ ] 确认 Luna 编译通过 + 基本运行正常

### Phase 3：前端改造（2-3天）
- [ ] 物件清单面板新增行为模板选择器 + 模板参数表单
- [ ] 时间线面板改为 Phase 模式（激活列表 + 结束条件）
- [ ] PhaseNode 替换 ShotNode
- [ ] 数据迁移：V3 blueprint → V4 blueprint 转换工具

### Phase 4：端到端验证（1-2天）
- [ ] 取木射箭全流程：前端编辑 → 提交 → AI 编码 → Luna 构建 → CUA 验证
- [ ] 对比 CUA 通过率（V3 vs V4）
- [ ] 修复问题，迭代优化

**总计：约 1-1.5 周**

---

## 八、风险与注意事项

1. **Luna 单文件限制**：所有实体的 Update 方法都在一个 .cs 文件里，文件可能很长（但比 V3 的 Shot 状态机结构更清晰）
2. **模板覆盖度**：不同游戏类型可能需要新模板（塔防/跑酷/合成/三消...），需要持续积累
3. **复杂交互**：有些行为不好归类到单一模板（比如"拖拽木材到指定位置触发建造"），可能需要组合模板
4. **向后兼容**：V3 的旧项目数据需要保留支持，或提供迁移工具
5. **CUA 验证**：Phase 转场条件需要明确，否则 CUA 不知道当前处于哪个阶段

---

## 九、核心优势总结

| | V3 | V4 |
|---|---|---|
| **AI 输入** | "请按分镜写10个状态机" | "请为20个实体各写行为函数" |
| **AI 输出** | 1700行 耦合的 Shot 状态机 | 800-1000行 独立的实体方法 |
| **可调试性** | 出bug要在 Shot 状态机里找 | 直接定位到具体实体的方法 |
| **需求变更** | 改触发时机 → 重写 Shot | 改 spawnPhase 数字 |
| **行为复用** | 无 | 同模板共享 |
| **策划理解** | 需要理解状态机 | 只需要配实体属性 |
