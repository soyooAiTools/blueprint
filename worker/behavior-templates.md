# Luna 行为模板实现手册

> 给 AI 的参考文档：每种实体模板在 GameFlowManagerMain.cs 中的标准实现方式

## 通用架构

```csharp
// 实体索引常量
const int E_PLAYER = 0;
const int E_BASE = 1;
// ... 每个实体一个常量

// 实体运行时数据（用平行数组，避免泛型/结构体兼容问题）
GameObject[] eGo = new GameObject[MAX_ENTITIES];   // 游戏对象
bool[] eActive = new bool[MAX_ENTITIES];            // 是否已激活
int[] eState = new int[MAX_ENTITIES];               // 状态（0=初始, 1=触发中, 2=完成...）
float[] eTimer = new float[MAX_ENTITIES];           // 通用计时器
float[] eHP = new float[MAX_ENTITIES];              // 血量（Damageable用）

// 资源
int gold = 0;
int wood = 0;
int currentPhase = 0;

void Update() {
    float dt = Time.deltaTime;
    UpdatePlayer(dt);
    for (int i = 0; i < entityCount; i++) {
        if (!eActive[i]) continue;
        UpdateEntity(i, dt);  // 分发到各实体的更新方法
    }
    CheckPhaseTransition();
}
```

---

## Static 模板
纯装饰，无行为。激活时创建对象，之后不需要 Update。

```csharp
void InitStatic(int idx, string shape, Vector3 scale, Color color, Vector3 pos) {
    eGo[idx] = GFM_Create.Obj(shape);
    eGo[idx].transform.localScale = scale;
    eGo[idx].transform.position = pos;
    GFM_Create.SetColor(eGo[idx], color);
}
// 无 Update 方法
```

---

## PlayerController 模板
虚拟摇杆控制移动。始终运行。

```csharp
void UpdatePlayer(float dt) {
    // 虚拟摇杆输入
    float h = GFM_Tools.SliderValue("joyX");  // -1 ~ 1
    float v = GFM_Tools.SliderValue("joyY");  // -1 ~ 1
    Vector3 move = new Vector3(h, 0, v).normalized * moveSpeed * dt;
    eGo[E_PLAYER].transform.position += move;
}
```

---

## Buildable 模板
靠近/点击 → 扣资源 → 建造进度条 → 完成 → 触发后续。

**状态流转**: 0(等待触发) → 1(建造中) → 2(已建造)

```csharp
void UpdateBuildable(int idx, float dt) {
    if (eState[idx] == 0) {
        // 检查触发条件
        // proximity: 检测玩家距离
        float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[idx].transform.position);
        if (dist < triggerRadius && gold >= cost) {
            gold -= cost;
            eState[idx] = 1;
            eTimer[idx] = 0;
            // 显示进度条UI
        }
    }
    else if (eState[idx] == 1) {
        // 建造中
        eTimer[idx] += dt;
        float progress = eTimer[idx] / buildTime;
        // 更新进度条
        if (progress >= 1f) {
            eState[idx] = 2;  // 建造完成
            // 切换外观（去掉半透明）
            // 执行 onBuilt 动作（激活关联实体等）
            OnBuildComplete(idx);
        }
    }
    // state 2: 已完成，可能有持续行为（如Spawner）
}
```

---

## Shooter 模板
被激活后，按间隔向最近敌人射击。

**状态流转**: 0(待机) → 1(射击中)

```csharp
void UpdateShooter(int idx, float dt) {
    if (eState[idx] == 0) return;  // 未激活
    eTimer[idx] += dt;
    if (eTimer[idx] >= fireRate) {
        // 查找最近目标
        int target = FindNearestWithTag(eGo[idx].transform.position, "enemy", range);
        if (target >= 0) {
            SpawnProjectile(eGo[idx].transform.position, eGo[target].transform.position);
            eTimer[idx] = 0;
            // 播放射击动画（旋转朝向目标）
        }
    }
}
```

---

## Mover 模板
朝目标实体移动。

```csharp
void UpdateMover(int idx, float dt) {
    if (!eActive[idx]) return;
    Vector3 targetPos = eGo[moveTargetIdx].transform.position;
    Vector3 dir = (targetPos - eGo[idx].transform.position).normalized;
    eGo[idx].transform.position += dir * moveSpeed * dt;
    // 朝向目标
    if (dir.sqrMagnitude > 0.01f)
        eGo[idx].transform.forward = dir;
}
```

---

## Mover+Damageable 组合（敌人）
移动 + 有血量 + 到达目标时攻击 + 死亡掉落。

```csharp
void UpdateEnemy(int idx, float dt) {
    if (eHP[idx] <= 0) { OnEnemyDeath(idx); return; }
    // 移动
    Vector3 dir = (basePos - eGo[idx].transform.position).normalized;
    eGo[idx].transform.position += dir * moveSpeed * dt;
    // 到达基地
    if (Vector3.Distance(eGo[idx].transform.position, basePos) < 1.5f) {
        DamageBase(1);
        eHP[idx] = 0;  // 自爆
    }
}

void OnEnemyDeath(int idx) {
    // 掉落金币
    SpawnCollectible(eGo[idx].transform.position, "GoldCoin");
    // 回收到对象池
    eGo[idx].transform.position = new Vector3(0, -999, 0);
    eActive[idx] = false;
    enemyKillCount++;
}
```

---

## Spawner 模板
无视觉，定时生成子实体。

```csharp
void UpdateSpawner(int idx, float dt) {
    if (!eActive[idx]) return;
    eTimer[idx] += dt;
    if (eTimer[idx] >= spawnInterval) {
        if (CountAlive(spawnTag) < maxAlive) {
            int child = GetPooledEntity(spawnTag);
            eGo[child].transform.position = spawnPosition;
            eActive[child] = true;
            eHP[child] = childHP;
            eState[child] = 1;
        }
        eTimer[idx] = 0;
    }
}
```

---

## Collectible 模板
玩家靠近自动拾取 → 加资源 → 消失。

```csharp
void UpdateCollectible(int idx, float dt) {
    if (!eActive[idx]) return;
    float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[idx].transform.position);
    if (dist < collectRadius) {
        gold += rewardAmount;
        // 播放拾取动画（缩小+飞向UI）
        eGo[idx].transform.position = new Vector3(0, -999, 0);
        eActive[idx] = false;
    }
}
```

---

## Draggable 模板
玩家拖拽到目标位置。

```csharp
void UpdateDraggable(int idx, float dt) {
    if (!eActive[idx]) return;
    if (eState[idx] == 0) {
        // 等待点击
        if (Input.GetMouseButtonDown(0)) {
            // 射线检测是否点中了这个对象
            if (IsHitByRay(eGo[idx])) {
                eState[idx] = 1;  // 拖拽中
            }
        }
    }
    else if (eState[idx] == 1) {
        // 跟随手指/鼠标
        eGo[idx].transform.position = GetWorldPosFromMouse();
        if (Input.GetMouseButtonUp(0)) {
            // 检查是否在目标范围内
            float dist = Vector3.Distance(eGo[idx].transform.position, dropTargetPos);
            if (dist < dropRadius) {
                // 成功放置
                OnDragSuccess(idx);
            } else {
                // 弹回原位
                eState[idx] = 0;
            }
        }
    }
}
```

---

## Upgradeable 模板
点击 → 扣资源 → 外观变化 → 属性提升。

```csharp
void UpdateUpgradeable(int idx, float dt) {
    if (eState[idx] == 0) {
        // 等待点击
        if (IsClicked(eGo[idx]) && gold >= upgradeCost) {
            gold -= upgradeCost;
            eState[idx] = 1;  // 升级动画
            eTimer[idx] = 0;
        }
    }
    else if (eState[idx] == 1) {
        // 升级动画
        eTimer[idx] += dt;
        float t = eTimer[idx] / 0.5f;
        eGo[idx].transform.localScale = Vector3.Lerp(originalScale, upgradedScale, t);
        if (t >= 1f) {
            eState[idx] = 2;  // 升级完成
            // 可继续升级到下一级
        }
    }
}
```

---

## Projectile 模板
弹药飞行 + 命中检测。从对象池取出，飞向目标，命中后回收。

```csharp
// 弹药用数组管理（对象池）
Vector3[] arrowTarget = new Vector3[MAX_ARROWS];
bool[] arrowActive = new bool[MAX_ARROWS];

void UpdateProjectiles(float dt) {
    for (int i = 0; i < MAX_ARROWS; i++) {
        if (!arrowActive[i]) continue;
        Vector3 dir = (arrowTarget[i] - arrowGo[i].transform.position).normalized;
        arrowGo[i].transform.position += dir * arrowSpeed * dt;
        arrowGo[i].transform.forward = dir;
        // 命中检测
        if (Vector3.Distance(arrowGo[i].transform.position, arrowTarget[i]) < 0.5f) {
            // 对目标造成伤害
            DamageNearestEnemy(arrowTarget[i], arrowDamage);
            RecycleArrow(i);
        }
    }
}
```

---

## Phase 转场

```csharp
void CheckPhaseTransition() {
    switch (currentPhase) {
        case 1:
            if (eState[E_CONVEYOR] == 2) AdvancePhase(2);
            break;
        case 2:
            if (enemyKillCount >= 3) AdvancePhase(3);
            break;
        // ...每个 phase 一行条件判断
    }
}

void AdvancePhase(int next) {
    currentPhase = next;
    // 激活该 phase 的实体
    // 更新镜头
    // 显示引导文案
}
```

---

## 关键约束（Luna）
- 所有代码在一个文件 `GameFlowManagerMain.cs`
- 用 `GFM_Create.Obj("Cube"/"Sphere"/"Cylinder")` 创建对象
- 用 `GFM_Create.SetColor(go, new Color(r,g,b))` 设置颜色
- 不能用 `CreatePrimitive`、`Resources.Load`、`async/await`
- 不能用协程，必须用 Update() + 状态变量
- 不能用泛型（`List<T>` 不行，用数组）
- 用 `GFM_Tools.SliderValue("name")` 读取虚拟摇杆
- 对象隐藏用 `transform.position = new Vector3(0, -999, 0)` 而非 `SetActive(false)`
- 游戏结束调用 `Luna.Unity.LifeCycle.GameEnded()`
- CTA 调用 `Luna.Unity.Playable.InstallFullGame()`
