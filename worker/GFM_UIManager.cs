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

// 反馈 01 #8 架构图:UIManager 走 GFM_SingletonBase,不再自维护 _instance。
public class GFM_UIManager : GFM_SingletonBase<GFM_UIManager>
{
    // 【UI 引用】Canvas/guideText/resource/toast 文本由 Init() 创建或绑定。
    public Canvas Canvas { get { return _canvas; } }
    public Text Guide { get { return _guideText; } }
    public Text Score { get { return _scoreText; } }

    private Canvas _canvas;
    private Text _guideText;
    private Text _scoreText;
    private Text _iceText;
    private Text _oxygenText;
    private Text _scrapText;
    private Text _coinText;
    private Text _toastText;
    private Text _targetHintText;
    private Text _floatingText;
    private float _toastTimer = 0f;
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
        if (_canvas == null)
        {
            var canvasObj = GameObject.Find("Canvas");
            if (canvasObj != null) _canvas = canvasObj.GetComponent<Canvas>();
        }
        if (_canvas == null) _canvas = GFM_UI.CreateCanvas(1920, 1080);
        if (_canvas == null) return;
        GFM_UI.ConfigureCanvasForCamera(_canvas);
        if (_guideText == null) _guideText = FindSceneText("Text_Tip");
        if (_iceText == null) _iceText = FindSceneText("Text_Ice");
        if (_oxygenText == null) _oxygenText = FindSceneText("Text_Oxygen");
        if (_scrapText == null) _scrapText = FindSceneText("Text_Scrap");
        if (_coinText == null) _coinText = FindSceneText("Text_Coin");
        if (_toastText == null) _toastText = FindSceneText("Text_StepToast");
        if (_targetHintText == null) _targetHintText = FindSceneText("Text_TargetHint");
        if (_scoreText == null) _scoreText = _toastText != null ? _toastText : _coinText;
        if (_guideText == null) _guideText = GFM_UI.CreateText(_canvas, "", new Vector2(370, 485), 28);
        if (_toastText == null) _toastText = GFM_UI.CreateText(_canvas, "", new Vector2(0, 280), 34);
        if (_scoreText == null) _scoreText = _toastText;
    }

    private Text FindSceneText(string name)
    {
        var obj = GameObject.Find(name);
        return obj != null ? obj.GetComponent<Text>() : null;
    }

    // 确保 UI 管理器已经初始化并拥有根画布。
    private bool EnsureInit()
    {
        if (!_inited || _canvas == null) Init();
        return _canvas != null;
    }

    // 基类 Awake 已经处理 _instance 注册和 duplicate-disable;只需在 OnInit 里
    // 触发 Canvas/text 搭建即可。Luna 禁用 Destroy() 的约束由基类统一保证。
    protected override void OnInit()
    {
        Init();
    }

    void Update()
    {
        Tick(Time.deltaTime);
    }

    void LateUpdate()
    {
        SyncSceneEntityLabels();
    }

    public void Tick(float dt)
    {
        if (_toastTimer > 0f)
        {
            _toastTimer -= dt;
            if (_toastTimer <= 0f && _toastText != null)
            {
                _toastText.text = "";
                _toastText.enabled = false;
            }
        }
        SyncSceneEntityLabels();
        FloatingTextTick(dt);
    }

    public void SyncSceneEntityLabels()
    {
        UpdateSceneEntityLabels();
    }

    // 【实体标签跟随】源 HTML 的 label 是 DOM 叠层并跟随实体投影，交付版每帧把
    // Text_Label_* 重新投到实体头顶，避免 Camera-space Canvas 锚点漂到屏幕顶部。
    private void UpdateSceneEntityLabels()
    {
        if (!EnsureInit()) return;
        GFM_UI.ConfigureSourceHudLayout(_canvas, false);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_Player", "_player", 2.25f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_OxygenShop", "_oxygenShop", 2.7f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_SellCounter", "_sellCounter", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_ShipUnlock", "_shipUnlock", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_SpaceShip", "_spaceShip", 2.0f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_IceSmall", "_iceSmall", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_ShipCargo", "_shipCargo", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_TowWarning", "_towWarning", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_IceLarge", "_iceLarge", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_ForwardBeacon", "_forwardBeacon", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_BaseOne", "_baseOne", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_OxygenPlant", "_oxygenPlant", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_DrillPad", "_drillPad", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_ExitGate", "_exitGate", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_BigDebris", "_bigDebris", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_BaseTwo", "_baseTwo", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_Crusher", "_crusher", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_ShipUpgrade", "_shipUpgrade", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_GunPad", "_gunPad", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_ExitGate2", "_exitGate2", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_FrozenDebris", "_frozenDebris", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_BaseThree", "_baseThree", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_GatlingPad", "_gatlingPad", 2.2f);
        GFM_UI.PositionTextOverEntity(_canvas, "Text_Label_CtaButton", "_ctaButton", 2.2f);
    }

    // ------------------------------------------------------------------------
    // 【引导文字】阶段切换时调用，告诉玩家下一步做什么。
    // ------------------------------------------------------------------------
    public void SetGuide(string text)
    {
        if (_guideText == null) EnsureInit();
        if (_guideText != null) _guideText.text = text;
    }

    // 【当前目标提示】由 phase step 目标驱动，避免停留在上一阶段目标。
    public void SetTargetHint(string targetEntity)
    {
        if (_targetHintText == null) EnsureInit();
        if (_targetHintText == null) return;
        if (string.IsNullOrEmpty(targetEntity))
        {
            _targetHintText.text = "";
            return;
        }
        _targetHintText.text = "目标：" + DisplayNameForEntity(targetEntity);
    }

    private string DisplayNameForEntity(string entityName)
    {
        if (entityName == "_player") return "玩家";
        if (entityName == "_oxygenShop") return "氧气购买台";
        if (entityName == "_sellCounter") return "售卖台";
        if (entityName == "_shipUnlock") return "飞船解锁";
        if (entityName == "_spaceShip") return "飞船";
        if (entityName == "_iceSmall") return "小冰块";
        if (entityName == "_shipCargo") return "飞船货舱";
        if (entityName == "_towWarning") return "拖拽警告";
        if (entityName == "_iceLarge") return "大冰块";
        if (entityName == "_forwardBeacon") return "航标";
        if (entityName == "_baseOne") return "一号基地";
        if (entityName == "_oxygenPlant") return "制氧装置";
        if (entityName == "_drillPad") return "钻头升级台";
        if (entityName == "_exitGate") return "基地出口";
        if (entityName == "_bigDebris") return "舱体残骸";
        if (entityName == "_baseTwo") return "二号基地";
        if (entityName == "_crusher") return "破碎机";
        if (entityName == "_shipUpgrade") return "飞船升级台";
        if (entityName == "_gunPad") return "枪械升级台";
        if (entityName == "_exitGate2") return "二号出口";
        if (entityName == "_frozenDebris") return "冰封垃圾";
        if (entityName == "_baseThree") return "三号基地";
        if (entityName == "_gatlingPad") return "加特林升级台";
        if (entityName == "_ctaButton") return "全景出口";
        return entityName.TrimStart('_');
    }

    // ------------------------------------------------------------------------
    // 【短提示】兼容旧 SetScore 调用,但不再覆盖 Text_Coin 资源 HUD。
    // ------------------------------------------------------------------------
    public void SetScore(string text)
    {
        if (_toastText == null) EnsureInit();
        if (_toastText != null)
        {
            _toastText.text = text == null ? "" : text;
            _toastText.enabled = !string.IsNullOrEmpty(_toastText.text);
            _toastTimer = _toastText.enabled ? 1f : 0f;
        }
    }

    // 【资源 UI 自动刷新】对齐源 HTML 顶部 HUD:每个资源有独立文本,不使用冒号。
    // 调用方：EconomyManager.AddResource / TrySpend / TryConvert。
    public void UpdateResourceUI()
    {
        if (_coinText == null) EnsureInit();
        if (GFM_EconomyManager.Instance == null) return;
        if (_iceText != null) _iceText.text = "冰 " + GFM_EconomyManager.Instance.GetResource("Ice");
        if (_oxygenText != null) _oxygenText.text = "氧气 " + GFM_EconomyManager.Instance.GetResource("Oxygen");
        if (_scrapText != null) _scrapText.text = "铁块 " + GFM_EconomyManager.Instance.GetResource("Scrap");
        if (_coinText != null) _coinText.text = "金币 " + GFM_EconomyManager.Instance.GetResource("Coin");
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

    // ------------------------------------------------------------------------
    // 【统一 UI 创建 API】(反馈 01 #1 架构图：UI 创建走 UIManager,不要让外部
    // 自己 new GameObject + AddComponent<Text>)。所有创建都挂到管理器自己的
    // Canvas 上,Luna 重启时不会丢资源。
    // ------------------------------------------------------------------------

    // 【创建一个标签文本】返回 Text 组件,调用方负责更新内容。
    public Text CreateLabel(string text, Vector2 anchoredPos, int fontSize = 28)
    {
        if (!EnsureInit()) return null;
        return GFM_UI.CreateText(_canvas, text == null ? "" : text, anchoredPos, fontSize);
    }

    // 【创建一个按钮】onClick 在主线程立即触发;Luna 平台上不要在回调里 Destroy。
    public Button CreateButton(string text, Vector2 anchoredPos, Vector2 size, UnityEngine.Events.UnityAction onClick)
    {
        if (!EnsureInit()) return null;
        return GFM_UI.CreateButton(_canvas, text == null ? "" : text, anchoredPos, size, onClick);
    }

    // 【创建一个进度条】fillColor 决定填充色;返回 Slider,调用方写 .value。
    public Slider CreateProgressBar(Vector2 anchoredPos, Vector2 size, Color fillColor)
    {
        if (!EnsureInit()) return null;
        return GFM_UI.CreateProgressBar(_canvas, anchoredPos, size, fillColor);
    }
}
