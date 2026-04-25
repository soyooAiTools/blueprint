// ============================================================================
// GFM_UIManager.cs — UI 管理器（单例）
// ----------------------------------------------------------------------------
// 职责：统一负责游戏中的所有 UI：
//       - 主 Canvas（960×640 参考分辨率）
//       - 引导文字 guideText（告诉玩家下一步做什么）
//       - 得分/资源展示 scoreText
//       - 浮动文字特效 floatingText（+N 金币 / +1 资源 之类的提示）
//
// 设计约束 (Luna 兼容)：
//   - 禁止 Destroy()，浮动文本复用同一个实例，过期用位置隐藏
//   - 不新建 Canvas（若外部已创建，走 Init(canvas) 接管）
//
// 外部调用入口 (示例):
//   GFM_UIManager.Instance.SetGuide("收集资源并升级");
//   GFM_UIManager.Instance.ShowFloatingText(pos, "+5", Color.cyan);
//   GFM_UIManager.Instance.UpdateResourceUI();  // 从 EconomyManager 拉数据
// ============================================================================

using UnityEngine;
using UnityEngine.UI;

public class GFM_UIManager : MonoBehaviour
{
    // ------------------------------------------------------------------------
    // 【单例入口】首次访问自动创建 GameObject 并 AddComponent。
    // ------------------------------------------------------------------------
    private static GFM_UIManager _instance;
    public static GFM_UIManager Instance
    {
        get
        {
            if (_instance == null)
            {
                var obj = new GameObject("GFM_UIManager");
                _instance = obj.AddComponent<GFM_UIManager>();
            }
            return _instance;
        }
    }

    // 【UI 引用】Canvas/guideText/scoreText 由 Init() 创建。
    public Canvas Canvas { get { return _canvas; } }
    public Text Guide { get { return _guideText; } }
    public Text Score { get { return _scoreText; } }

    private Canvas _canvas;
    private Text _guideText;
    private Text _scoreText;
    private Text _floatingText;
    private float _floatingTextTimer = 0f;

    private bool _inited = false;

    // ------------------------------------------------------------------------
    // 【初始化】首次 Awake 时执行，创建 Canvas + guideText + scoreText。
    // 若外部已经创建 Canvas (比如别的 Manager 建过)，后续调用幂等返回。
    // ------------------------------------------------------------------------
    public void Init()
    {
        if (_inited && _canvas != null) return;
        _inited = true;
        if (_canvas == null) _canvas = GFM_UI.CreateCanvas(1920, 1080);
        if (_canvas == null) return;
        if (_guideText == null) _guideText = GFM_UI.CreateText(_canvas, "", new Vector2(0, 450), 44);
        if (_scoreText == null) _scoreText = GFM_UI.CreateText(_canvas, "Score: 0", new Vector2(720, 480), 34);
    }

    private bool EnsureInit()
    {
        if (!_inited || _canvas == null) Init();
        return _canvas != null;
    }

    private void Awake()
    {
        // Luna 禁用 Destroy()，防重用 enabled=false
        if (_instance != null && _instance != this) { enabled = false; return; }
        _instance = this;
        Init();
    }

    // ------------------------------------------------------------------------
    // 【引导文字】阶段切换时调用，告诉玩家下一步做什么。
    // ------------------------------------------------------------------------
    public void SetGuide(string text)
    {
        if (_guideText == null) EnsureInit();
        if (_guideText != null) _guideText.text = text;
    }

    // ------------------------------------------------------------------------
    // 【计分/资源展示】外部直接 SetScore("gold: 5") 写死文本；或 UpdateResourceUI
    // 自动从 EconomyManager 拉全部资源拼接。
    // ------------------------------------------------------------------------
    public void SetScore(string text)
    {
        if (_scoreText == null) EnsureInit();
        if (_scoreText != null) _scoreText.text = text;
    }

    // 【资源 UI 自动刷新】从 EconomyManager 遍历所有非 0 资源，拼成一行展示。
    // 调用方：EconomyManager.AddResource / TrySpend / TryConvert。
    public void UpdateResourceUI()
    {
        if (_scoreText == null) EnsureInit();
        if (_scoreText == null) return;
        if (GFM_EconomyManager.Instance == null) return;
        string s = "";
        bool first = true;
        int n = GFM_EconomyManager.Instance.InvCount;
        for (int i = 0; i < n; i++)
        {
            int v = GFM_EconomyManager.Instance.InvVal(i);
            if (v > 0)
            {
                if (!first) s += "  ";
                s += GFM_EconomyManager.Instance.InvKey(i) + ": " + v;
                first = false;
            }
        }
        _scoreText.text = s;
    }

    // ------------------------------------------------------------------------
    // 【浮动文字】复用同一个 Text 实例（Luna 禁 Destroy），每次 Show 重置文字/
    // 颜色/计时器。FloatingTextTick 由 Player 或主 Update 每帧调用以淡出。
    // ------------------------------------------------------------------------
    public void ShowFloatingText(Vector3 worldPos, string text, Color color)
    {
        if (!EnsureInit()) return;
        if (_floatingText == null) _floatingText = GFM_UI.CreateText(_canvas, "", Vector2.zero, 24);
        if (_floatingText != null)
        {
            _floatingText.text = text;
            _floatingText.color = color;
            _floatingTextTimer = 1.5f;
        }
    }

    // 【浮动文字每帧更新】计时器归零后清空文字。主 Update 里 tick 一下。
    public void FloatingTextTick(float dt)
    {
        if (_floatingTextTimer > 0f)
        {
            _floatingTextTimer -= dt;
            if (_floatingTextTimer <= 0f && _floatingText != null) _floatingText.text = "";
        }
    }
}
