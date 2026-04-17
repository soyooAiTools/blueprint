# Codex 第一批任务：模板覆盖率提升

> 目标：将模板覆盖率从 ~80% 提升到 ~92%
> 工具：codex exec (gpt-5.4, ChatGPT auth)
> 原则：每个任务独立文件，不改现有代码，最后统一集成

---

## 任务总览

| # | 任务 | 新建文件 | 预期行数 | 优先级 | 依赖 |
|---|------|---------|---------|--------|------|
| 1 | NPC: wander (闲逛) | npc-behaviors/wander.cjs | ~35 | P0 | 无 |
| 2 | NPC: evade (低血逃离) | npc-behaviors/evade.cjs | ~55 | P0 | 无 |
| 3 | NPC: defend (定点防守) | npc-behaviors/defend.cjs | ~45 | P0 | 无 |
| 4 | NPC: circle (绕圈) | npc-behaviors/circle.cjs | ~40 | P1 | 无 |
| 5 | NPC: group-attack (群攻) | npc-behaviors/group-attack.cjs | ~60 | P1 | 无 |
| 6 | NPC: flee-on-hit (受击逃跑) | npc-behaviors/flee-on-hit.cjs | ~50 | P2 | 无 |
| 7 | NPC: boss-multiphase (Boss 多阶段) | npc-behaviors/boss-multiphase.cjs | ~80 | P2 | 无 |
| 8 | 资源收集流程模板 | templates/resource-flow.cjs | ~120 | P0 | 无 |
| 9 | 升级/形态触发模板 | templates/upgrade-logic.cjs | ~80 | P1 | 无 |

---

## 通用规范（每个任务 prompt 前置）

```
== 代码规范（必须严格遵守）==

1. 语法：ES5 strict — 只用 var，不用 const/let/arrow function/template literal/class
2. 导出：module.exports = { fn1: fn1, fn2: fn2 }; （不用简写）
3. 依赖：var { toLowerCamel } = require('../trigger-codegen.cjs');
   - toLowerCamel 是 identity 函数，返回原样 PascalCase 字符串
4. 每个模板必须导出 3 个函数：
   - generateVariables(npc) → 返回变量声明字符串（缩进 4 空格）
   - generateUpdate(npc)    → 返回 Update 调用字符串（缩进 8 空格）
   - generateSystem(npc)    → 返回完整方法体字符串（缩进 4 空格）
5. C# 代码约束（生成的字符串内容）：
   - 不用泛型 List<T>/Dictionary<K,V> — 用数组
   - 不用 SetActive() — 用 HideObj()/PlaceObj()
   - 不用 coroutine/async/await — 用 Update + timer
   - 不用 LINQ / System.Linq
   - 浮点数必须带 f 后缀: 3.0f 不是 3.0
   - 方法命名: Update{EntityName}(float dt)
6. npc 对象结构:
   {
     entity: "EnemyCamp",    // PascalCase 实体名
     template: "chase_attack", // 模板名
     params: {               // 模板特有参数
       hp: 5, detectRange: 8, attackRange: 1.5,
       attackDamage: 2, attackInterval: 1.0, moveSpeed: 3,
       // ... 模板自定义参数
     }
   }
7. 变量命名：var v = toLowerCamel(npc.entity); 然后用 v + 'HP', v + 'State' 等
8. 写完后运行 node -c <文件名> 验证语法
```

---

## 任务 1: NPC wander (闲逛)

```bash
codex exec \
  --skip-git-repo-check --ephemeral \
  -m gpt-5.4 -s danger-full-access \
  -C /opt/blueprint-editor <<'PROMPT'

读取以下参考文件，理解 NPC 行为模板的精确结构:
- adapters/templates/npc-behaviors/patrol.cjs（最相似的参考）
- adapters/templates/trigger-codegen.cjs（toLowerCamel 函数）

然后创建 adapters/templates/npc-behaviors/wander.cjs

行为描述：wander（闲逛）
- 和 patrol 类似但更随机：每隔 2-5 秒随机选一个方向移动
- 不主动攻击，不追踪玩家
- 移动速度使用 params.moveSpeed
- 范围限制：距离初始位置不超过 params.wanderRadius，超出则折返

params 期望字段：
- moveSpeed: number (移动速度)
- wanderRadius: number (闲逛半径)

变量需求：
- {v}WanderTimer: float (下次转向计时器)
- {v}WanderDir: Vector3 (当前移动方向)
- {v}StartPos: Vector3 (初始位置，Start 时记录)

generateSystem 要点：
- 计时器归零时随机新方向
- 检查距 startPos 距离，超过 wanderRadius 则方向取反
- 不需要和玩家交互

代码规范：ES5 strict，只用 var，不用 const/let/arrow function。
浮点数带 f 后缀。缩进用空格。

写完后运行 node -c adapters/templates/npc-behaviors/wander.cjs 验证。
PROMPT
```

---

## 任务 2: NPC evade (低血逃离)

```bash
codex exec \
  --skip-git-repo-check --ephemeral \
  -m gpt-5.4 -s danger-full-access \
  -C /opt/blueprint-editor <<'PROMPT'

读取以下参考文件:
- adapters/templates/npc-behaviors/chase-attack.cjs（基础追击逻辑，复用结构）
- adapters/templates/npc-behaviors/patrol.cjs（移动逻辑参考）
- adapters/templates/trigger-codegen.cjs

创建 adapters/templates/npc-behaviors/evade.cjs

行为描述：evade（低血逃离）
- HP > 50%: 和 chase_attack 一样追击攻击玩家
- HP <= 50%: 停止攻击，转向远离玩家方向逃跑，速度提升 50%
- HP <= 0: 死亡，HideObj + enemiesDefeated++

params 期望字段:
- hp: int
- detectRange: number (检测距离)
- attackRange: number (攻击距离)
- attackDamage: int
- attackInterval: number (攻击间隔)
- moveSpeed: number (基础移动速度，逃跑时 * 1.5f)

变量需求:
- {v}HP: int
- {v}State: int (0=idle, 1=chase, 2=evade, 3=dead)
- {v}AttackTimer: float

generateSystem 逻辑:
1. state == 3 → return
2. HP <= 0 → state = 3, HideObj, enemiesDefeated++
3. HP <= maxHP/2 → state = 2, 远离玩家方向移动 (speed * 1.5f)
4. dist < detectRange → state = 1, 追击 + 攻击
5. else → state = 0, 静止

注意：maxHP 需要额外变量 {v}MaxHP = params.hp（在 generateVariables 里声明）

代码规范：ES5 strict，只用 var，不用 const/let/arrow function。
浮点数带 f 后缀。写完运行 node -c 验证。
PROMPT
```

---

## 任务 3: NPC defend (定点防守)

```bash
codex exec \
  --skip-git-repo-check --ephemeral \
  -m gpt-5.4 -s danger-full-access \
  -C /opt/blueprint-editor <<'PROMPT'

读取参考文件:
- adapters/templates/npc-behaviors/static-target.cjs（最相似：不移动）
- adapters/templates/npc-behaviors/chase-attack.cjs（攻击逻辑参考）
- adapters/templates/trigger-codegen.cjs

创建 adapters/templates/npc-behaviors/defend.cjs

行为描述：defend（定点防守）
- 固定在原位不移动
- 当玩家进入 detectRange 时开始攻击
- 攻击间隔 attackInterval，伤害 attackDamage
- 可以被玩家击杀（HP <= 0 → 死亡）

params 期望字段:
- hp: int
- detectRange: number
- attackDamage: int
- attackInterval: number

变量需求:
- {v}HP: int
- {v}Done: bool
- {v}AttackTimer: float

generateSystem:
1. done → return
2. HP <= 0 → done = true, HideObj, enemiesDefeated++
3. 计算与 player 距离
4. dist < detectRange → 减 attackTimer, 到 0 则 playerHP -= damage

代码规范：ES5 strict，只用 var。写完运行 node -c 验证。
PROMPT
```

---

## 任务 4: NPC circle (绕圈)

```bash
codex exec \
  --skip-git-repo-check --ephemeral \
  -m gpt-5.4 -s danger-full-access \
  -C /opt/blueprint-editor <<'PROMPT'

读取参考文件:
- adapters/templates/npc-behaviors/patrol.cjs
- adapters/templates/trigger-codegen.cjs

创建 adapters/templates/npc-behaviors/circle.cjs

行为描述：circle（绕圈移动）
- 围绕初始位置做圆形移动（用 sin/cos 计算）
- 不主动攻击
- 用于装饰性 NPC（鸟、鱼、卫星等）

params 期望字段:
- moveSpeed: number (角速度，弧度/秒)
- circleRadius: number (圆形半径)

变量需求:
- {v}CircleAngle: float (当前角度)
- {v}CenterPos: Vector3 (初始中心位置)

generateSystem:
1. angle += moveSpeed * dt
2. x = center.x + radius * Mathf.Cos(angle)
3. z = center.z + radius * Mathf.Sin(angle)
4. entity.transform.position = new Vector3(x, center.y, z)

注意: Mathf.Cos/Mathf.Sin 在 Luna 中可用。

代码规范：ES5 strict，只用 var。写完运行 node -c 验证。
PROMPT
```

---

## 任务 5: NPC group-attack (群攻)

```bash
codex exec \
  --skip-git-repo-check --ephemeral \
  -m gpt-5.4 -s danger-full-access \
  -C /opt/blueprint-editor <<'PROMPT'

读取参考文件:
- adapters/templates/npc-behaviors/chase-attack.cjs（单体追击，要扩展为多体）
- adapters/templates/npc-behaviors/spawner.cjs（多实体管理参考）
- adapters/templates/trigger-codegen.cjs

创建 adapters/templates/npc-behaviors/group-attack.cjs

行为描述：group-attack（群体攻击）
- 管理多个同类实体（params.count 个）
- 每个实体独立追击玩家
- 用数组跟踪每个实体的 HP 和状态
- 全部死亡后设置 {entity}Done = true

params 期望字段:
- count: int (群体数量，最多 5)
- hp: int (每个个体 HP)
- detectRange: number
- attackRange: number
- attackDamage: int
- attackInterval: number
- moveSpeed: number
- spawnRadius: number (初始分布半径)

变量需求:
- {v}GroupHP: int 数组 (用 new int[count] 声明)
- {v}GroupState: int 数组 (0=idle,1=chase,2=dead)
- {v}GroupTimer: float 数组
- {v}GroupObj: GameObject 数组
- {v}Done: bool
- {v}GroupAlive: int

generateVariables 要点:
- 数组声明: int[] {v}GroupHP = new int[{count}];
  （注意 Luna 中 new int[5] 可用，但不能用 List<int>）

generateSystem 要点:
- for (int i = 0; i < count; i++) 循环处理每个个体
- 每个个体独立检测距离、追击、攻击
- 当 GroupAlive <= 0 时设 Done = true

注意: Luna 中可以用 for 循环和 int[]，但不能用 List<T>。
C# 循环变量用 int 不用 var。

代码规范：ES5 (外层 JS) strict，只用 var。
生成的 C# 字符串里可以用 int i (C# 不是 JS)。
写完运行 node -c 验证。
PROMPT
```

---

## 任务 6: NPC flee-on-hit (受击逃跑)

```bash
codex exec \
  --skip-git-repo-check --ephemeral \
  -m gpt-5.4 -s danger-full-access \
  -C /opt/blueprint-editor <<'PROMPT'

读取参考文件:
- adapters/templates/npc-behaviors/chase-attack.cjs
- adapters/templates/npc-behaviors/patrol.cjs
- adapters/templates/trigger-codegen.cjs

创建 adapters/templates/npc-behaviors/flee-on-hit.cjs

行为描述：flee-on-hit（受击逃跑）
- 默认状态：patrol 巡逻
- 被玩家攻击后（HP 减少时）：切换到逃跑模式
- 逃跑持续 params.fleeDuration 秒后恢复巡逻
- 适用于：兔子、鹿等需要猎杀的动物

params 期望字段:
- hp: int
- moveSpeed: number (正常巡逻速度)
- fleeSpeed: number (逃跑速度)
- fleeDuration: number (逃跑持续秒数)
- patrolRadius: number (巡逻半径)

变量需求:
- {v}HP: int
- {v}LastHP: int (上一帧 HP，用于检测被攻击)
- {v}State: int (0=patrol, 1=flee, 2=dead)
- {v}FleeTimer: float
- {v}PatrolTimer: float
- {v}PatrolTarget: Vector3

generateSystem:
1. dead → return
2. HP <= 0 → state=2, HideObj, enemiesDefeated++
3. if (HP < lastHP) → state=1, fleeTimer=fleeDuration（被攻击了）
4. lastHP = HP
5. state==1: 远离玩家，fleeTimer 倒计时，到 0 回 state=0
6. state==0: patrol 巡逻逻辑（复用 patrol 的随机方向）

代码规范：ES5 strict，只用 var。写完运行 node -c 验证。
PROMPT
```

---

## 任务 7: NPC boss-multiphase (Boss 多阶段)

```bash
codex exec \
  --skip-git-repo-check --ephemeral \
  -m gpt-5.4 -s danger-full-access \
  -C /opt/blueprint-editor <<'PROMPT'

读取参考文件:
- adapters/templates/npc-behaviors/chase-attack.cjs
- adapters/templates/npc-behaviors/ranged-shooter.cjs
- adapters/templates/trigger-codegen.cjs

创建 adapters/templates/npc-behaviors/boss-multiphase.cjs

行为描述：boss-multiphase（Boss 多阶段战斗）
- HP > 66%: Phase 1 — 近战追击（chase_attack 逻辑）
- HP 33%-66%: Phase 2 — 远程攻击（ranged_shooter 逻辑，不再追击）
- HP < 33%: Phase 3 — 狂暴（速度 x2，攻击间隔 x0.5）
- HP <= 0: 死亡

params 期望字段:
- hp: int (总 HP，需要较高，如 20-50)
- detectRange: number
- attackRange: number (近战)
- fireRange: number (远程)
- attackDamage: int (近战伤害)
- projectileDamage: int (远程伤害)
- attackInterval: number (基础攻击间隔)
- fireInterval: number (远程射击间隔)
- moveSpeed: number
- projectileSpeed: number

变量需求:
- {v}HP: int
- {v}MaxHP: int (= params.hp)
- {v}BossPhase: int (1/2/3)
- {v}AttackTimer: float
- {v}FireTimer: float
- {v}State: int (0=idle, 1=active, 2=dead)

generateSystem:
1. state == 2 → return
2. HP <= 0 → state=2, HideObj, enemiesDefeated++
3. 计算 hpPercent = HP * 100 / MaxHP
4. hpPercent > 66 → BossPhase=1: chase + melee
5. hpPercent > 33 → BossPhase=2: 停止移动, 远程射击
6. else → BossPhase=3: chase 但 moveSpeed*2, attackInterval*0.5

注意: GFM_Pool.Get("projectile") 获取投射物。
投射物用 Rigidbody 不可用时改用 transform.position 每帧移动。

代码规范：ES5 strict，只用 var。写完运行 node -c 验证。
PROMPT
```

---

## 任务 8: 资源收集流程模板 (P0 — 最高 ROI)

```bash
codex exec \
  --skip-git-repo-check --ephemeral \
  -m gpt-5.4 -s danger-full-access \
  -C /opt/blueprint-editor <<'PROMPT'

读取以下文件，完整理解模板引擎架构:
- adapters/codegen-template-engine.cjs（主引擎，理解 fillSkeleton 流程）
- adapters/templates/economy.cjs（现有经济初始化模板）
- adapters/templates/trigger-codegen.cjs（toLowerCamel 和 triggerToCondition）
- adapters/templates/autoplay-mirror.cjs（自动播放镜像，理解 trigger 到代码映射）
- adapters/schema/game-schema.json（完整 schema 定义）
- fixtures/schema-codegen/e2e-idle-game.json（示例 schema 数据）

创建 adapters/templates/resource-flow.cjs

功能：从 schema 的 resources[] + phases[] 自动推断资源收集/投递/转化流程，
生成可直接嵌入 TODO_UPDATE 区域的 C# 代码。

导出接口:
module.exports = {
  generateResourceUpdate: generateResourceUpdate,
  generateResourceVariables: generateResourceVariables
};

=== generateResourceVariables(schema) ===
分析 schema.resources 和 schema.phases，生成需要的额外变量:
- 每个 resource 的 carryCount: int {resourceName}Carried = 0;
- 如果有 convertRatio > 0 的 resource: bool {entityName}Converting = false;

返回: 缩进 4 空格的 C# 变量声明字符串

=== generateResourceUpdate(schema) ===
核心逻辑 — 分析 phases 中的 trigger 类型，推断资源流程:

1. 扫描所有 phase.trigger:
   - trigger.type === 'resource_collected' → 说明这个 phase 需要收集资源
   - 找到 schema.resources 中 name === trigger.resource 的定义
   - 获取 resource.entity → 这是资源来源实体

2. 生成 C# Update 代码:
   a. 接近检测: if (IsNear({sourceEntity}, collectRange))
   b. 收集动作: {resourceName}Carried += 1; (但不超过 maxCarry)
   c. 满载检测: if ({resourceName}Carried >= maxCarry) guideText.text = "背包已满!"
   d. 投递检测: 如果 schema 中有 convertRatio > 0，寻找对应 entity
      → if (IsNear({targetEntity}, collectRange) && {resourceName}Carried > 0)
      → AddResource("{resourceName}", {resourceName}Carried); {resourceName}Carried = 0;
   e. scoreText 更新: scoreText.text = "{resourceName}: " + GetResource("{resourceName}");

3. 如果 phase trigger 是 entity_state_reached:
   - 检查是否有 resource 的 entity 匹配该 entity
   - 如果是 → 生成建造逻辑:
     if (IsNear({entity}, 2f) && GetResource("{resource}") >= {cost})
       { SpendResource("{resource}", {cost}); {entity}State++; }

返回: 缩进 8 空格的 C# 代码字符串

=== 示例输入输出 ===

输入 (e2e-idle-game.json):
- resources: [{ name: "wood", entity: "TreeSource", convertRatio: 3 }]
- phases[0].trigger: { type: "resource_collected", resource: "wood", amount: 3 }
- phases[1].trigger: { type: "entity_state_reached", entity: "House", state: 2 }

期望输出 (generateResourceUpdate):
```csharp
        // Resource: wood from TreeSource
        if (IsNear(TreeSource, collectRange)) {
            if (woodCarried < maxCarry) {
                woodCarried++;
                scoreText.text = "Wood: " + woodCarried + "/" + maxCarry;
            }
        }
        // Deliver wood to build House
        if (IsNear(House, 2f) && woodCarried > 0) {
            AddResource("wood", woodCarried);
            woodCarried = 0;
            if (GetResource("wood") >= 3) {
                HouseState++;
            }
        }
```

代码规范：外层 JS 用 ES5 strict（只用 var），生成的 C# 字符串遵循 Luna 约束。
注意：
- IsNear() 是骨架预定义的辅助函数: bool IsNear(GameObject obj, float range)
- AddResource/GetResource/SpendResource 是骨架预定义的经济函数
- collectRange 和 maxCarry 是骨架预定义的成员变量
- 变量名保持 PascalCase (toLowerCamel 不做转换)

写完后运行 node -c adapters/templates/resource-flow.cjs 验证。
PROMPT
```

---

## 任务 9: 升级/形态触发模板

```bash
codex exec \
  --skip-git-repo-check --ephemeral \
  -m gpt-5.4 -s danger-full-access \
  -C /opt/blueprint-editor <<'PROMPT'

读取以下文件:
- adapters/templates/economy.cjs（现有 form 初始化）
- adapters/templates/phase-init.cjs（phase onEnter 中 switch_form action）
- adapters/templates/autoplay-mirror.cjs（autoplay 中 switch_form 镜像）
- adapters/codegen-template-engine.cjs（理解 TODO 系统）
- adapters/schema/game-schema.json（form 定义结构）

创建 adapters/templates/upgrade-logic.cjs

功能：当 schema 中有 forms[] 定义时，自动生成升级检查逻辑。

导出接口:
module.exports = {
  generateUpgradeUpdate: generateUpgradeUpdate,
  generateUpgradeVariables: generateUpgradeVariables
};

=== generateUpgradeVariables(schema) ===
- int currentFormIndex = 0;
- 每个 form (除 index 0): bool {formId}Unlocked = false;
返回: 缩进 4 空格的变量声明

=== generateUpgradeUpdate(schema) ===
分析 schema.phases 中的 onComplete 和 onEnter，找到 switch_form action:

1. 扫描 phases:
   - 如果 phase.onComplete 含 { action: "switch_form", formIndex: N }
   - 记录: 完成 phaseId 时切换到 form N

2. 生成 C# 代码:
   - 在 Update 中检查是否刚完成了触发升级的 phase
   - if (!{formId}Unlocked && completedPhases.Contains("{phaseId}"))
   -     { {formId}Unlocked = true; SwitchForm({formIndex}); }
   - 注意: completedPhases 是骨架预定义的 string[] (不是 List)
     检查方式: 遍历数组 indexOf 或手动 for 循环
     实际用法: 检查 currentPhaseName 是否已经过了该 phase

3. 简化方案：不依赖 completedPhases 数组，
   而是用 phase 索引比较:
   if (currentFormIndex < {targetIndex} && currentPhaseIndex > {triggerPhaseIndex})
     { SwitchForm({targetIndex}); currentFormIndex = {targetIndex}; }

返回: 缩进 8 空格的 C# 代码

代码规范：ES5 strict，只用 var。写完运行 node -c 验证。
PROMPT
```

---

## 执行顺序建议

```
Day 1: 任务 1-3 (wander/evade/defend) — 最简单的 NPC，验证 Codex 产出质量
Day 2: 任务 8 (resource-flow) — 最高 ROI，依赖 Day 1 验证出的经验
Day 3: 任务 4-6 (circle/group-attack/flee-on-hit)
Day 4: 任务 7, 9 (boss-multiphase, upgrade-logic)
Day 5: Claude Code 集成 — 修改 codegen-template-engine.cjs + game-schema.json + 回归测试
```

## Codex 产出验证检查清单

每个任务完成后人工快速检查:

- [ ] `node -c` 语法通过
- [ ] 只用 var，没有 const/let/=>
- [ ] module.exports 导出了 generateVariables, generateUpdate, generateSystem 三个函数
- [ ] require 路径正确: require('../trigger-codegen.cjs')
- [ ] 变量名用 toLowerCamel(npc.entity) 而非硬编码
- [ ] C# 浮点数有 f 后缀
- [ ] 没有 List<T>/SetActive/coroutine/LINQ
- [ ] 缩进层级正确 (变量 4 空格, update 调用 8 空格, 方法体 4 空格)
