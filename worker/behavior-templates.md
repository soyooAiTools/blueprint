# Luna 行为模板实现手册（事件驱动版）

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

## 创建3D对象（GFM_Create）

```csharp
// 正确签名！4个参数：PrimitiveType, Vector3 position, Vector3 scale, string name
var cube = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0,1,0), new Vector3(1,2,1), "MyCube");
GFM_Create.SetColor(cube, new Color(0.2f, 0.4f, 0.9f));

// 地面：2个float参数
var ground = GFM_Create.Ground(40f, 40f);
GFM_Create.SetColor(ground, new Color(0.35f, 0.25f, 0.15f));
```

## PlayerController 模板

```csharp
GFM_Joystick joystick;  // 在 Start() 中初始化

void InitJoystick() {
    var canvas = GFM_UI.CreateCanvas();
    joystick = GFM_Joystick.Create(canvas, 200f);
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

## 关键约束（Luna）
- 所有代码在 GameFlowManagerMain.cs 一个文件
- 用 GFM_Create.Obj(PrimitiveType, Vector3, Vector3, string) 创建对象
- 没有 GFM_Tools 类！用: GFM_Create, GFM_Utils, GFM_UI, GFM_Joystick, GFM_Audio
- 不能用 CreatePrimitive、Resources.Load、async/await、协程、List<T>
- 隐藏用 position=(0,-999,0)，不用 SetActive(false)
- 结束: Luna.Unity.LifeCycle.GameEnded()
- CTA: Luna.Unity.Playable.InstallFullGame()
