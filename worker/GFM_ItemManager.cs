// ============================================================================
// GFM_ItemManager.cs — 物品/道具管理器（单例 / 空壳占位）
// ----------------------------------------------------------------------------
// 职责：【占位模板，默认未启用】
//       多数试玩广告的"物品"是计数资源（归 GFM_EconomyManager 管理），
//       "可拾取对象"是场景里预置的池对象（归主文件的实体引用直接管），
//       不需要动态生成/掉落/库存格子。
//
//       本文件作为架构模板存在，未来真的需要 Item 动态管理时再填。
//
// 未来填充时的推荐接口：
//   - SpawnItem(string itemId, Vector3 pos) —— 在场景里掉落一个物品
//   - PickupItem(int itemSlotId) —— 玩家拾取 (加到 inventory + 隐藏对象)
//   - DropItem(string itemId, Vector3 pos) —— 从 inventory 扔一个出来
//   - Tick(float dt) —— 物品生命周期 (过期消失 / 动画 / 特效)
//
// 与 GFM_EconomyManager 的边界：
//   - EconomyManager 管"抽象资源数量" (int 计数)
//   - ItemManager 管"场景里的物品 GameObject 实例" (带坐标/状态)
//   - 一个物品被拾取 → ItemManager 隐藏对象 → EconomyManager.AddResource
//
// 设计约束 (Luna 兼容):
//   - 不用 Destroy()，物品消失 = 挪到 (0,-999,0)
//   - 物品对象走 GameObject.Find(池名)，不能 Instantiate 新对象
// ============================================================================

using UnityEngine;

public class GFM_ItemManager : MonoBehaviour
{
    // ========================================================================
    // 【单例入口】懒初始化。本项目不会被触发访问。
    // ========================================================================
    private static GFM_ItemManager _instance;
    public static GFM_ItemManager Instance
    {
        get
        {
            if (_instance == null)
            {
                var obj = new GameObject("GFM_ItemManager");
                _instance = obj.AddComponent<GFM_ItemManager>();
            }
            return _instance;
        }
    }

    private bool _inited = false;
    // 初始化物品管理器并清空掉落物状态。
    public void Init()
    {
        if (_inited) return;
        _inited = true;
        // TODO (未来项目): 初始化物品池、加载掉落配置
    }

    private void Awake()
    {
        if (_instance != null && _instance != this) { enabled = false; return; }
        _instance = this;
        Init();
    }

    // ========================================================================
    // 【主循环钩子】未来项目里主 Update 每帧调 Tick(dt) 推进物品生命周期。
    // ========================================================================
    public void Tick(float dt)
    {
        // TODO (未来项目): 遍历所有激活物品，处理过期/动画/特效
    }

    // ========================================================================
    // 【Spawn/Pickup/Drop 接口占位】
    // ========================================================================
    public int SpawnItem(string itemId, Vector3 pos)
    {
        // TODO (未来项目): 从池里取一个物品对象挪到 pos，返回 slot id
        return -1;
    }

    // 拾取指定物品并返回是否成功。
    public bool PickupItem(int itemSlotId)
    {
        // TODO (未来项目): 按 slot 找到对象，挪到 (0,-999,0)，EconomyManager.AddResource
        return false;
    }

    // 在指定位置掉落一个物品。
    public void DropItem(string itemId, Vector3 pos)
    {
        // TODO (未来项目): 从 inventory 扣 1 个，Spawn 到 pos
    }
}
