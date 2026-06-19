# Luna 行为模板实现手册（事件驱动版）

> 本文件只给 Luna/WebGL staging 代码参考。程序员 Unity 交付版必须由 AIBridge/MCP 做 Inspector/scene hydration，引用进入 `GMP_EntityBindingManager.mBindings` 或 `[SerializeField]` 字段；不要把这里的平行数组、运行时 `Find` 或一次性模板拆法照搬成最终交付结构。
> 程序员可交付反馈规则：一节点一主脚本；无生命周期能力默认用普通 C# 类；变量名要说明业务含义；只保留会被调用的方法；必要兜底才写；场景遗留、Missing Mono Script 和组件配置优先由 Editor/MCP 修掉，不要在业务代码里反复 Find/AddComponent/修复。

> ⚠️ **最重要的规则**: Phase/Rule 推进必须由玩家操作触发，绝对禁止用 gameTimer/计时器 自动推进！
> CUA 验证器会检测: 如果游戏在无玩家输入下自动跑完所有 Phase → **直接 FAIL**。

> 纯事件驱动，无线性 Phase。用 bool[] ruleTriggered 跟踪规则状态。

## 通用架构

```csharp
// 实体索引常量
const int E_PLAYER = 0;
const int E_BASE = 1;
const int E_CONVEYOR = 2;
// ... 每个实体一个常量

const int MAX_ENTITIES = 50;
const int RULE_COUNT = 10;

// 实体运行时数据（仅限 staging；交付版收口到 mBindings）
GameObject[] eGo = new GameObject[MAX_ENTITIES];
bool[] eActive = new bool[MAX_ENTITIES];
int[] eState = new int[MAX_ENTITIES];     // 0=初始, 1=触发中, 2=完成
float[] eTimer = new float[MAX_ENTITIES];
float[] eHP = new float[MAX_ENTITIES];

// 事件规则
bool[] ruleTriggered = new bool[RULE_COUNT];

// 资源
int gold = 0;
int wood = 0;
int enemyKillCount = 0;

void Update() {
    float dt = Time.deltaTime;
    CheckEventRules();  // 每帧检查所有规则条件
    UpdatePlayer(dt);
    UpdateProjectiles(dt);
    // 遍历激活的实体
    for (int i = 0; i < entityCount; i++) {
        if (!eActive[i]) continue;
        UpdateEntity(i, dt);
    }
}

// 事件规则：独立检查，不依赖顺序
void CheckEventRules() {
    // Rule 1: gameStart → 激活初始实体
    if (!ruleTriggered[0]) {
        ruleTriggered[0] = true;
        ActivateEntity(E_PLAYER);
        ActivateEntity(E_BASE);
        // ... 激活所有初始实体
    }
    // Rule 2: 当传送带建造完成
    if (!ruleTriggered[1] && eState[E_CONVEYOR] == 2) {
        ruleTriggered[1] = true;
        ActivateEntity(E_ENEMY_SPAWNER);
        ShowGuide("点击弩炮射击敌人");
    }
    // Rule N: 每条规则独立判断
    // ...
}
```

## 获取3D对象（优先从绑定表取）

```csharp
// ✅ staging 正确：先从骨架绑定表取对象（颜色已烘焙，不需要 SetColor）
var cube = GameSceneCtrl.instance.Get("Crate");
cube.transform.position = new Vector3(0, 1, 0);  // 移到场景中 = 显示
cube.transform.localScale = new Vector3(1, 2, 1);

// ✅ 地面、HUD、相机同样来自骨架字段或绑定表，不在业务循环里扫场景
var ground = GameSceneCtrl.instance.Get("__Ground");
```

> ⛔ **绝对禁止**: `GFM_Create.Obj()`, `GFM_Create.Ground()`, `GFM_Create.SetColor()`, `CreatePrimitive()`
> 程序员交付版额外禁止业务代码里的 `GameObject.Find`、`FindObjectOfType`、`.AddComponent(...)`、`new GameObject(...)`；这些引用必须由 MCP/Inspector 预先写好。距离门槛判断用 `sqrMagnitude`，不要把 `Vector3.Distance` 写成正向示例。

## PlayerController 模板

```csharp
GFM_Joystick joystick;  // 在 Start() 中初始化

void InitJoystick() {
    // ✅ 用骨架预创建的 uiCanvas，不要调用 GFM_UI.CreateCanvas()
    joystick = GFM_Joystick.Create(uiCanvas, 200f);
}

void UpdatePlayer(float dt) {
    float h = joystick.Horizontal;  // -1 ~ 1
    float v = joystick.Vertical;    // -1 ~ 1
    Vector3 move = new Vector3(h, 0, v).normalized * moveSpeed * dt;
    eGo[E_PLAYER].transform.position += move;
}
```

## Buildable 模板
状态: 0(等待触发) → 1(建造中) → 2(已建造)

```csharp
void UpdateBuildable(int idx, float dt) {
    if (eState[idx] == 0) {
        float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[idx].transform.position);
        if (dist < triggerRadius && gold >= cost) {
            gold -= cost;
            eState[idx] = 1;
            eTimer[idx] = 0;
        }
    }
    else if (eState[idx] == 1) {
        eTimer[idx] += dt;
        if (eTimer[idx] >= buildTime) {
            eState[idx] = 2;  // 建造完成 → CheckEventRules 会检测到
        }
    }
}
```

## Shooter 模板

```csharp
void UpdateShooter(int idx, float dt) {
    if (eState[idx] < 1) return;
    eTimer[idx] += dt;
    if (eTimer[idx] >= fireRate) {
        int target = FindNearestEnemy(eGo[idx].transform.position, range);
        if (target >= 0) {
            SpawnProjectile(eGo[idx].transform.position, eGo[target].transform.position);
            eTimer[idx] = 0;
        }
    }
}
```

## Mover+Damageable（敌人）

```csharp
void UpdateEnemy(int idx, float dt) {
    if (eHP[idx] <= 0) { OnEnemyDeath(idx); return; }
    Vector3 dir = (basePos - eGo[idx].transform.position).normalized;
    eGo[idx].transform.position += dir * moveSpeed * dt;
    if (Vector3.Distance(eGo[idx].transform.position, basePos) < 1.5f) {
        DamageBase(1);
        eHP[idx] = 0;
    }
}

void OnEnemyDeath(int idx) {
    SpawnCollectible(eGo[idx].transform.position);
    eGo[idx].transform.position = new Vector3(0, -999, 0);
    eActive[idx] = false;
    enemyKillCount++;
    // CheckEventRules() 会检测 enemyKillCount 变化
}
```

## Spawner 模板

```csharp
void UpdateSpawner(int idx, float dt) {
    if (!eActive[idx]) return;
    eTimer[idx] += dt;
    if (eTimer[idx] >= spawnInterval && CountAlive(spawnTag) < maxAlive) {
        int child = GetPooled(spawnTag);
        eGo[child].transform.position = spawnPosition;
        eActive[child] = true;
        eHP[child] = childHP;
        eState[child] = 1;
        eTimer[idx] = 0;
    }
}
```

## Collectible 模板

```csharp
void UpdateCollectible(int idx, float dt) {
    if (!eActive[idx]) return;
    float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[idx].transform.position);
    if (dist < collectRadius) {
        gold += rewardAmount;
        eGo[idx].transform.position = new Vector3(0, -999, 0);
        eActive[idx] = false;
    }
}
```

## Projectile 模板

```csharp
void UpdateProjectiles(float dt) {
    for (int i = 0; i < MAX_ARROWS; i++) {
        if (!arrowActive[i]) continue;
        Vector3 dir = (arrowTarget[i] - arrowGo[i].transform.position).normalized;
        arrowGo[i].transform.position += dir * arrowSpeed * dt;
        arrowGo[i].transform.forward = dir;
        if (Vector3.Distance(arrowGo[i].transform.position, arrowTarget[i]) < 0.5f) {
            DamageNearestEnemy(arrowTarget[i], arrowDamage);
            arrowGo[i].transform.position = new Vector3(0, -999, 0);
            arrowActive[i] = false;
        }
    }
}
```

## Carry/Pickup-Deliver（搬运投递）模板
玩家拾取物品 → 搬运到目标点 → 投递获得奖励

```csharp
int carrying = 0;          // 当前携带数量
int carryLimit = 1;         // 搬运上限（可升级）
int delivered = 0;          // 已投递总数

void UpdateCarry(float dt) {
    if (carrying < carryLimit) {
        // 检测靠近可拾取物
        for (int i = PICKUP_START; i < PICKUP_END; i++) {
            if (!eActive[i]) continue;
            float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[i].transform.position);
            if (dist < pickupRadius) {
                carrying++;
                eGo[i].transform.position = new Vector3(0, -999, 0);
                eActive[i] = false;
                break; // 每帧只拾取一个
            }
        }
    }
    // 检测靠近投递点
    if (carrying > 0) {
        float distDrop = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[E_DROPOFF].transform.position);
        if (distDrop < dropRadius) {
            gold += carrying * rewardPerItem;
            delivered += carrying;
            carrying = 0;
            // CheckEventRules 会检测 delivered / gold 变化
        }
    }
}
```

## Upgradeable（多级升级）模板
状态: 0(可升级) → 1(level1) → 2(level2) → 3(maxLevel)

```csharp
int[] upgradeCost = {0, 100, 300, 500};   // 每级升级所需金币
int[] upgradeValue = {1, 3, 5, 10};        // 每级的效果值（如搬运量、容量）

void UpdateUpgradeable(int idx, float dt) {
    int level = eState[idx];
    if (level >= upgradeValue.Length - 1) return; // 已满级
    float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[idx].transform.position);
    if (dist < triggerRadius && gold >= upgradeCost[level + 1]) {
        gold -= upgradeCost[level + 1];
        eState[idx] = level + 1;
        // 应用升级效果，例如:
        // carryLimit = upgradeValue[eState[idx]];
        // 或: spawnInterval = baseInterval / upgradeValue[eState[idx]];
    }
}
```

## Drag（拖拽交互）模板
玩家按住并拖动角色移动（替代摇杆）

```csharp
bool isDragging = false;
Vector3 dragStart;
Vector3 playerStart;

void UpdateDragMovement(float dt) {
    if (Input.GetMouseButtonDown(0)) {
        // 射线检测是否点到了玩家附近
        Vector3 mouseWorld = GetMouseWorldPos();
        float dist = Vector3.Distance(mouseWorld, eGo[E_PLAYER].transform.position);
        if (dist < 3f) {
            isDragging = true;
            dragStart = mouseWorld;
            playerStart = eGo[E_PLAYER].transform.position;
        }
    }
    if (Input.GetMouseButton(0) && isDragging) {
        Vector3 mouseWorld = GetMouseWorldPos();
        Vector3 delta = mouseWorld - dragStart;
        delta.y = 0;
        eGo[E_PLAYER].transform.position = playerStart + delta;
    }
    if (Input.GetMouseButtonUp(0)) {
        isDragging = false;
    }
}

Vector3 GetMouseWorldPos() {
    // 简单实现：将鼠标投射到 y=0 平面
    Ray ray = mainCam.ScreenPointToRay(Input.mousePosition);
    float t = -ray.origin.y / ray.direction.y;
    return ray.origin + ray.direction * t;
}
```

## ResourceConverter（资源转化链）模板
输入资源A → 等待加工 → 输出资源B（适合线性资源流游戏）

```csharp
void UpdateConverter(int idx, float dt) {
    if (eState[idx] < 2) return; // 未建好
    // 投递原料
    if (carrying > 0) {
        float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[idx].transform.position);
        if (dist < dropRadius) {
            eTimer[idx] += carrying; // 累积原料
            carrying = 0;
        }
    }
    // 加工产出
    if (eTimer[idx] >= convertRatio) {
        int output = (int)(eTimer[idx] / convertRatio);
        eTimer[idx] -= output * convertRatio;
        gold += output * outputValue;
    }
}
```

## 🚨 禁止的 Anti-Pattern（会导致 CUA 验证 FAIL）

```csharp
// ❌ 错误示例 1: timer 驱动 phase 推进
void CheckEventRules() {
    if (!ruleTriggered[1] && gameTimer > 5f) {  // ❌ 不能用 timer 触发！
        ruleTriggered[1] = true;
        AddCompletedPhase("collectIce");
    }
}

// ❌ 错误示例 2: auto-advance 
void Update() {
    phaseTimer += Time.deltaTime;
    if (phaseTimer > 3f) {  // ❌ 不能自动推进！
        AdvanceToNextPhase();
        phaseTimer = 0;
    }
}

// ✅ 正确示例: 玩家操作触发
void CheckEventRules() {
    // Rule 2: 玩家移动到冰矿附近 → 触发采集
    if (!ruleTriggered[1] && 
        Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[E_ICE_MINE].transform.position) < 2f) {
        ruleTriggered[1] = true;
        eState[E_ICE_MINE] = 1; // 开始采集动画
        AddCompletedPhase("collectIce");
        ShowGuide("把冰搬到机器旁边");
    }
}
```

## 关键约束（Luna）
- 当前生成期可填充 GameFlowManagerMain*.cs partial；最终程序员交付必须清洗为 `Assets/Scripts/Core`、`Assets/Scripts/Tool`、`Assets/Scripts/Game`，业务逻辑只落 `Game`
- 用骨架绑定字段或 `GameSceneCtrl.instance.Get("entityName")` 获取池对象；只有 staging 绑定表可以出现 `__Pool_*` literal，不要用 GFM_Create.Obj()
- 没有 GFM_Tools 类！用: GFM_Create, GFM_Utils, GFM_UI, GFM_Joystick, GFM_Audio
- 不能用 CreatePrimitive、Resources.Load、async/await、协程、List<T>
- 隐藏用 position=(0,-999,0)，不用 SetActive(false)
- 结束: Luna.Unity.LifeCycle.GameEnded()
- CTA: Luna.Unity.Playable.InstallFullGame()
