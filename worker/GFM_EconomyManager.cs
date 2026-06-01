// ============================================================================
// GFM_EconomyManager.cs — 经济系统管理器（单例）
// ----------------------------------------------------------------------------
// 职责：统一管理金币、资源库存、资源兑换规则。
//       把"什么是资源、有多少、能不能花、能不能换"集中到一处。
//       其他模块（CheckEventRules、Player、UI）通过 Instance 访问。
//
// 设计约束 (Luna 兼容)：
//   - 不用 Dictionary (Luna Bridge.NET 有坑)，用平行数组 _invKeys/_invVals 模拟
//   - 不用泛型/LINQ/协程
//   - 不调 Destroy()，防重用 enabled=false
//
// 外部调用入口 (示例):
//   GFM_EconomyManager.Instance.AddResource(GFM_ResourceIds.Normalize("MetalShard"), 5);
//   int g = GFM_EconomyManager.Instance.Gold;
//   if (GFM_EconomyManager.Instance.TrySpend(GFM_ResourceIds.Gold, 10)) { ... }
// ============================================================================

using UnityEngine;

public class GFM_EconomyManager : MonoBehaviour
{
    // ------------------------------------------------------------------------
    // 【单例入口】首次访问 Instance 时自动创建 GameObject + AddComponent。
    // 不需要外部手动 Init()，Awake 会自己调 Init() 完成一次性初始化。
    // ------------------------------------------------------------------------
    private static GFM_EconomyManager _instance;
    public static GFM_EconomyManager Instance
    {
        get
        {
            if (_instance == null)
            {
                var obj = new GameObject("GFM_EconomyManager");
                _instance = obj.AddComponent<GFM_EconomyManager>();
            }
            return _instance;
        }
    }

    // ------------------------------------------------------------------------
    // 【资源定义】AI 在 Init() 或外部填充 _resources 数组，描述资源之间的
    // 兑换关系（如 MetalShard→gold 按 1:1）。
    // ------------------------------------------------------------------------
    public struct ResourceDef {
        public string resourceId;    // 资源唯一 ID（"MetalShard"/"gold"）
        public string displayName;   // UI 显示名
        public string convertFrom;   // 上游资源 ID（为空表示基础资源）
        public int convertRatio;     // N 个上游资源 = 1 个当前资源
    }
    public ResourceDef[] _resources;

    // ------------------------------------------------------------------------
    // 【库存存储】Luna 不用 Dictionary，改用 keys/vals 平行数组。
    // _invCount 表示已注册资源种类数，上限 32。
    // ------------------------------------------------------------------------
    private string[] _invKeys = new string[32];
    private int[] _invVals = new int[32];
    private int _invCount = 0;
    private string[] _collectedKeys = new string[32];
    private int[] _collectedVals = new int[32];
    private int _collectedCount = 0;

    // 【金币】老代码专门维护的独立字段，保留兼容；也可通过 GetResource(GFM_ResourceIds.Gold) 获取。
    public int Gold { get { return _gold; } }
    private int _gold = 0;

    // ------------------------------------------------------------------------
    // 【初始化】首次 Awake 时执行一次；外部如需复位可再调（目前幂等）。
    // ------------------------------------------------------------------------
    private bool _inited = false;
    // 初始化经济系统的资源表、背包表和默认数值。
    public void Init()
    {
        if (_inited) return;
        _inited = true;
        // _resources 由主文件按项目需求填充；canonical 不假设任何默认资源定义。
        // 典型用法：GFM_EconomyManager.Instance.SetResources(new ResourceDef[]{...});
    }

    // 【外部注入资源定义】主文件 Start 时调一次即可。不 reset 已有库存。
    public void SetResources(ResourceDef[] defs)
    {
        if (defs != null)
        {
            for (int i = 0; i < defs.Length; i++)
            {
                defs[i].resourceId = NormalizeResourceId(defs[i].resourceId);
                defs[i].convertFrom = NormalizeResourceId(defs[i].convertFrom);
            }
        }
        _resources = defs;
    }

    private void Awake()
    {
        // Luna 禁用 Destroy()，防重用 enabled=false
        if (_instance != null && _instance != this) { enabled = false; return; }
        _instance = this;
        Init();
    }

    // ------------------------------------------------------------------------
    // 【库存查找】返回资源在 _invKeys/_invVals 的下标，未注册返回 -1。
    // ------------------------------------------------------------------------
    private int _InvIndex(string id)
    {
        id = NormalizeResourceId(id);
        for (int i = 0; i < _invCount; i++) { if (_invKeys[i] == id) return i; }
        return -1;
    }

    private int _CollectedIndex(string id)
    {
        id = NormalizeResourceId(id);
        for (int i = 0; i < _collectedCount; i++) { if (_collectedKeys[i] == id) return i; }
        return -1;
    }

    // 【资源 ID 归一】避免 "gold"/"Gold" 在库存里分裂成两份事实来源。
    private string NormalizeResourceId(string id)
    {
        string normalized = GFM_ResourceIds.Normalize(id);
        if (_resources != null)
        {
            string lower = normalized.ToLower();
            for (int i = 0; i < _resources.Length; i++)
            {
                string rid = _resources[i].resourceId;
                if (rid != null && rid.ToLower() == lower) return rid;
            }
        }
        return normalized;
    }

    // 【增加资源】未注册的自动注册；UI 自动刷新。
    public void AddResource(string id, int amount)
    {
        id = NormalizeResourceId(id);
        int idx = _InvIndex(id);
        if (idx < 0) { _invKeys[_invCount] = id; _invVals[_invCount] = 0; idx = _invCount; _invCount++; }
        _invVals[idx] += amount;
        int collectedIdx = _CollectedIndex(id);
        if (collectedIdx < 0) { _collectedKeys[_collectedCount] = id; _collectedVals[_collectedCount] = 0; collectedIdx = _collectedCount; _collectedCount++; }
        _collectedVals[collectedIdx] += amount;
        if (id == GFM_ResourceIds.Gold) _gold = _invVals[idx]; // 同步 _gold 缓存
        if (GFM_UIManager.Instance != null) GFM_UIManager.Instance.UpdateResourceUI();
    }

    // 【查询资源】未注册返回 0。
    public int GetResource(string id)
    {
        id = NormalizeResourceId(id);
        int idx = _InvIndex(id);
        return idx < 0 ? 0 : _invVals[idx];
    }

    // 【累计采集量】resource_collected gate 使用累计值,不受后续 spend/deposit 影响。
    public int GetCollectedResource(string id)
    {
        id = NormalizeResourceId(id);
        int idx = _CollectedIndex(id);
        return idx < 0 ? 0 : _collectedVals[idx];
    }

    // 【尝试消费】余量足够则扣减并返回 true；不足返回 false。
    public bool TrySpend(string id, int amount)
    {
        id = NormalizeResourceId(id);
        int idx = _InvIndex(id);
        if (idx < 0 || _invVals[idx] < amount) return false;
        _invVals[idx] -= amount;
        if (id == GFM_ResourceIds.Gold) _gold = _invVals[idx];
        if (GFM_UIManager.Instance != null) GFM_UIManager.Instance.UpdateResourceUI();
        return true;
    }

    // 【资源兑换】按 _resources 定义的 convertFrom/convertRatio 进行上游→下游转换。
    // 成功：上游扣减 convertRatio 个，下游 +1，返回 true。
    public bool TryConvert(string fromId, string toId)
    {
        if (_resources == null) return false;
        fromId = NormalizeResourceId(fromId);
        toId = NormalizeResourceId(toId);
        ResourceDef toDef = default;
        bool found = false;
        for (int i = 0; i < _resources.Length; i++)
        {
            if (_resources[i].resourceId == toId) { toDef = _resources[i]; found = true; break; }
        }
        if (!found || toDef.convertFrom != fromId) return false;
        int fromIdx = _InvIndex(fromId);
        if (fromIdx < 0 || _invVals[fromIdx] < toDef.convertRatio) return false;
        _invVals[fromIdx] -= toDef.convertRatio;
        AddResource(toId, 1);
        return true;
    }

    // 【加金币】等价于 AddResource(GFM_ResourceIds.Gold, amount)，保留老接口便于迁移。
    public void AddGold(int amount)
    {
        AddResource(GFM_ResourceIds.Gold, amount);
    }

    // ------------------------------------------------------------------------
    // 【给 UIManager 反查用】UIManager.UpdateResourceUI 需要遍历所有非 0 资源
    // 拼成显示字符串。直接暴露迭代接口避免返回 Dictionary。
    // ------------------------------------------------------------------------
    public int InvCount { get { return _invCount; } }
    // 读取指定背包槽位的资源 ID。
    public string InvKey(int i) { return (i >= 0 && i < _invCount) ? _invKeys[i] : ""; }
    // 读取指定背包槽位的资源数量。
    public int InvVal(int i) { return (i >= 0 && i < _invCount) ? _invVals[i] : 0; }
}
