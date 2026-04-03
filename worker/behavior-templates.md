# Luna 行为模板实现手册（事件驱动版）

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

// 实体运行时数据（平行数组）
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

## 获取3D对象（从预制池 Find）

```csharp
// ✅ 正确：从预制池 Find 对象（颜色已烘焙，不需要 SetColor）
var cube = GameObject.Find("__Pool_Cube_Red_01");
cube.transform.position = new Vector3(0, 1, 0);  // 移到场景中 = 显示
cube.transform.localScale = new Vector3(1, 2, 1);

// ✅ 地面已存在
var ground = GameObject.Find("__Ground");

// ✅ 需要更多同类对象时，Instantiate 复制（仅当池对象用完时）
var extraCube = Instantiate(cube);
extraCube.transform.position = new Vector3(3, 1, 0);
```

> ⛔ **绝对禁止**: `GFM_Create.Obj()`, `GFM_Create.Ground()`, `GFM_Create.SetColor()`, `CreatePrimitive()`

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
- 所有代码在 GameFlowManagerMain.cs 一个文件
- 用 `GameObject.Find("__Pool_{Shape}_{Color}_{NN}")` 获取池对象，不要用 GFM_Create.Obj()
- 没有 GFM_Tools 类！用: GFM_Create, GFM_Utils, GFM_UI, GFM_Joystick, GFM_Audio
- 不能用 CreatePrimitive、Resources.Load、async/await、协程、List<T>
- 隐藏用 position=(0,-999,0)，不用 SetActive(false)
- 结束: Luna.Unity.LifeCycle.GameEnded()
- CTA: Luna.Unity.Playable.InstallFullGame()
