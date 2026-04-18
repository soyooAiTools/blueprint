# Feedback Reform Spec — 4 项系统性改造

**Author**: AI + Nick review
**Date**: 2026-04-18
**Status**: Draft — 待确认

---

## 目录

- [Phase 2A] #4 项目结构规范化
- [Phase 2B] #8 GameSceneCtrl 场景管理单例
- [Phase 3A] #3 ScriptActivator 脚本绑定方案
- [Phase 3B] #7 Pool Manifest 对象池懒激活

---

## [Phase 2A] #4 项目结构规范化

### 现状

codegen 只生成 `Assets/Program/Script/Manager/GameFlowManagerMain.cs`，不管项目文件夹结构。
当前模板工程 (`luna-base-template`) 的 Assets/ 布局是扁平的，没有按资源类型分目录。

### 目标结构

```
Assets/
├── Images/           # 图片/贴图/Sprite
├── Fbxs/             # 3D 模型 (.fbx)
├── Prefabs/          # 预制体
├── Program/
│   └── Script/
│       ├── Commons/  # 通用工具脚本 (GFM_*.cs 搬到这里)
│       ├── Models/   # 角色/场景对象脚本
│       ├── UIs/      # UI 脚本
│       └── Manager/  # 管理类 (GameFlowManagerMain.cs, GameSceneCtrl.cs)
├── Resources/        # 运行时加载资源 (DefaultFont.ttf 等)
├── Scenes/           # 场景文件
└── Materials/        # 材质
```

### 改动范围

| 文件 | 改动 | 风险 |
|------|------|------|
| `luna-base-template` 仓库 | 按上述结构重组 Assets/ 目录 | 低 — 纯资源移动 |
| `worker/gfm-files.cjs` | `copyGfmToProject()` 目标改为 `Commons/` | 低 |
| `worker/claude-code-coder.js` | GFM 复制目标路径从 `Manager/` 改为 `Commons/` | 低 |
| `worker/worker-coder.js` | 同上，4 处复制路径更新 | 低 |
| `engine/stages/compile.cjs` | 源码保存路径可能需更新 | 低 |
| Luna 构建系统 | 验证 build-api 能正确编译新路径下的 .cs 文件 | **中** — 需实测 |

### 不改的

- codegen 生成的 C# 代码本身（仍然一个 GameFlowManagerMain.cs）
- 运行时逻辑
- 对象池结构

### 验证标准

1. `luna-base-template` 重组后，现有 `templeteScene.unity` 中所有引用不丢失
2. build-api 编译成功（全部 .cs 都被包含）
3. 一个新任务端到端通过 codegen → compile → CUA

### 预估工作量

**0.5 天** — 主要是模板仓库重组 + 路径更新 + 构建验证

---

## [Phase 2B] #8 GameSceneCtrl 场景管理单例

### 现状

`GameFlowManagerMain` 承担所有职责：
- 场景实体管理（Find、位置、显隐）
- 游戏流程控制（phase 状态机）
- 输入处理
- UI 更新
- AutoPlay 逻辑

整个文件经常超过 1000 行，AI 编码时容易遗漏或冲突。

### 方案

从 skeleton 中提取场景实体管理逻辑到独立的 `GameSceneCtrl` 单例类。

```
GameFlowManagerMain.cs          GameSceneCtrl.cs (新)
─────────────────────           ─────────────────
phase 状态机                      实体注册表
输入处理                          Find + 缓存
游戏逻辑 (Update/CheckEvent)      位置/显隐/缩放辅助方法
UI 更新                           实体分组管理
AutoPlay                         碰撞检测辅助
```

### GameSceneCtrl API 设计

```csharp
public class GameSceneCtrl : MonoBehaviour
{
    public static GameSceneCtrl instance;

    // 实体注册表 — skeleton 生成 Start() 时批量注册
    private Dictionary<string, GameObject> _entities;

    public static GameSceneCtrl Init(GameObject parent) { ... }

    // 注册实体（替代散落的 GameObject.Find）
    public void Register(string name, string poolName)
    {
        _entities[name] = GameObject.Find(poolName);
    }

    // 获取实体
    public GameObject Get(string name) { return _entities[name]; }

    // 位置/显隐
    public void Show(string name, Vector3 pos) { ... }
    public void Hide(string name) { ... }  // 移到 (0,-999,0)
    public void SetScale(string name, Vector3 scale) { ... }

    // 距离检测
    public bool IsNear(string a, string b, float range) { ... }
    public string FindNearest(string origin, string[] candidates) { ... }
}
```

### skeleton-generator.cjs 改动

```
Before (GameFlowManagerMain.cs Start()):
    player = GameObject.Find("__Pool_Cube_Blue_01");
    enemy = GameObject.Find("__Pool_Sphere_Red_01");
    player.transform.position = new Vector3(0, 0.5f, 0);

After:
    GameSceneCtrl.Init(gameObject);
    GameSceneCtrl.instance.Register("Player", "__Pool_Cube_Blue_01");
    GameSceneCtrl.instance.Register("Enemy", "__Pool_Sphere_Red_01");
    GameSceneCtrl.instance.Show("Player", new Vector3(0, 0.5f, 0));
```

### 改动范围

| 文件 | 改动 | 风险 |
|------|------|------|
| `worker/GameSceneCtrl.cs` | **新文件** — 场景管理单例 | 低 |
| `worker/gfm-files.cjs` | GFM_FILES 列表新增 `GameSceneCtrl.cs` | 低 |
| `adapters/skeleton-generator.cjs` | Start() 中 Find 改为 Register，位置操作改为 Show/Hide | **中** |
| `adapters/templates/placement.cjs` | 位置设置改用 GameSceneCtrl API | 中 |
| `worker/luna-claude-code.md` | 文档新增 GameSceneCtrl API 说明 | 低 |
| `worker/GFM_Tools_API.md` | 新增 GameSceneCtrl 章节 | 低 |
| `engine/static-check.cjs` | 可选：新增规则检测裸 `GameObject.Find` 建议用 GameSceneCtrl | 低 |

### 不改的

- GameFlowManagerMain.cs 的 phase 逻辑、Update、CheckEventRules 结构不变
- AI codegen 仍然填写 TODO 标记，只是引用方式从 `player.transform.position` 改为 `GameSceneCtrl.instance.Show("Player", pos)`
- 对象池结构不变

### 风险点

1. **AI coder 适配**: Opus/Haiku 需要学会用 `GameSceneCtrl.instance.Get("name")` 取代直接变量引用。prompt 更新可以覆盖。
2. **Skeleton 变量声明**: 当前 skeleton 为每个 entity 声明一个 `GameObject xxx;` 变量。引入 GameSceneCtrl 后这些变量可保留（从 Register 后 Get 回来赋值），也可去掉改为全部走 `Get("name")`。**建议保留变量声明**，减少 AI 侧改动。
3. **性能**: Dictionary lookup vs 直接变量引用。对试玩广告规模（<20 实体）影响可忽略。

### 验证标准

1. skeleton 生成的代码可编译
2. 一个现有蓝图端到端通过 codegen → compile → CUA
3. AI coder 生成的代码正确使用 GameSceneCtrl API

### 预估工作量

**1-1.5 天** — GameSceneCtrl 类 + skeleton 改造 + prompt 更新 + 端到端验证

---

## [Phase 3A] #3 ScriptActivator 脚本绑定方案

### 现状

- 160 个池对象只有基础组件（Transform/Renderer/Collider/MeshFilter）
- 所有游戏行为逻辑集中在 GameFlowManagerMain.cs 的 Update() 中
- AddComponent 被 static-check 的 blocking 规则封死
- Luna WebGL 对运行时 AddComponent 支持有限

### 方案: 预绑 ScriptActivator

在模板工程的每个 `__Pool_*` 对象上**预烘焙**一个通用 `ScriptActivator` 组件（Editor 中添加，不是运行时 AddComponent）。该组件根据配置激活不同行为。

### ScriptActivator 设计

```csharp
// 预绑在每个 __Pool_* 对象上（模板烘焙，非运行时添加）
public class ScriptActivator : MonoBehaviour
{
    [HideInInspector] public string role = "";       // "enemy" / "bullet" / "npc" / ""
    [HideInInspector] public string behavior = "";   // "patrol" / "chase" / "static" / ""
    [HideInInspector] public float param1 = 0f;      // 通用参数：速度/范围/伤害等
    [HideInInspector] public float param2 = 0f;
    [HideInInspector] public float param3 = 0f;
    [HideInInspector] public Transform target;       // 追踪目标

    // 状态
    private bool _activated = false;
    private Vector3 _patrolOrigin;
    private float _timer = 0f;
    private int _direction = 1;

    // 由 GameFlowManagerMain 在 Start() 中调用
    public void Activate(string role, string behavior, float p1, float p2, float p3)
    {
        this.role = role;
        this.behavior = behavior;
        this.param1 = p1; // speed
        this.param2 = p2; // range
        this.param3 = p3; // extra
        _patrolOrigin = transform.position;
        _activated = true;
    }

    public void Deactivate()
    {
        _activated = false;
        role = "";
        behavior = "";
    }

    void Update()
    {
        if (!_activated) return;

        switch (behavior)
        {
            case "patrol":
                // 巡逻：在 patrolOrigin 附近来回移动
                _timer += Time.deltaTime * param1; // speed
                float offset = Mathf.Sin(_timer) * param2; // range
                transform.position = _patrolOrigin + new Vector3(offset, 0, 0);
                break;

            case "chase":
                // 追踪：朝 target 移动
                if (target != null)
                {
                    transform.position = Vector3.MoveTowards(
                        transform.position, target.position,
                        param1 * Time.deltaTime);
                }
                break;

            case "rotate":
                // 旋转：持续自转
                transform.Rotate(0, param1 * Time.deltaTime, 0);
                break;

            case "bob":
                // 上下浮动
                _timer += Time.deltaTime;
                float y = _patrolOrigin.y + Mathf.Sin(_timer * param1) * param2;
                transform.position = new Vector3(transform.position.x, y, transform.position.z);
                break;
        }
    }
}
```

### 与 codegen 的集成

skeleton-generator.cjs 在 Start() 中生成激活调用：

```csharp
// Before (全部逻辑在 Update):
void Update() {
    // 手写 enemy 巡逻逻辑 (10-20行)
    enemyTimer += Time.deltaTime;
    enemy.transform.position = origin + new Vector3(Mathf.Sin(enemyTimer * 2f) * 3f, 0, 0);
}

// After (ScriptActivator 接管简单行为):
void Start() {
    var sa = enemy.GetComponent<ScriptActivator>();
    if (sa != null) sa.Activate("enemy", "patrol", 2f, 3f, 0f);
    // speed=2, range=3
}
// Update 中只剩 game-specific 逻辑（碰撞检测、phase 切换等）
```

### 改动范围

| 文件 | 改动 | 风险 |
|------|------|------|
| `worker/ScriptActivator.cs` | **新文件** — 通用行为组件 | 低 |
| `luna-base-template` 模板场景 | 每个 `__Pool_*` 对象挂 ScriptActivator | **中** — 需 Unity Editor 操作 |
| `worker/gfm-files.cjs` | GFM_FILES 新增 ScriptActivator.cs | 低 |
| `adapters/skeleton-generator.cjs` | NPC 行为检测 → 生成 `Activate()` 调用 | 中 |
| `adapters/templates/` NPC 模板 | 12 个 NPC 模板改为调用 ScriptActivator | 中 |
| `engine/static-check.cjs` | AddComponent 规则加白名单：`GetComponent<ScriptActivator>` 放行 | 低 |
| `worker/luna-claude-code.md` | 新增 ScriptActivator API 文档 | 低 |

### 注意：GetComponent 不受限制

当前 static-check 只封锁 `AddComponent`，**不封锁 `GetComponent`**。所以 `enemy.GetComponent<ScriptActivator>()` 完全合法，不需要改规则。

### 不改的

- 复杂游戏逻辑仍写在 GameFlowManagerMain.cs
- ScriptActivator 只覆盖简单重复行为（巡逻/追踪/旋转/浮动）
- 不强制使用，AI coder 可以选择不调用 Activate 而自己写 Update 逻辑

### 分阶段交付

| 阶段 | 内容 | 前置条件 |
|------|------|---------|
| 3A-1 | ScriptActivator.cs 类 + 模板烘焙 | 模板工程 Unity Editor 操作 |
| 3A-2 | skeleton 集成 + NPC 模板改造 | 3A-1 完成 |
| 3A-3 | 端到端验证 + prompt 更新 | 3A-2 完成 |

### 验证标准

1. ScriptActivator 预绑后模板工程正常编译
2. `Activate("patrol", ...)` 在 Luna WebGL 中正确运行
3. AI coder 对简单 NPC 正确调用 ScriptActivator 而非手写 30 行巡逻代码
4. 不影响现有不使用 ScriptActivator 的项目

### 预估工作量

**1.5-2 天** — 类设计 + 模板烘焙 + skeleton 改造 + 验证

---

## [Phase 3B] #7 Pool Manifest 对象池懒激活

### 现状

- 模板 160 个池对象全量预建，**实际项目平均只用 35 个（22%）**
- 所有对象初始位于 `(0, -999, 0)`，未使用的永远不动但仍占内存和加载时间
- 不能减少数量（会破坏已有项目的 `GameObject.Find` 引用）

### 方案: Pool Manifest + 按需激活

引入 `pool-manifest.json` 元数据层，codegen 阶段根据蓝图实际需求生成清单，运行时只初始化清单中的对象。

### pool-manifest.json 格式

```json
{
  "version": 1,
  "totalAvailable": 160,
  "activePool": [
    {
      "poolName": "__Pool_Cube_Blue_01",
      "entity": "Player",
      "role": "player",
      "shape": "Cube",
      "color": "Blue",
      "initialVisible": true,
      "initialPos": [0, 0.5, 0]
    },
    {
      "poolName": "__Pool_Sphere_Red_01",
      "entity": "Enemy",
      "role": "npc",
      "shape": "Sphere",
      "color": "Red",
      "initialVisible": false,
      "behavior": "patrol"
    }
  ],
  "reservedPool": [
    {
      "poolName": "__Pool_Cube_Yellow_60",
      "purpose": "carryVisual",
      "count": 5
    }
  ],
  "unused": 120
}
```

### 工作流

```
Blueprint entities        entity-resolver.cjs         pool-manifest.json
─────────────────    →    ──────────────────    →    ──────────────────
Player (Cube Blue)        matchPrefabs() 映射          activePool: 35 items
Enemy×3 (Sphere Red)      + 计算 reservedPool          reservedPool: 5 items
Tree×5 (Cube Green)                                    unused: 120 items
...                                                         ↓
                                                    skeleton-generator.cjs
                                                    只为 activePool 生成
                                                    GameObject.Find() + 位置
```

### 改动范围

| 文件 | 改动 | 风险 |
|------|------|------|
| `adapters/entity-resolver.cjs` | `matchPrefabs()` 输出新增 manifest 对象 | 低 |
| `adapters/skeleton-generator.cjs` | 读取 manifest，只为 active 对象生成代码 | 低 |
| `engine/stages/codegen-schema.cjs` | schema 新增 `poolManifest` 字段 | 低 |
| `engine/stages/compile.cjs` | manifest 写入项目目录供调试 | 低 |
| `worker/prompt-v5-basetemplate.js` | prompt 中列出"可用池对象"改为"已分配池对象" | 低 |

### 不改的

- **模板场景不变** — 仍保留 160 个对象（向后兼容）
- **matchPrefabs 算法不变** — 仍然 shape+color 映射
- **运行时不变** — unused 对象留在 (0,-999,0)，不删除

### 实际效果

| 指标 | Before | After |
|------|--------|-------|
| prompt 中列出的池对象 | 160 个（全量） | ~35 个（按需） |
| AI coder 需理解的对象数 | 160 | ~35 |
| skeleton 生成的 Find() 行数 | 与 entity 数相同（不变） | 不变 |
| 运行时内存占用 | 不变（对象仍在场景中） | 不变（lazy = 不删除，只不初始化） |
| prompt token 消耗 | ~2000 tokens 列举 160 对象 | ~500 tokens 列举 35 对象 |

**核心价值**：减少 AI coder 的认知负担（不用从 160 个对象中找），prompt 更精准，减少 token 消耗。实际场景中未用对象零成本（不占加载带宽，已在场景中但 inactive 等价）。

### 验证标准

1. manifest 生成正确，active 对象集与 skeleton 中 Find() 调用一致
2. 现有蓝图端到端通过
3. prompt token 减少 ≥1000 tokens

### 预估工作量

**0.5-1 天** — entity-resolver 输出扩展 + prompt 瘦身 + 验证

---

## 总体排期建议

| 顺序 | 任务 | 依赖 | 工作量 |
|------|------|------|--------|
| 1 | Phase 2A: 项目结构 | 无 | 0.5天 |
| 2 | Phase 3B: Pool Manifest | 无 | 0.5-1天 |
| 3 | Phase 2B: GameSceneCtrl | 建议与 2A 一起 | 1-1.5天 |
| 4 | Phase 3A: ScriptActivator | 需 Unity Editor 操作 | 1.5-2天 |

**建议 Phase 2A + 3B 先做**（风险最低，收益最快）。
Phase 2B + 3A 可并行或按需排入。
