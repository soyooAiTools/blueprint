// ============================================================================
// PoolManager.cs — 对象池 Manager（反馈 01 #8 架构图命名 alias）
// ----------------------------------------------------------------------------
// 客户反馈 #8 的架构图明确把对象池叫 `PoolManager`(单例基类下挂载)。
// 历史代码用 `GFM_Pool` 静态工具类已经被 50+ 处调用引用,直接改名会全链路炸。
// 因此 PoolManager 是一层零开销 alias:
//   - 调用方写 `PoolManager.Instance.Get(prefab)` / `PoolManager.Instance.Return(obj)`
//   - 内部全部转发到 `GFM_Pool` 已有的静态实现
//   - 旧代码继续用 `GFM_Pool.Get(prefab)` 也能跑,新生成代码优先用 PoolManager
//
// 为什么不用 GFM_SingletonBase<PoolManager>:
//   - GFM_Pool 已经持有真正的 `_poolRoot` 和缓存表,Manager 化等于双重所有权
//   - 这层只做命名统一,不引入新的 MonoBehaviour 实例
//
// 反馈 01 #8 架构图位置:单例基类 → PoolManager(管理子弹/特效等对象创建与回收)。
// ============================================================================

using UnityEngine;

public sealed class PoolManager
{
    // ------------------------------------------------------------------------
    // 【单例入口】懒初始化。本身不挂 GameObject,真正的池容器在 GFM_Pool。
    // ------------------------------------------------------------------------
    private static PoolManager _instance;
    public static PoolManager Instance
    {
        get
        {
            if (_instance == null) _instance = new PoolManager();
            return _instance;
        }
    }

    private PoolManager() { }

    // ------------------------------------------------------------------------
    // 【初始化】内部转发到 GFM_Pool.Init,把池根节点挂到 parent 下,命名 `__LunaPool`。
    // ------------------------------------------------------------------------
    public void Init(GameObject parent)
    {
        GFM_Pool.Init(parent);
    }

    // 【预加载】把 prefab 实例化 count 份放进池里待用。
    public void Preload(GameObject prefab, int count)
    {
        if (GFM_Pool.instance == null) return;
        GFM_Pool.instance.Preload(prefab, count);
    }

    // 【取池对象】没有可复用实例时自动 Instantiate 并登记 prefab 映射。
    public GameObject Get(GameObject prefab)
    {
        return GFM_Pool.Get(prefab);
    }

    // 【归还池对象】SetActive(false) + reparent 到池根。
    public void Return(GameObject obj)
    {
        GFM_Pool.Return(obj);
    }

    // 【延迟归还】挂一个 GFM_ReturnTimer 在 obj 上,delay 秒后自动 Return。
    public void ReturnAfter(GameObject obj, float delay)
    {
        GFM_Pool.ReturnAfter(obj, delay);
    }
}
