// ============================================================================
// GFM_Player.cs — 玩家控制器（单例）
// ----------------------------------------------------------------------------
// 职责：封装玩家载具相关的一切：
//       - 玩家 GameObject (池对象 "__Pool_Cylinder_Blue_01") 的定位
//       - 移动输入（虚拟摇杆优先，Tap-to-move 兜底）
//       - 形态系统（FormDef / SwitchForm / 当前形态的数值查询）
//       - 采集/递送判定（IsNear / TryCollect / TryDeliver）
//       - 背包 carry 状态
//
// 架构说明（本项目特别）：
//   Forms 不单独成类，因为"形态"本质就是玩家的一个数值维度（速度/容量/采集）。
//   当 CheckEventRules 触发升级时调 Player.Instance.SwitchForm(n)，切换到下
//   一个形态的池对象 + 属性。
//
// 设计约束 (Luna 兼容)：
//   - 不用 Destroy()，形态切换时"旧模型挪到 (0,-999,0)"隐藏
//   - 不用 Dictionary/LINQ/协程
//
// 外部调用入口 (示例):
//   GFM_Player.Instance.Tick();                          // 主 Update 每帧调
//   GFM_Player.Instance.SwitchForm(1);                   // 升级到第二形态
//   if (GFM_Player.Instance.IsNear(resource, 1.5f)) ...  // 距离判定
//   int n = GFM_Player.Instance.TryDeliver(station, "Resource", 1.5f);
// ============================================================================

using UnityEngine;

public class GFM_Player : MonoBehaviour
{
    // ========================================================================
    // 【单例入口】首次访问自动创建 GameObject + AddComponent。
    // ========================================================================
    private static GFM_Player _instance;
    public static GFM_Player Instance
    {
        get
        {
            if (_instance == null)
            {
                var obj = new GameObject("GFM_Player");
                _instance = obj.AddComponent<GFM_Player>();
            }
            return _instance;
        }
    }

    // ========================================================================
    // 【形态系统】原 FormDef 从 GameFlowManagerMain 并入这里，因为形态本质
    // 上就是玩家的一组属性(速度/容量/采集范围/采集力/模型/缩放)。
    // AI 在 Init() 或外部填充 Forms 数组；CheckEventRules 用 SwitchForm 切换。
    // ========================================================================
    public struct FormDef {
        public string formId;          // 形态 ID ("single"/"triple"/...)
        public string poolObjectName;  // 对应的池对象名
        public float moveSpeed;        // 该形态的移动速度
        public float collectRange;     // 采集触发距离
        public float collectPower;     // 单次采集获得数量倍率
        public int carryCapacity;      // 最大背包容量
        public float scale;            // 模型缩放
    }
    public FormDef[] Forms;          // 外部可填：默认由 Init() 给出单形态保底
    private int _currentFormIndex = 0;

    // ========================================================================
    // 【玩家本体】player GameObject 是场景里的"可控胶囊"池对象；joystick 是
    // 贴在 Canvas 上的虚拟摇杆。
    // ========================================================================
    public GameObject Go { get { return _player; } }
    public Transform Trans { get { return _player != null ? _player.transform : null; } }

    private GameObject _player;
    private GFM_Joystick _joystick;

    // 【Tap-to-move 状态】没有摇杆输入时，屏幕点击作为移动目标。
    private Vector3 _tapMoveTarget = Vector3.zero;
    private bool _hasTapTarget = false;

    // ========================================================================
    // 【背包状态】玩家当前携带物品数 + 物品类型。通用 carry 由 TryCollect/
    // TryDeliver 操作。项目特定的资源数量请直接读 GFM_EconomyManager。
    // ========================================================================
    public int Carrying = 0;
    public string CarryingType = "";

    // 【玩家池对象名】可在主文件 Start 里改成项目自己的池对象名；默认胶囊。
    // 典型："__Pool_Cylinder_Blue_01" / "__Pool_Capsule_01" / "__Pool_Cube_01"
    public string PlayerPoolName = "__Pool_Cylinder_Blue_01";

    // 【当前形态移动速度】供 MovePlayer/外部使用。未初始化 fallback 5f。
    public float MoveSpeed { get { return (Forms != null && Forms.Length > 0) ? Forms[_currentFormIndex].moveSpeed : 5f; } }

    private bool _inited = false;

    // ========================================================================
    // 【初始化】
    // - 找到玩家池对象 "__Pool_Cylinder_Blue_01" 并定位到原点
    // - 创建虚拟摇杆（依赖 UIManager 的 Canvas）
    // - 给 Forms 一个单形态保底（外部可随时覆盖）
    // ========================================================================
    public void Init()
    {
        if (_inited) return;
        _inited = true;

        // 1) 玩家池对象（PlayerPoolName 可由主文件 Start 覆盖）
        _player = GameObject.Find(PlayerPoolName);
        if (_player != null) _player.transform.position = new Vector3(0f, 0.5f, 0f);

        // 2) 虚拟摇杆 (依赖 Canvas — 这里会触发 UIManager 懒初始化)
        if (GFM_UIManager.Instance != null && GFM_UIManager.Instance.Canvas != null)
        {
            _joystick = GFM_Joystick.Create(GFM_UIManager.Instance.Canvas, 180f);
        }

        // 3) Forms 保底：单形态 (外部可替换)
        if (Forms == null || Forms.Length == 0)
        {
            Forms = new FormDef[] {
                new FormDef { formId="default", poolObjectName="", moveSpeed=5f, collectRange=1.5f, collectPower=1f, carryCapacity=10, scale=1f }
            };
        }
    }

    private void Awake()
    {
        if (_instance != null && _instance != this) { enabled = false; return; }
        _instance = this;
        Init();
    }

    // ========================================================================
    // 【主 Update 节拍】GameFlowManagerMain.Update 里调 Tick(dt)，由玩家自己
    // 决定交互/autoPlay 模式下的移动行为。不在 autoPlay 模式下才跑玩家输入；
    // autoPlay 由 GFM_AutoPlay 驱动。
    // ========================================================================
    public void Tick(float dt, bool isAutoPlay)
    {
        if (!isAutoPlay) MovePlayer();
    }

    // ========================================================================
    // 【玩家移动】
    //   优先级 1 — 摇杆输入（任一轴 > 0.1 即视为有效输入）
    //   优先级 2 — Tap-to-move（鼠标点击屏幕，raycast 算落点，走过去）
    //   忽略屏幕左下 200×200 区域（摇杆自己的区域）
    // ========================================================================
    public void MovePlayer()
    {
        if (_player == null) return;

        // 优先级 1：摇杆
        if (_joystick != null)
        {
            float h = _joystick.Horizontal;
            float v = _joystick.Vertical;
            if (Mathf.Abs(h) > 0.1f || Mathf.Abs(v) > 0.1f)
            {
                Vector3 move = new Vector3(h, 0, v) * MoveSpeed * Time.deltaTime;
                _player.transform.position += move;
                _player.transform.rotation = Quaternion.LookRotation(new Vector3(h, 0, v));
                _hasTapTarget = false;
                return;
            }
        }

        // 优先级 2：Tap-to-move 点击检测
        Camera cam = (GFM_CameraController.Instance != null) ? GFM_CameraController.Instance.Main : null;
        if (Input.GetMouseButtonDown(0) && cam != null)
        {
            Vector2 sp = Input.mousePosition;
            // 忽略摇杆区域 (左下 200×200)
            if (sp.x > 200f || sp.y > 200f)
            {
                Ray ray = cam.ScreenPointToRay(sp);
                float t = -ray.origin.y / ray.direction.y;
                if (t > 0f) { _tapMoveTarget = ray.origin + ray.direction * t; _hasTapTarget = true; }
            }
        }

        // 向 tap target 移动
        if (_hasTapTarget)
        {
            Vector3 diff = _tapMoveTarget - _player.transform.position;
            diff.y = 0;
            if (diff.magnitude > 0.3f)
            {
                Vector3 move = diff.normalized * MoveSpeed * Time.deltaTime;
                _player.transform.position += move;
                _player.transform.rotation = Quaternion.LookRotation(diff.normalized);
            }
            else { _hasTapTarget = false; }
        }
    }

    // ========================================================================
    // 【距离判定】玩家到目标的水平距离是否 < range。null 目标返回 false。
    // ========================================================================
    public bool IsNear(GameObject target, float range)
    {
        if (_player == null || target == null) return false;
        return Vector3.Distance(_player.transform.position, target.transform.position) < range;
    }

    // ========================================================================
    // 【采集】靠近 source 且背包未满时自动捡 1 个；返回是否成功。
    // ========================================================================
    public bool TryCollect(GameObject source, string resType, int maxCarry, float range)
    {
        if (source == null || !IsNear(source, range)) return false;
        if (Carrying >= maxCarry) return false;
        Carrying++;
        CarryingType = resType;
        return true;
    }

    // ========================================================================
    // 【递送】靠近 target 且 carry 类型匹配时一次性倒空背包；返回递送数量。
    // ========================================================================
    public int TryDeliver(GameObject target, string expectedType, float range)
    {
        if (target == null || !IsNear(target, range)) return 0;
        if (Carrying <= 0 || CarryingType != expectedType) return 0;
        int delivered = Carrying;
        Carrying = 0;
        CarryingType = "";
        return delivered;
    }

    // ========================================================================
    // 【背包可视化】把 carry 数量堆在玩家头顶 (Y 方向每层 0.35)。
    // 本项目未指定合法 carry 池对象，carryVisuals 全为 null → 实际上是 no-op。
    // 保留接口是为了和 skeleton 行为一致。
    // ========================================================================
    private GameObject[] _carryVisuals;
    public void UpdateCarryVisuals()
    {
        if (_carryVisuals == null)
        {
            _carryVisuals = new GameObject[10];
            // 本项目未指定合法 carry 池对象，保持全 null
        }
        // 没有可用对象时 no-op (placeholder for future projects)
    }

    // ========================================================================
    // 【形态切换】隐藏旧模型 (挪到 y=-999)、显示新模型在玩家位置 + 缩放。
    // 原函数在 GameFlowManagerMain 里直接改 `this.player.transform`，现在
    // 改为走 Player 自己的 _player 字段。
    // ========================================================================
    public void SwitchForm(int formIndex)
    {
        if (Forms == null || formIndex < 0 || formIndex >= Forms.Length) return;

        // 1) 挪走旧形态模型
        if (Forms[_currentFormIndex].poolObjectName != "")
        {
            var oldObj = GameObject.Find(Forms[_currentFormIndex].poolObjectName);
            if (oldObj != null) oldObj.transform.position = new Vector3(0, -999, 0);
        }

        // 2) 切换索引 + 新模型挪到玩家位置
        _currentFormIndex = formIndex;
        var newObj = GameObject.Find(Forms[_currentFormIndex].poolObjectName);
        if (newObj != null)
        {
            newObj.transform.position = _player != null ? _player.transform.position : Vector3.zero;
            newObj.transform.localScale = Vector3.one * Forms[_currentFormIndex].scale;
        }
    }

    // 【当前形态属性查询】供 CheckEventRules / TryCollect 使用。
    public float GetCollectPower() { return (Forms != null && Forms.Length > 0) ? Forms[_currentFormIndex].collectPower : 1f; }
    public float GetCollectRange() { return (Forms != null && Forms.Length > 0) ? Forms[_currentFormIndex].collectRange : 1.5f; }
    public int GetCarryCapacity() { return (Forms != null && Forms.Length > 0) ? Forms[_currentFormIndex].carryCapacity : 10; }
    public int CurrentFormIndex { get { return _currentFormIndex; } }
}
