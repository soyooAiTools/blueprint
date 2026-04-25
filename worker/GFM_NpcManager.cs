// ============================================================================
// GFM_NpcManager.cs — NPC 管理器（单例 / 空壳占位）
// ----------------------------------------------------------------------------
// 职责：【占位模板，默认未启用】
//       试玩广告如果只有静态"建筑桩"和可拾取"资源桩"，不需要 NPC 管理。
//       本文件作为架构模板存在，当需要巡逻/敌对/可对话 NPC 时再填。
//
// 未来填充时的推荐接口：
//   - SpawnNpc(string templateId, Vector3 pos) —— 按模板生成 NPC
//   - DespawnNpc(int id) —— 挪到屏幕外 (不用 Destroy, Luna 禁用)
//   - GetAllNpcs() —— 主循环需要遍历做 AI/战斗
//   - Tick(float dt) —— 每帧调度所有 NPC 行为树
//
// NPC 行为模板参考 /opt/blueprint-editor/adapters/templates/npc/*.cjs:
//   patrol / chase_attack / static_target / ranged_shooter / spawner /
//   wander / evade / defend / circle / group_attack / flee_on_hit /
//   boss_multiphase  (共 12 个预制模板)
//
// 设计约束 (Luna 兼容):
//   - 不用 Destroy()，NPC 销毁 = 挪到 (0,-999,0)
//   - 不用 Dictionary，用 NPC id → slot index 平行数组
// ============================================================================

using UnityEngine;

public class GFM_NpcManager : MonoBehaviour
{
    // ========================================================================
    // 【单例入口】懒初始化。本项目不会被触发访问。
    // ========================================================================
    private static GFM_NpcManager _instance;
    public static GFM_NpcManager Instance
    {
        get
        {
            if (_instance == null)
            {
                var obj = new GameObject("GFM_NpcManager");
                _instance = obj.AddComponent<GFM_NpcManager>();
            }
            return _instance;
        }
    }

    private bool _inited = false;
    // 初始化 NPC 管理器和对象池引用。
    public void Init()
    {
        if (_inited) return;
        _inited = true;
        // TODO (未来项目): 初始化 NPC 池、加载行为模板、注册事件监听
    }

    private void Awake()
    {
        if (_instance != null && _instance != this) { enabled = false; return; }
        _instance = this;
        Init();
    }

    // ========================================================================
    // 【主循环钩子】未来项目里主 Update 每帧调 Tick(dt) 推进所有 NPC 行为。
    // ========================================================================
    public void Tick(float dt)
    {
        // TODO (未来项目): 遍历所有激活 NPC，执行对应行为模板 (patrol/chase/...)
    }

    // ========================================================================
    // 【Spawn/Despawn 接口占位】
    // ========================================================================
    public int SpawnNpc(string templateId, Vector3 pos)
    {
        // TODO (未来项目): 从池里取一个 NPC 对象，挪到 pos，绑定 templateId
        return -1;
    }

    // 隐藏并回收指定 NPC。
    public void DespawnNpc(int npcId)
    {
        // TODO (未来项目): 按 npcId 找到对应对象，挪到 (0,-999,0) 隐藏
    }
}
