// ============================================================================
// GameFlowManagerMain.cs — 游戏流程总控（主文件 / 相位状态机）
// ----------------------------------------------------------------------------
// 【架构说明 — 2026-04-19 重构】
// 本文件只负责游戏"流程"(13 phase 相位状态机 + 自动播放协调)，具体业务
// 逻辑分发给各 Manager 单例：
//
//   流程（本文件）─┐
//                 ├─→ GFM_Player.Instance        ── 玩家/摇杆/形态/采集
//                 ├─→ GFM_EconomyManager.Instance ── 金币/资源/库存
//                 ├─→ GFM_UIManager.Instance      ── Canvas/guide/score/浮文字
//                 ├─→ GFM_CameraController.Instance ── 主相机+等距视角
//                 ├─→ GFM_AutoPlay.Instance       ── CUA 自动播放
//                 ├─→ GFM_NpcManager.Instance     ── (本项目未用,空壳)
//                 └─→ GFM_ItemManager.Instance    ── (本项目未用,空壳)
//
// 【留在本文件的状态】
//   - 相位跟踪：ruleTriggered / currentPhaseName / phaseTimer / completedPhases
//   - 实体状态机：16 个 *State (0=waiting,1=building,2=built)
//   - 反 autoplay 交互标志：38 个 *InteractionDone / *PlayerActed / *Done
//   - 17 个场景实体 GameObject 引用 (由 GameSceneCtrl 注册池对象)
//
// 【渲染规则 — 违反 = 构建失败】
//   1. Camera.backgroundColor 预设 (0.45, 0.52, 0.62)，不得修改
//   2. 严禁 GFM_Create.SetColor() → Luna GL_INVALID_OPERATION
//   3. 严禁 GFM_Create.Obj() → 池对象已存在，用 GameObject.Find
//   4. 池对象颜色预烘焙 (__Pool_Shape_Color_NN)，定位即可
//   5. Phase 1 至少 3 个池对象上屏防纯色背景
//   6. 严禁 Destroy() → 隐藏用 (0,-999,0)
//   7. 严禁 SafeColor / 递归染色函数
//
// 【反自动播放规则 — 违反 = CUA 拒绝】
//   1. 每个 phase 切换必须有玩家交互 (click/drag/joystick)
//   2. 禁止仅凭定时器推进 phase，定时器是"最小停留时长"而非触发器
//   3. playerMustAct=true 的 phase 必须等玩家输入
// ============================================================================

using UnityEngine;
using UnityEngine.UI;

public partial class GameFlowManagerMain : MonoBehaviour
{
    // ========================================================================
    // 【相位定时系统 — skeleton enforced】强制每个 phase 最小停留时长
    // ========================================================================
    float phaseTimer = 0f;             // 当前 phase 已停留时长
    string lastPhaseForTimer = "";     // 上一 phase 名,用于检测切换归零 timer
    float[] phaseEnterTimes;           // 每个 phase 进入时的 gameTimer 快照

    // ========================================================================
    // 【相位跟踪 — skeleton enforced】
    // ========================================================================
    const int RULE_COUNT = 13;         // 相位规则总数 (含首尾+gameEnd)
    bool[] ruleTriggered;              // [i]=true 表示第 i 个 phase 已激活
    string currentPhaseName = "init";  // 当前 phase ID (ReportPhase 上报用)
    string[] completedPhases;          // 已完成 phase 的历史
    int completedPhaseCount = 0;
    float gameTimer;                   // 游戏累计时长 (Time.deltaTime 累加)
    bool gameEnded = false;            // 终局标志,gameEnd 后 Update 直接 return

    // ========================================================================
    // 【AutoPlay 双模 — CUA 用自动播放,真人用交互】
    // _autoPlayMode / _autoPlaySteps 是 GFM_AutoPlay 的只读代理,保持
    // CheckEventRules 里原字段名的可读性;写入必须走 AutoPlay.IncrementSteps()。
    // ========================================================================
    bool _autoPlayMode { get { return GFM_AutoPlay.Instance.IsActive; } }
    int _autoPlaySteps { get { return GFM_AutoPlay.Instance.Steps; } }
    int _autoPlayStepsAtPhaseStart = 0;                // 当前 phase 开始时步数快照
    const float AUTO_PLAY_PHASE_DURATION = 12f;        // 每 phase 自动播放时长 (DO NOT MODIFY)

    // ========================================================================
    // 【实体状态机 — 必须到达终局 state=2】
    // 0=waiting / 1=building / 2=built。CheckEventRules 集中读写。
    // ========================================================================
    int ForgeWorkshopState = 0;        // 锻造间
    int PlayerTripleDrillState = 0;    // 三钻头飞船
    int CrusherVehicleState = 0;       // 粉碎车
    int HydraulicVehicleState = 0;     // 液压车
    int CanteenState = 0;              // 食堂
    int DormitoryState = 0;            // 宿舍
    int PastureState = 0;              // 牧场
    int CTAButtonState = 0;            // CTA 按钮
    int SpaceJunkState = 0;            // 太空垃圾 (资源桩)
    int MetalShardState = 0;           // 金属碎片 (采集产物)
    int RecyclingStationState = 0;     // 回收站 (售卖点)
    int ForgeBlueprintState = 0;       // 锻造间蓝图 (建造前)
    int PlayerSingleDrillState = 0;    // 单钻头飞船 (初始形态)
    int CanteenBlueprintState = 0;
    int DormBlueprintState = 0;
    int PastureBlueprintState = 0;
    int goldObjState = 0;              // 金币实体 (视觉用)

    // ========================================================================
    // 【反自动播放标志 — 每个 phase 必须等玩家真正交互】
    // *InteractionDone: 玩家点击/靠近/摇杆输入后置 true
    // *PlayerActed: 同上 (双标,用于 AutoPlay arrive 回调双写)
    // *Done: 实体被"消费"的标志 (如 SpaceJunkDone 表示垃圾被捡过一次)
    // 规则: 每个 *Done 必须在 OnAutoPlayArrive + Update 交互双路径都能翻 true。
    // ========================================================================
    bool initialCollectSpaceJunkInteractionDone = false;
    bool initialCollectSpaceJunkPlayerActed = false;
    bool SpaceJunkDone = false;
    bool MetalShardDone = false;
    bool sellShardsGetGoldInteractionDone = false;
    bool sellShardsGetGoldPlayerActed = false;
    bool RecyclingStationDone = false;
    bool buildForgeWorkshopInteractionDone = false;
    bool buildForgeWorkshopPlayerActed = false;
    bool ForgeBlueprintDone = false;
    bool goldObjDone = false;
    bool ForgeWorkshopDone = false;
    bool upgradeToTripleDrillInteractionDone = false;
    bool upgradeToTripleDrillPlayerActed = false;
    bool PlayerSingleDrillDone = false;
    bool tripleDrillCollectJunkInteractionDone = false;
    bool tripleDrillCollectJunkPlayerActed = false;
    bool upgradeToCrusherVehicleInteractionDone = false;
    bool upgradeToCrusherVehiclePlayerActed = false;
    bool PlayerTripleDrillDone = false;
    bool crusherVehicleCollectJunkInteractionDone = false;
    bool crusherVehicleCollectJunkPlayerActed = false;
    bool upgradeToHydraulicVehicleInteractionDone = false;
    bool upgradeToHydraulicVehiclePlayerActed = false;
    bool CrusherVehicleDone = false;
    bool hydraulicVehicleCollectJunkInteractionDone = false;
    bool hydraulicVehicleCollectJunkPlayerActed = false;
    bool expandSpaceStationInteractionDone = false;
    bool expandSpaceStationPlayerActed = false;
    bool CanteenBlueprintDone = false;
    bool CanteenDone = false;
    bool DormBlueprintDone = false;
    bool DormitoryDone = false;
    bool PastureBlueprintDone = false;
    bool PastureDone = false;
    bool showFullStationCTAInteractionDone = false;
    bool showFullStationCTAPlayerActed = false;
    bool CTAButtonDone = false;

    // ========================================================================
    // 【场景实体引用 — 由 GameSceneCtrl 注册池对象】
    // 17 个 GameObject,初始都是 HideObj 隐藏状态,随 phase 激活。
    // ========================================================================
    GameObject ForgeWorkshop;          // → __Pool_Cube_Red_01
    GameObject PlayerTripleDrill;      // → __Pool_Cube_Blue_01
    GameObject CrusherVehicle;         // → __Pool_Cube_Blue_02
    GameObject HydraulicVehicle;       // → __Pool_Cube_Blue_03
    GameObject Canteen;                // → __Pool_Cube_Blue_04
    GameObject Dormitory;              // → __Pool_Cube_Green_01
    GameObject Pasture;                // → __Pool_Cube_Yellow_01
    GameObject CTAButton;              // → __Pool_Cube_Orange_01
    GameObject SpaceJunk;              // → __Pool_Cube_Purple_01
    GameObject MetalShard;             // → __Pool_Cube_White_01
    GameObject RecyclingStation;       // → __Pool_Cube_Brown_01
    GameObject ForgeBlueprint;         // → __Pool_Cube_Cyan_01
    GameObject PlayerSingleDrill;      // → __Pool_Cube_Blue_05
    GameObject CanteenBlueprint;       // → __Pool_Cube_Pink_01
    GameObject DormBlueprint;          // → __Pool_Cube_Red_02
    GameObject PastureBlueprint;       // → __Pool_Cube_Red_03
    GameObject goldObj;                // → __Pool_Cube_Yellow_02

    // ========================================================================
    // 【生命周期 - Start】场景就绪时执行一次
    // 职责:
    //   1. 初始化相位状态数组
    //   2. 注册场景实体 (GameSceneCtrl + 池对象名)
    //   3. 触发 Manager 单例懒初始化 + 注册 AutoPlay 到达回调
    //   4. 填充 Player.Forms (形态定义) + Economy 资源默认值
    //   5. 首帧 Hide 所有实体 (按 phase 逐步解锁显示)
    // ========================================================================
    void Start()
    {
        // 1) 相位状态数组
        ruleTriggered = new bool[RULE_COUNT];
        completedPhases = new string[RULE_COUNT + 5];
        phaseEnterTimes = new float[RULE_COUNT];

        // 2) 场景实体注册 (名字 → 池对象)
        GameSceneCtrl.Init(gameObject);
        GameSceneCtrl.instance.Register("ForgeWorkshop", "__Pool_Cube_Red_01");
        GameSceneCtrl.instance.Register("PlayerTripleDrill", "__Pool_Cube_Blue_01");
        GameSceneCtrl.instance.Register("CrusherVehicle", "__Pool_Cube_Blue_02");
        GameSceneCtrl.instance.Register("HydraulicVehicle", "__Pool_Cube_Blue_03");
        GameSceneCtrl.instance.Register("Canteen", "__Pool_Cube_Blue_04");
        GameSceneCtrl.instance.Register("Dormitory", "__Pool_Cube_Green_01");
        GameSceneCtrl.instance.Register("Pasture", "__Pool_Cube_Yellow_01");
        GameSceneCtrl.instance.Register("CTAButton", "__Pool_Cube_Orange_01");
        GameSceneCtrl.instance.Register("SpaceJunk", "__Pool_Cube_Purple_01");
        GameSceneCtrl.instance.Register("MetalShard", "__Pool_Cube_White_01");
        GameSceneCtrl.instance.Register("RecyclingStation", "__Pool_Cube_Brown_01");
        GameSceneCtrl.instance.Register("ForgeBlueprint", "__Pool_Cube_Cyan_01");
        GameSceneCtrl.instance.Register("PlayerSingleDrill", "__Pool_Cube_Blue_05");
        GameSceneCtrl.instance.Register("CanteenBlueprint", "__Pool_Cube_Pink_01");
        GameSceneCtrl.instance.Register("DormBlueprint", "__Pool_Cube_Red_02");
        GameSceneCtrl.instance.Register("PastureBlueprint", "__Pool_Cube_Red_03");
        GameSceneCtrl.instance.Register("goldObj", "__Pool_Cube_Yellow_02");

        // 3) 拉实体引用 (后续所有 PlaceObj/HideObj 都走这些)
        ForgeWorkshop = GameSceneCtrl.instance.Get("ForgeWorkshop");
        PlayerTripleDrill = GameSceneCtrl.instance.Get("PlayerTripleDrill");
        CrusherVehicle = GameSceneCtrl.instance.Get("CrusherVehicle");
        HydraulicVehicle = GameSceneCtrl.instance.Get("HydraulicVehicle");
        Canteen = GameSceneCtrl.instance.Get("Canteen");
        Dormitory = GameSceneCtrl.instance.Get("Dormitory");
        Pasture = GameSceneCtrl.instance.Get("Pasture");
        CTAButton = GameSceneCtrl.instance.Get("CTAButton");
        SpaceJunk = GameSceneCtrl.instance.Get("SpaceJunk");
        MetalShard = GameSceneCtrl.instance.Get("MetalShard");
        RecyclingStation = GameSceneCtrl.instance.Get("RecyclingStation");
        ForgeBlueprint = GameSceneCtrl.instance.Get("ForgeBlueprint");
        PlayerSingleDrill = GameSceneCtrl.instance.Get("PlayerSingleDrill");
        CanteenBlueprint = GameSceneCtrl.instance.Get("CanteenBlueprint");
        DormBlueprint = GameSceneCtrl.instance.Get("DormBlueprint");
        PastureBlueprint = GameSceneCtrl.instance.Get("PastureBlueprint");
        goldObj = GameSceneCtrl.instance.Get("goldObj");

        // 4) Luna 平台初始化 (iOS 音频预播)
        GFM_Luna.Init(gameObject);

        // 5) 触发各 Manager 懒初始化 (按依赖顺序)
        //    UIManager 先 (Canvas 创建) → Player (摇杆依赖 Canvas) → 其他
        var ui = GFM_UIManager.Instance;          // 创建 Canvas/guideText/scoreText
        var cam = GFM_CameraController.Instance;  // 缓存 Camera.main + 等距视角
        var eco = GFM_EconomyManager.Instance;    // 注册 MetalShard/gold 兑换
        var player = GFM_Player.Instance;         // 定位玩家池对象 + 创建摇杆
        var autoPlay = GFM_AutoPlay.Instance;     // 准备目标循环

        // 6) 注册 AutoPlay 到达回调:CheckEventRules 的 phase 副作用由主文件处理
        autoPlay.OnArrive = HandleAutoPlayArrive;

        // 7) 初始场景:所有实体先隐藏,由 phase 入口逐步显示
        HideObj(PlayerSingleDrill);
        HideObj(RecyclingStation);
        HideObj(SpaceJunk);
        HideObj(MetalShard);
        HideObj(ForgeBlueprint);
        HideObj(ForgeWorkshop);
        HideObj(PlayerTripleDrill);
        HideObj(CrusherVehicle);
        HideObj(HydraulicVehicle);
        HideObj(CanteenBlueprint);
        HideObj(Canteen);
        HideObj(DormBlueprint);
        HideObj(Dormitory);
        HideObj(PastureBlueprint);
        HideObj(Pasture);
        HideObj(CTAButton);
        HideObj(goldObj);

        // 8) 世界标签:给可识别的目标实体挂中文名 Billboard
        //    玩家载具 / 金币飘字 / CTA 按钮无需标签(玩家自身或 UI 元素)
        GFM_UI.AddWorldLabel(SpaceJunk, "太空垃圾", 1.0f);
        GFM_UI.AddWorldLabel(MetalShard, "金属碎片", 0.8f);
        GFM_UI.AddWorldLabel(RecyclingStation, "回收站", 1.5f);
        GFM_UI.AddWorldLabel(ForgeBlueprint, "锻造位(点击建造)", 1.5f);
        GFM_UI.AddWorldLabel(ForgeWorkshop, "锻造间", 1.5f);
        GFM_UI.AddWorldLabel(CanteenBlueprint, "餐厅位", 1.5f);
        GFM_UI.AddWorldLabel(Canteen, "餐厅", 1.5f);
        GFM_UI.AddWorldLabel(DormBlueprint, "宿舍位", 1.5f);
        GFM_UI.AddWorldLabel(Dormitory, "宿舍", 1.5f);
        GFM_UI.AddWorldLabel(PastureBlueprint, "牧场位", 1.5f);
        GFM_UI.AddWorldLabel(Pasture, "牧场", 1.5f);

        UpdateGameState();
    }

    // ========================================================================
    // 【生命周期 - Update】每帧主循环
    // 职责:
    //   1. gameEnd 后直接 return
    //   2. 累计 gameTimer + AutoPlay 激活检测
    //   3. 相位定时器 (phase 切换时归零)
    //   4. 相位状态机 CheckEventRules (核心!)
    //   5. 分发到 Player/AutoPlay Tick (交互 vs 自动)
    //   6. UI 浮动文字 tick
    //   7. 玩家交互处理 (采集/递送/升级)
    // ========================================================================
    void Update()
    {
        if (gameEnded) return;

        float dt = Time.deltaTime;
        gameTimer += dt;

        // 2) AutoPlay 激活检测 (两阶段:检测 __AUTOPLAY_ON__ + 6s 延迟激活)
        GFM_AutoPlay.Instance.CheckActivation(gameTimer);

        // 3) 相位定时器
        if (currentPhaseName != lastPhaseForTimer) {
            phaseTimer = 0f;
            lastPhaseForTimer = currentPhaseName;
        }
        phaseTimer += dt;

        // 4) 相位状态机
        CheckEventRules();

        // 5) 模式分发
        if (_autoPlayMode) GFM_AutoPlay.Instance.Tick();
        else GFM_Player.Instance.Tick(dt, false);

        // 6) UI 浮动文字淡出
        GFM_UIManager.Instance.FloatingTextTick(dt);

        // 7) 玩家交互 (原 TODO_UPDATE + TODO_CUSTOM 内容)
        HandlePlayerInteractions();
    }

    // ========================================================================
    // 【玩家交互处理】从原 Update 里迁出的业务逻辑。每帧在非 autoPlay 模式下
    // 检查鼠标点击,并根据当前 phase 设置对应的 *InteractionDone 标志;
    // 同时处理靠近 MetalShard / goldObj / 各建筑的资源流转逻辑。
    // ========================================================================
    void HandlePlayerInteractions()
    {
        var player = GFM_Player.Instance;
        var eco = GFM_EconomyManager.Instance;
        var ui = GFM_UIManager.Instance;

        // —— 点击/触摸触发交互标志 (非 autoPlay 模式) ——
        // 真人点一下屏幕就算本 phase 的"玩家已行动",满足反 autoplay gate。
        if (!_autoPlayMode && (Input.GetMouseButtonDown(0) || (Input.touchCount > 0 && Input.GetTouch(0).phase == TouchPhase.Began))) {
            if (currentPhaseName == "initialCollectSpaceJunk") { initialCollectSpaceJunkInteractionDone = true; initialCollectSpaceJunkPlayerActed = true; }
            if (currentPhaseName == "sellShardsGetGold") { sellShardsGetGoldInteractionDone = true; sellShardsGetGoldPlayerActed = true; }
            if (currentPhaseName == "buildForgeWorkshop") { buildForgeWorkshopInteractionDone = true; buildForgeWorkshopPlayerActed = true; }
            if (currentPhaseName == "upgradeToTripleDrill") { upgradeToTripleDrillInteractionDone = true; upgradeToTripleDrillPlayerActed = true; }
            if (currentPhaseName == "tripleDrillCollectJunk") { tripleDrillCollectJunkInteractionDone = true; tripleDrillCollectJunkPlayerActed = true; }
            if (currentPhaseName == "upgradeToCrusherVehicle") { upgradeToCrusherVehicleInteractionDone = true; upgradeToCrusherVehiclePlayerActed = true; }
            if (currentPhaseName == "crusherVehicleCollectJunk") { crusherVehicleCollectJunkInteractionDone = true; crusherVehicleCollectJunkPlayerActed = true; }
            if (currentPhaseName == "upgradeToHydraulicVehicle") { upgradeToHydraulicVehicleInteractionDone = true; upgradeToHydraulicVehiclePlayerActed = true; }
            if (currentPhaseName == "hydraulicVehicleCollectJunk") { hydraulicVehicleCollectJunkInteractionDone = true; hydraulicVehicleCollectJunkPlayerActed = true; }
            if (currentPhaseName == "expandSpaceStation") { expandSpaceStationInteractionDone = true; expandSpaceStationPlayerActed = true; }
            if (currentPhaseName == "showFullStationCTA") { showFullStationCTAInteractionDone = true; showFullStationCTAPlayerActed = true; CTAButtonDone = true; CTAButtonState++; }
        }

        // —— 靠近 MetalShard:上手捡,最多 10 个 ——
        if (player.IsNear(MetalShard, 1.5f)) {
            if (player.MetalShardCarried < 10) {
                player.MetalShardCarried++;
                ui.SetScore("MetalShard: " + player.MetalShardCarried + "/10");
            }
        }

        // —— 靠近 goldObj:拾取金币,最多 10 个 ——
        if (player.IsNear(goldObj, 1.5f)) {
            if (player.GoldCarried < 10) {
                player.GoldCarried++;
                ui.SetScore("gold: " + player.GoldCarried + "/10");
            }
        }

        // —— 靠近 ForgeWorkshop: 交货 → 升级状态 ——
        if (player.IsNear(ForgeWorkshop, 2f) && player.MetalShardCarried > 0) {
            eco.AddResource("MetalShard", player.MetalShardCarried);
            player.MetalShardCarried = 0;
            if (eco.GetResource("MetalShard") >= 1) ForgeWorkshopState++;
        }
        if (player.IsNear(ForgeWorkshop, 2f) && player.GoldCarried > 0) {
            eco.AddResource("gold", player.GoldCarried);
            player.GoldCarried = 0;
            if (eco.GetResource("gold") >= 1) ForgeWorkshopState++;
        }
        // —— 靠近 PlayerTripleDrill: 交货 ——
        if (player.IsNear(PlayerTripleDrill, 2f) && player.MetalShardCarried > 0) {
            eco.AddResource("MetalShard", player.MetalShardCarried);
            player.MetalShardCarried = 0;
            if (eco.GetResource("MetalShard") >= 1) PlayerTripleDrillState++;
        }
        if (player.IsNear(PlayerTripleDrill, 2f) && player.GoldCarried > 0) {
            eco.AddResource("gold", player.GoldCarried);
            player.GoldCarried = 0;
            if (eco.GetResource("gold") >= 1) PlayerTripleDrillState++;
        }
        // —— 靠近 CrusherVehicle: 交货 ——
        if (player.IsNear(CrusherVehicle, 2f) && player.MetalShardCarried > 0) {
            eco.AddResource("MetalShard", player.MetalShardCarried);
            player.MetalShardCarried = 0;
            if (eco.GetResource("MetalShard") >= 1) CrusherVehicleState++;
        }
        if (player.IsNear(CrusherVehicle, 2f) && player.GoldCarried > 0) {
            eco.AddResource("gold", player.GoldCarried);
            player.GoldCarried = 0;
            if (eco.GetResource("gold") >= 1) CrusherVehicleState++;
        }
        // —— 靠近 HydraulicVehicle: 交货 ——
        if (player.IsNear(HydraulicVehicle, 2f) && player.MetalShardCarried > 0) {
            eco.AddResource("MetalShard", player.MetalShardCarried);
            player.MetalShardCarried = 0;
            if (eco.GetResource("MetalShard") >= 1) HydraulicVehicleState++;
        }
        if (player.IsNear(HydraulicVehicle, 2f) && player.GoldCarried > 0) {
            eco.AddResource("gold", player.GoldCarried);
            player.GoldCarried = 0;
            if (eco.GetResource("gold") >= 1) HydraulicVehicleState++;
        }

        // —— phase: sellShardsGetGold 下靠近 RecyclingStation 即售卖 ——
        if (RecyclingStation != null && player.IsNear(RecyclingStation, 2f) && currentPhaseName == "sellShardsGetGold") {
            if (eco.GetResource("MetalShard") > 0 || player.MetalShardCarried > 0) {
                eco.AddResource("gold", 1);
                player.MetalShardCarried = 0;
            }
            RecyclingStationDone = true;
            RecyclingStationState = 2;
            sellShardsGetGoldInteractionDone = true;
            sellShardsGetGoldPlayerActed = true;
        }

        // —— 所有采集 phase 下靠近 SpaceJunk: 捡碎片 + 按形态加倍 ——
        if (SpaceJunk != null && player.IsNear(SpaceJunk, 2f)) {
            bool isCollectPhase = (currentPhaseName == "initialCollectSpaceJunk"
                || currentPhaseName == "tripleDrillCollectJunk"
                || currentPhaseName == "crusherVehicleCollectJunk"
                || currentPhaseName == "hydraulicVehicleCollectJunk");
            if (isCollectPhase) {
                int gain = 1;
                if (currentPhaseName == "tripleDrillCollectJunk") gain = 2;
                else if (currentPhaseName == "crusherVehicleCollectJunk") gain = 3;
                else if (currentPhaseName == "hydraulicVehicleCollectJunk") gain = 5;
                eco.AddResource("MetalShard", gain);
                SpaceJunkDone = true;
                SpaceJunkState = 2;
                MetalShardDone = true;
                MetalShardState = 2;
                ui.ShowFloatingText(SpaceJunk.transform.position, "+" + gain + " MetalShard", Color.cyan);
                HideObj(SpaceJunk); // 模拟垃圾被消费
                if (currentPhaseName == "initialCollectSpaceJunk") initialCollectSpaceJunkInteractionDone = true;
                if (currentPhaseName == "tripleDrillCollectJunk") tripleDrillCollectJunkInteractionDone = true;
                if (currentPhaseName == "crusherVehicleCollectJunk") crusherVehicleCollectJunkInteractionDone = true;
                if (currentPhaseName == "hydraulicVehicleCollectJunk") hydraulicVehicleCollectJunkInteractionDone = true;
            }
        }

        // —— 升级三钻头 phase: 切换模型 + 设置状态 ——
        if (currentPhaseName == "upgradeToTripleDrill" && PlayerTripleDrillState < 2) {
            HideObj(PlayerSingleDrill);
            PlaceObj(PlayerTripleDrill, 2f, 0.5f, -2f);
            SetScale(PlayerTripleDrill, 1.1f);
            PlayerTripleDrillState = 2;
            PlayerSingleDrillDone = true;
            PlayerSingleDrillState = 2;
            upgradeToTripleDrillInteractionDone = true;
        }
        // —— 升级粉碎车 phase ——
        if (currentPhaseName == "upgradeToCrusherVehicle" && CrusherVehicleState < 2) {
            HideObj(PlayerTripleDrill);
            PlaceObj(CrusherVehicle, 2f, 0.5f, -2f);
            SetScale(CrusherVehicle, 1.3f);
            CrusherVehicleState = 2;
            PlayerTripleDrillDone = true;
            upgradeToCrusherVehicleInteractionDone = true;
        }
        // —— 升级液压车 phase ——
        if (currentPhaseName == "upgradeToHydraulicVehicle" && HydraulicVehicleState < 2) {
            HideObj(CrusherVehicle);
            PlaceObj(HydraulicVehicle, 2f, 0.5f, -2f);
            SetScale(HydraulicVehicle, 1.5f);
            HydraulicVehicleState = 2;
            CrusherVehicleDone = true;
            upgradeToHydraulicVehicleInteractionDone = true;
        }

        // —— 建造蓝图靠近即完工 ——
        if (ForgeBlueprint != null && player.IsNear(ForgeBlueprint, 2.5f) && ForgeWorkshopState < 2) {
            ForgeBlueprintDone = true;
            ForgeBlueprintState = 2;
            if (ForgeWorkshopState == 0) ForgeWorkshopState = 1;
            ForgeWorkshopState = 2;
            ForgeWorkshopDone = true;
            HideObj(ForgeBlueprint);
            PlaceObj(ForgeWorkshop, -3f, 1f, 1f);
            buildForgeWorkshopInteractionDone = true;
        }
        if (CanteenBlueprint != null && player.IsNear(CanteenBlueprint, 2.5f) && CanteenState < 2) {
            CanteenBlueprintDone = true;
            CanteenBlueprintState = 2;
            if (CanteenState == 0) CanteenState = 1;
            CanteenState = 2;
            CanteenDone = true;
            HideObj(CanteenBlueprint);
            PlaceObj(Canteen, 4f, 1f, 0f);
            expandSpaceStationInteractionDone = true;
        }
        if (DormBlueprint != null && player.IsNear(DormBlueprint, 2.5f) && DormitoryState < 2) {
            DormBlueprintDone = true;
            DormBlueprintState = 2;
            if (DormitoryState == 0) DormitoryState = 1;
            DormitoryState = 2;
            DormitoryDone = true;
            HideObj(DormBlueprint);
            PlaceObj(Dormitory, 6f, 1f, 0f);
        }
        if (PastureBlueprint != null && player.IsNear(PastureBlueprint, 2.5f) && PastureState < 2) {
            PastureBlueprintDone = true;
            PastureBlueprintState = 2;
            if (PastureState == 0) PastureState = 1;
            PastureState = 2;
            PastureDone = true;
            HideObj(PastureBlueprint);
            PlaceObj(Pasture, 8f, 1f, 0f);
        }
    }

    // ========================================================================
    // 【AutoPlay 到达回调】GFM_AutoPlay 每次到达一个目标时调此方法,按当前
    // phase 设置对应的 State / *Done / *PlayerActed 标志。这些标志属于"流程
    // 副作用",必须在主文件设置 (字段都在这里)。
    // ========================================================================
    void HandleAutoPlayArrive(string targetName)
    {
        var eco = GFM_EconomyManager.Instance;

        if (currentPhaseName == "initialCollectSpaceJunk") {
            eco.AddResource("MetalShard", 5);
            initialCollectSpaceJunkInteractionDone = true;
            initialCollectSpaceJunkPlayerActed = true;
        }
        if (currentPhaseName == "sellShardsGetGold") {
            eco.AddResource("gold", 1);
            RecyclingStationDone = true;
            RecyclingStationState = 2;
            sellShardsGetGoldInteractionDone = true;
            sellShardsGetGoldPlayerActed = true;
        }
        if (currentPhaseName == "buildForgeWorkshop") {
            ForgeWorkshopState = 2;
            buildForgeWorkshopInteractionDone = true;
            buildForgeWorkshopPlayerActed = true;
        }
        if (currentPhaseName == "upgradeToTripleDrill") {
            PlayerTripleDrillState = 2;
            upgradeToTripleDrillInteractionDone = true;
            upgradeToTripleDrillPlayerActed = true;
        }
        if (currentPhaseName == "tripleDrillCollectJunk") {
            eco.AddResource("MetalShard", 10);
            tripleDrillCollectJunkInteractionDone = true;
            tripleDrillCollectJunkPlayerActed = true;
        }
        if (currentPhaseName == "upgradeToCrusherVehicle") {
            CrusherVehicleState = 2;
            upgradeToCrusherVehicleInteractionDone = true;
            upgradeToCrusherVehiclePlayerActed = true;
        }
        if (currentPhaseName == "crusherVehicleCollectJunk") {
            eco.AddResource("MetalShard", 15);
            crusherVehicleCollectJunkInteractionDone = true;
            crusherVehicleCollectJunkPlayerActed = true;
        }
        if (currentPhaseName == "upgradeToHydraulicVehicle") {
            HydraulicVehicleState = 2;
            upgradeToHydraulicVehicleInteractionDone = true;
            upgradeToHydraulicVehiclePlayerActed = true;
        }
        if (currentPhaseName == "hydraulicVehicleCollectJunk") {
            eco.AddResource("MetalShard", 20);
            hydraulicVehicleCollectJunkInteractionDone = true;
            hydraulicVehicleCollectJunkPlayerActed = true;
        }
        if (currentPhaseName == "expandSpaceStation") {
            CanteenState = 2;
            DormitoryState = 2;
            PastureState = 2;
            expandSpaceStationInteractionDone = true;
            expandSpaceStationPlayerActed = true;
        }
        if (currentPhaseName == "showFullStationCTA") {
            CTAButtonDone = true;
            CTAButtonState++;
            showFullStationCTAInteractionDone = true;
            showFullStationCTAPlayerActed = true;
        }
    }

    // 【相位上报】Bridge.NET 把此 Debug.Log 编译成 console.log,供 CUA 抓取
    void ReportPhase(string phaseId) {
        UnityEngine.Debug.Log("__PHASE__:" + phaseId);
    }

    // ========================================================================
    // 【相位状态机 - CheckEventRules】
    // 13 个 phase 入口 (11 个 gameplay + 1 个 gameEnd + 1 个 safety-net 兜底)。
    // 每个 phase 块结构:
    //   入口守卫: 20s/12s autoPlay gate + 真人交互 gate
    //   激活副作用: 摆对象/切形态/加资源/设置引导文字
    //   记录: AddCompletedPhase (上一 phase) + UpdateGameState (给 CUA)
    //
    // 【immutable】phaseName / RuleTriggered 索引 / ReportPhase 参数不得变更。
    // ========================================================================
    void CheckEventRules()
    {
        var ui = GFM_UIManager.Instance;
        var eco = GFM_EconomyManager.Instance;
        var player = GFM_Player.Instance;

        // ====================================================================
        // === Phase 1: 初始太空捡垃圾 (initialCollectSpaceJunk) ===
        // 入口条件: 第一次进入 (ruleTriggered[0] == false)
        // 状态跃迁: 摆好锻造间/三钻头/粉碎车/单钻头/回收站/太空垃圾;引导玩家
        //           走到 SpaceJunk 处按交互键捡碎片
        // 副作用: 送玩家 1 点 MetalShard 起手资源,引导词"使用单钻头飞船收集太空垃圾"
        // ====================================================================
        if (!ruleTriggered[0])
        {
            ruleTriggered[0] = true;
            currentPhaseName = "initialCollectSpaceJunk";
            phaseEnterTimes[0] = gameTimer;
            ReportPhase("initialCollectSpaceJunk");

            // 摆初始场景 (池对象颜色预烘焙,不得 SetColor)
            PlaceObj(ForgeWorkshop, -3f, 0.5f, 0f);
            SetScale(ForgeWorkshop, 1f, 1f, 1f);
            PlaceObj(PlayerTripleDrill, 0f, 0.5f, 0f);
            SetScale(PlayerTripleDrill, 1f, 1f, 1f);
            PlaceObj(CrusherVehicle, 3f, 0.5f, 0f);
            SetScale(CrusherVehicle, 1f, 1f, 1f);

            PlaceObj(PlayerSingleDrill, 2f, 0.5f, -2f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(SpaceJunk, -4f, 0.5f, 2f);
            ui.SetGuide("使用单钻头飞船收集太空垃圾");
            eco.AddResource("MetalShard", 1);

            UpdateGameState(); // Phase 1 是第一相,无前置相可标完成
        }

        // ====================================================================
        // === Phase 2: 回站售卖碎片换金币 (sellShardsGetGold) ===
        // 入口条件: (autoPlay) 20s + 至少 1 次 arrive 步数 / (真人) SpaceJunkDone==true && phaseTimer>=3s
        // 状态跃迁: 要求玩家把采到的碎片送回 RecyclingStation 换 gold
        // 副作用: 奖励 1 gold,引导词"返回回收站出售金属碎片换取金币"
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[1] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[1]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (SpaceJunkDone == true && phaseTimer >= 3f)))
        {
            ruleTriggered[1] = true;
            currentPhaseName = "sellShardsGetGold";
            phaseEnterTimes[1] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("sellShardsGetGold");

            if (_autoPlayMode) GFM_AutoPlay.Instance.IncrementSteps();

            PlaceObj(PlayerSingleDrill, 2f, 0.5f, -2f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            HideObj(SpaceJunk);
            ui.SetGuide("返回回收站出售金属碎片换取金币");
            eco.AddResource("gold", 1);

            AddCompletedPhase("initialCollectSpaceJunk");
            UpdateGameState();
        }

        // ====================================================================
        // === Phase 3: 建造锻造间 (buildForgeWorkshop) ===
        // 入口条件: RecyclingStationDone==true && phaseTimer>=2s (真人) / 20s gate (auto)
        // 状态跃迁: 摆出锻造间蓝图,要求玩家点击建造;扣 200 gold
        // 副作用: ForgeWorkshopState=1 (建造中),引导词提示点击蓝图
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[2] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[2]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (RecyclingStationDone == true && phaseTimer >= 2f)))
        {
            ruleTriggered[2] = true;
            currentPhaseName = "buildForgeWorkshop";
            phaseEnterTimes[2] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("buildForgeWorkshop");

            if (_autoPlayMode) GFM_AutoPlay.Instance.IncrementSteps();

            PlaceObj(PlayerSingleDrill, 2f, 0.5f, -2f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(ForgeBlueprint, -3f, 0.5f, 1f);
            ui.SetGuide("点击蓝图建造锻造间(需要200金币)");
            ForgeWorkshopState = 1;

            AddCompletedPhase("sellShardsGetGold");
            UpdateGameState();
        }

        // ====================================================================
        // === Phase 4: 升级三钻头 (upgradeToTripleDrill) ===
        // 入口条件: ForgeWorkshopState>=2 && ForgeBlueprintDone==true && phaseTimer>=3s
        // 状态跃迁: 锻造间已就绪,玩家可升级飞船;切换到三钻头形态
        // 副作用: SwitchForm(0),引导词"锻造间完成,准备升级为三钻头飞船"
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[3] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[3]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (ForgeWorkshopState >= 2 && ForgeBlueprintDone == true && phaseTimer >= 3f)))
        {
            ruleTriggered[3] = true;
            currentPhaseName = "upgradeToTripleDrill";
            phaseEnterTimes[3] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("upgradeToTripleDrill");

            if (_autoPlayMode) { ForgeWorkshopState = 2; GFM_AutoPlay.Instance.IncrementSteps(); }

            PlaceObj(PlayerSingleDrill, 2f, 0.5f, -2f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(ForgeWorkshop, -3f, 1f, 1f);
            HideObj(ForgeBlueprint);
            ui.SetGuide("锻造间完成,准备升级为三钻头飞船");
            player.SwitchForm(0);

            AddCompletedPhase("buildForgeWorkshop");
            UpdateGameState();
        }

        // ====================================================================
        // === Phase 5: 三钻头高效收集垃圾 (tripleDrillCollectJunk) ===
        // 入口条件: PlayerTripleDrillState>=2 && ForgeWorkshopDone==true && phaseTimer>=2s
        // 状态跃迁: 升级完成,再次去采集 SpaceJunk,增益倍率 2x
        // 副作用: 引导词"使用三钻头飞船高效收集更多垃圾"
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[4] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[4]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (PlayerTripleDrillState >= 2 && ForgeWorkshopDone == true && phaseTimer >= 2f)))
        {
            ruleTriggered[4] = true;
            currentPhaseName = "tripleDrillCollectJunk";
            phaseEnterTimes[4] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("tripleDrillCollectJunk");

            if (_autoPlayMode) { PlayerTripleDrillState = 2; GFM_AutoPlay.Instance.IncrementSteps(); }

            PlaceObj(PlayerTripleDrill, 2f, 0.5f, -2f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(SpaceJunk, -4f, 0.5f, 2f);
            HideObj(PlayerSingleDrill);
            ui.SetGuide("使用三钻头飞船高效收集更多垃圾");
            eco.AddResource("MetalShard", 1);

            AddCompletedPhase("upgradeToTripleDrill");
            UpdateGameState();
        }

        // ====================================================================
        // === Phase 6: 升级粉碎车 (upgradeToCrusherVehicle) ===
        // 入口条件: SpaceJunkDone==true && phaseTimer>=3s
        // 状态跃迁: 再次升级为粉碎车形态 (scale 1.3)
        // 副作用: SwitchForm(0),引导词"返回锻造间升级为粉碎车(需要500金币)"
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[5] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[5]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (SpaceJunkDone == true && phaseTimer >= 3f)))
        {
            ruleTriggered[5] = true;
            currentPhaseName = "upgradeToCrusherVehicle";
            phaseEnterTimes[5] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("upgradeToCrusherVehicle");

            if (_autoPlayMode) GFM_AutoPlay.Instance.IncrementSteps();

            PlaceObj(PlayerTripleDrill, 2f, 0.5f, -2f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(ForgeWorkshop, -3f, 1f, 1f);
            HideObj(SpaceJunk);
            ui.SetGuide("返回锻造间升级为粉碎车(需要500金币)");
            player.SwitchForm(0);

            AddCompletedPhase("tripleDrillCollectJunk");
            UpdateGameState();
        }

        // ====================================================================
        // === Phase 7: 粉碎车收集垃圾 (crusherVehicleCollectJunk) ===
        // 入口条件: CrusherVehicleState>=2 && ForgeWorkshopDone==true && phaseTimer>=2s
        // 状态跃迁: 粉碎车上阵,采集倍率 3x
        // 副作用: 引导词"粉碎车收集效率更高,继续收集垃圾"
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[6] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[6]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (CrusherVehicleState >= 2 && ForgeWorkshopDone == true && phaseTimer >= 2f)))
        {
            ruleTriggered[6] = true;
            currentPhaseName = "crusherVehicleCollectJunk";
            phaseEnterTimes[6] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("crusherVehicleCollectJunk");

            if (_autoPlayMode) { CrusherVehicleState = 2; GFM_AutoPlay.Instance.IncrementSteps(); }

            PlaceObj(CrusherVehicle, 2f, 0.5f, -2f);
            SetScale(CrusherVehicle, 1.2f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(SpaceJunk, -4f, 0.5f, 2f);
            HideObj(PlayerTripleDrill);
            ui.SetGuide("粉碎车收集效率更高,继续收集垃圾");
            eco.AddResource("MetalShard", 1);

            AddCompletedPhase("upgradeToCrusherVehicle");
            UpdateGameState();
        }

        // ====================================================================
        // === Phase 8: 升级液压车 (upgradeToHydraulicVehicle) ===
        // 入口条件: SpaceJunkDone==true && phaseTimer>=3s
        // 状态跃迁: 最终形态液压车 (scale 1.5)
        // 副作用: SwitchForm(0),引导词"继续升级为液压车(需要1000金币)"
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[7] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[7]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (SpaceJunkDone == true && phaseTimer >= 3f)))
        {
            ruleTriggered[7] = true;
            currentPhaseName = "upgradeToHydraulicVehicle";
            phaseEnterTimes[7] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("upgradeToHydraulicVehicle");

            if (_autoPlayMode) GFM_AutoPlay.Instance.IncrementSteps();

            PlaceObj(CrusherVehicle, 2f, 0.5f, -2f);
            SetScale(CrusherVehicle, 1.2f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(ForgeWorkshop, -3f, 1f, 1f);
            HideObj(SpaceJunk);
            ui.SetGuide("继续升级为液压车(需要1000金币)");
            player.SwitchForm(0);

            AddCompletedPhase("crusherVehicleCollectJunk");
            UpdateGameState();
        }

        // ====================================================================
        // === Phase 9: 液压车海量收集垃圾 (hydraulicVehicleCollectJunk) ===
        // 入口条件: HydraulicVehicleState>=2 && ForgeWorkshopDone==true && phaseTimer>=2s
        // 状态跃迁: 最强载具上阵,采集倍率 5x
        // 副作用: 引导词"液压车效率最高,海量收集垃圾"
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[8] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[8]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (HydraulicVehicleState >= 2 && ForgeWorkshopDone == true && phaseTimer >= 2f)))
        {
            ruleTriggered[8] = true;
            currentPhaseName = "hydraulicVehicleCollectJunk";
            phaseEnterTimes[8] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("hydraulicVehicleCollectJunk");

            if (_autoPlayMode) { HydraulicVehicleState = 2; GFM_AutoPlay.Instance.IncrementSteps(); }

            PlaceObj(HydraulicVehicle, 2f, 0.5f, -2f);
            SetScale(HydraulicVehicle, 1.3f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(SpaceJunk, -4f, 0.5f, 2f);
            HideObj(CrusherVehicle);
            ui.SetGuide("液压车效率最高,海量收集垃圾");
            eco.AddResource("MetalShard", 1);

            AddCompletedPhase("upgradeToHydraulicVehicle");
            UpdateGameState();
        }

        // ====================================================================
        // === Phase 10: 解锁新船舱扩建空间站 (expandSpaceStation) ===
        // 入口条件: SpaceJunkDone==true && phaseTimer>=3s
        // 状态跃迁: 同时摆出 3 个蓝图 (Canteen/Dorm/Pasture),玩家挨个点击建造
        // 副作用: 3 个 Building State = 1 (建造中)
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[9] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[9]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (SpaceJunkDone == true && phaseTimer >= 3f)))
        {
            ruleTriggered[9] = true;
            currentPhaseName = "expandSpaceStation";
            phaseEnterTimes[9] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("expandSpaceStation");

            if (_autoPlayMode) GFM_AutoPlay.Instance.IncrementSteps();

            PlaceObj(HydraulicVehicle, 2f, 0.5f, -2f);
            SetScale(HydraulicVehicle, 1.3f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(CanteenBlueprint, 4f, 0.5f, 0f);
            PlaceObj(DormBlueprint, 6f, 0.5f, 0f);
            PlaceObj(PastureBlueprint, 8f, 0.5f, 0f);
            HideObj(SpaceJunk);
            ui.SetGuide("资金充足,开始建造空间站的餐厅、宿舍和牧场");
            CanteenState = 1;
            DormitoryState = 1;
            PastureState = 1;

            AddCompletedPhase("hydraulicVehicleCollectJunk");
            UpdateGameState();
        }

        // ====================================================================
        // === Phase 11: 完整空间站展示 + CTA 引导 (showFullStationCTA) ===
        // 入口条件: Canteen/Dorm/Pasture 全 >=2 且 CanteenBlueprintDone && phaseTimer>=4s
        // 状态跃迁: 所有建筑摆好,CTA 按钮出现,播放"感谢试玩"浮动文字
        // 副作用: 引导词"空间站建设完成!点击按钮下载完整游戏"
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[10] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[10]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (CanteenState >= 2 && DormitoryState >= 2 && PastureState >= 2 && CanteenBlueprintDone == true && phaseTimer >= 4f)))
        {
            ruleTriggered[10] = true;
            currentPhaseName = "showFullStationCTA";
            phaseEnterTimes[10] = gameTimer;
            phaseTimer = 0f;
            _autoPlayStepsAtPhaseStart = _autoPlaySteps;
            ReportPhase("showFullStationCTA");

            if (_autoPlayMode) { CanteenState = 2; DormitoryState = 2; PastureState = 2; GFM_AutoPlay.Instance.IncrementSteps(); }

            PlaceObj(HydraulicVehicle, 2f, 0.5f, -2f);
            SetScale(HydraulicVehicle, 1.3f);
            PlaceObj(RecyclingStation, 0f, 1f, 0f);
            PlaceObj(Canteen, 4f, 1f, 0f);
            PlaceObj(Dormitory, 6f, 1f, 0f);
            PlaceObj(Pasture, 8f, 1f, 0f);
            PlaceObj(CTAButton, 0.5f, 0.8f, 0f);
            HideObj(CanteenBlueprint);
            HideObj(DormBlueprint);
            HideObj(PastureBlueprint);
            ui.SetGuide("空间站建设完成!点击按钮下载完整游戏");
            if (player.Trans != null) ui.ShowFloatingText(player.Trans.position, "感谢试玩!", Color.yellow);

            AddCompletedPhase("expandSpaceStation");
            UpdateGameState();
        }

        // ====================================================================
        // === Game End: CTA 点击或 5s 等待 ===
        // 所有实体强制 state=2 (终局),调 Luna.Unity.LifeCycle.GameEnded
        // 入口条件: CTAButtonState>=1 && CTAButtonDone==true && phaseTimer>=5s
        // ====================================================================
        if (_autoPlayMode && !ruleTriggered[11] && (phaseTimer < 20f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {}
        else if (!ruleTriggered[11]
            && (_autoPlayMode ? (phaseTimer >= 20f && _autoPlaySteps > _autoPlayStepsAtPhaseStart)
                : (CTAButtonState >= 1 && CTAButtonDone == true && phaseTimer >= 5f)))
        {
            ruleTriggered[11] = true;
            currentPhaseName = "gameEnd";
            ReportPhase("gameEnd");
            gameEnded = true;

            // autoPlay: 强制所有实体 terminal state
            if (_autoPlayMode)
            {
                ForgeWorkshopState = 2;
                PlayerTripleDrillState = 2;
                CrusherVehicleState = 2;
                HydraulicVehicleState = 2;
                CanteenState = 2;
                DormitoryState = 2;
                PastureState = 2;
                CTAButtonState = 2;
                SpaceJunkState = 2;
                MetalShardState = 2;
                RecyclingStationState = 2;
                ForgeBlueprintState = 2;
                PlayerSingleDrillState = 2;
                CanteenBlueprintState = 2;
                DormBlueprintState = 2;
                PastureBlueprintState = 2;
                goldObjState = 2;
            }

            AddCompletedPhase("showFullStationCTA");
            AddCompletedPhase("gameEnd");
            ShowCTA();
            UpdateGameState();
            Luna.Unity.LifeCycle.GameEnded();
        }

        // ====================================================================
        // === Safety Net: autoPlay 卡住兜底 ===
        // 每 phase 超过 safety 阈值 (50s 或 AUTO_PLAY_PHASE_DURATION×2.5) 仍没
        // 推进 → 强制跳到下一 phase,避免 CUA 无限等待。
        // 【DO NOT MODIFY】这个分支是 CUA 的最后救命绳。
        // ====================================================================
        if (_autoPlayMode && !gameEnded && phaseTimer >= (AUTO_PLAY_PHASE_DURATION < 15f ? 50f : AUTO_PLAY_PHASE_DURATION * 2.5f))
        {
            if (!ruleTriggered[1]) {
                ruleTriggered[1] = true; currentPhaseName = "sellShardsGetGold";
                phaseEnterTimes[1] = gameTimer; phaseTimer = 0f;
                ReportPhase("sellShardsGetGold"); AddCompletedPhase("initialCollectSpaceJunk");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[2]) {
                ruleTriggered[2] = true; currentPhaseName = "buildForgeWorkshop";
                phaseEnterTimes[2] = gameTimer; phaseTimer = 0f;
                ReportPhase("buildForgeWorkshop"); AddCompletedPhase("sellShardsGetGold");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[3]) {
                ruleTriggered[3] = true; currentPhaseName = "upgradeToTripleDrill";
                phaseEnterTimes[3] = gameTimer; phaseTimer = 0f;
                ReportPhase("upgradeToTripleDrill"); AddCompletedPhase("buildForgeWorkshop");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[4]) {
                ruleTriggered[4] = true; currentPhaseName = "tripleDrillCollectJunk";
                phaseEnterTimes[4] = gameTimer; phaseTimer = 0f;
                ReportPhase("tripleDrillCollectJunk"); AddCompletedPhase("upgradeToTripleDrill");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[5]) {
                ruleTriggered[5] = true; currentPhaseName = "upgradeToCrusherVehicle";
                phaseEnterTimes[5] = gameTimer; phaseTimer = 0f;
                ReportPhase("upgradeToCrusherVehicle"); AddCompletedPhase("tripleDrillCollectJunk");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[6]) {
                ruleTriggered[6] = true; currentPhaseName = "crusherVehicleCollectJunk";
                phaseEnterTimes[6] = gameTimer; phaseTimer = 0f;
                ReportPhase("crusherVehicleCollectJunk"); AddCompletedPhase("upgradeToCrusherVehicle");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[7]) {
                ruleTriggered[7] = true; currentPhaseName = "upgradeToHydraulicVehicle";
                phaseEnterTimes[7] = gameTimer; phaseTimer = 0f;
                ReportPhase("upgradeToHydraulicVehicle"); AddCompletedPhase("crusherVehicleCollectJunk");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[8]) {
                ruleTriggered[8] = true; currentPhaseName = "hydraulicVehicleCollectJunk";
                phaseEnterTimes[8] = gameTimer; phaseTimer = 0f;
                ReportPhase("hydraulicVehicleCollectJunk"); AddCompletedPhase("upgradeToHydraulicVehicle");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[9]) {
                ruleTriggered[9] = true; currentPhaseName = "expandSpaceStation";
                phaseEnterTimes[9] = gameTimer; phaseTimer = 0f;
                ReportPhase("expandSpaceStation"); AddCompletedPhase("hydraulicVehicleCollectJunk");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[10]) {
                ruleTriggered[10] = true; currentPhaseName = "showFullStationCTA";
                phaseEnterTimes[10] = gameTimer; phaseTimer = 0f;
                ReportPhase("showFullStationCTA"); AddCompletedPhase("expandSpaceStation");
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
            if (!ruleTriggered[11]) {
                ruleTriggered[11] = true; currentPhaseName = "gameEnd";
                ReportPhase("gameEnd"); AddCompletedPhase("showFullStationCTA");
                AddCompletedPhase("gameEnd"); gameEnded = true; ShowCTA();
                GFM_AutoPlay.Instance.IncrementSteps(); UpdateGameState(); return;
            }
        }
    }

    // ========================================================================
    // 【Skeleton Helpers — 不要修改】
    // ========================================================================

    // 追加已完成 phase 名到历史 (供 UpdateGameState 序列化给 CUA)
    void AddCompletedPhase(string phaseName)
    {
        if (completedPhaseCount < completedPhases.Length)
        {
            completedPhases[completedPhaseCount] = phaseName;
            completedPhaseCount++;
        }
    }

    // 把对象摆到指定世界坐标 (相当于 SetActive(true))
    void PlaceObj(GameObject obj, float x, float y, float z)
    {
        if (obj != null) obj.transform.position = new Vector3(x, y, z);
    }

    // 隐藏对象 (Luna 禁 Destroy,挪到 y=-999 即可)
    void HideObj(GameObject obj)
    {
        if (obj != null) obj.transform.position = new Vector3(0f, -999f, 0f);
    }

    // 设置对象缩放 (三轴独立)
    void SetScale(GameObject obj, float x, float y, float z)
    {
        if (obj != null) obj.transform.localScale = new Vector3(x, y, z);
    }
    // 设置对象均匀缩放
    void SetScale(GameObject obj, float uniform)
    {
        if (obj != null) obj.transform.localScale = new Vector3(uniform, uniform, uniform);
    }

    // 触发 Luna CTA:结束游戏 + 调用安装完整游戏入口
    void ShowCTA()
    {
        Luna.Unity.LifeCycle.GameEnded();
        Luna.Unity.Playable.InstallFullGame();
    }

    // ========================================================================
    // 【UpdateGameState】把当前流程状态序列化成 JSON,通过 gameObject.name
    // 暴露给 JS 端 (CUA 观察器 + __gameState 查询)。Luna bridge 的字符串
    // 通道就是 gameObject.name 这个"偏方"。
    // ========================================================================
    void UpdateGameState()
    {
        string completedJson = "[";
        for (int i = 0; i < completedPhaseCount; i++)
        {
            if (i > 0) completedJson += ",";
            completedJson += "\"" + completedPhases[i] + "\"";
        }
        completedJson += "]";

        string json = "{"
            + "\"currentPhase\":\"" + currentPhaseName + "\","
            + "\"completedPhases\":" + completedJson + ","
            + "\"entityStates\":{"
            + "\"ForgeWorkshop\":\"" + ForgeWorkshopState + "\","
            + "\"PlayerTripleDrill\":\"" + PlayerTripleDrillState + "\","
            + "\"CrusherVehicle\":\"" + CrusherVehicleState + "\","
            + "\"HydraulicVehicle\":\"" + HydraulicVehicleState + "\","
            + "\"Canteen\":\"" + CanteenState + "\","
            + "\"Dormitory\":\"" + DormitoryState + "\","
            + "\"Pasture\":\"" + PastureState + "\","
            + "\"CTAButton\":\"" + CTAButtonState + "\","
            + "\"SpaceJunk\":\"" + SpaceJunkState + "\","
            + "\"MetalShard\":\"" + MetalShardState + "\","
            + "\"RecyclingStation\":\"" + RecyclingStationState + "\","
            + "\"ForgeBlueprint\":\"" + ForgeBlueprintState + "\","
            + "\"PlayerSingleDrill\":\"" + PlayerSingleDrillState + "\","
            + "\"CanteenBlueprint\":\"" + CanteenBlueprintState + "\","
            + "\"DormBlueprint\":\"" + DormBlueprintState + "\","
            + "\"PastureBlueprint\":\"" + PastureBlueprintState + "\","
            + "\"goldObj\":\"" + goldObjState + "\""
            + "},"
            + "\"variables\":{"
            + "\"gameTimer\":" + (int)gameTimer
            + ",\"autoPlayMode\":" + (_autoPlayMode ? "true" : "false")
            + ",\"autoPlaySteps\":" + _autoPlaySteps
            + ",\"autoPlayStepsThisPhase\":" + (_autoPlaySteps - _autoPlayStepsAtPhaseStart)
            + "}"
            + ",\"phaseTimestamps\":{"
            + "\"initialCollectSpaceJunk\":" + (phaseEnterTimes[0] > 0 ? (int)phaseEnterTimes[0] : 0) + ","
            + "\"sellShardsGetGold\":" + (phaseEnterTimes[1] > 0 ? (int)phaseEnterTimes[1] : 0) + ","
            + "\"buildForgeWorkshop\":" + (phaseEnterTimes[2] > 0 ? (int)phaseEnterTimes[2] : 0) + ","
            + "\"upgradeToTripleDrill\":" + (phaseEnterTimes[3] > 0 ? (int)phaseEnterTimes[3] : 0) + ","
            + "\"tripleDrillCollectJunk\":" + (phaseEnterTimes[4] > 0 ? (int)phaseEnterTimes[4] : 0) + ","
            + "\"upgradeToCrusherVehicle\":" + (phaseEnterTimes[5] > 0 ? (int)phaseEnterTimes[5] : 0) + ","
            + "\"crusherVehicleCollectJunk\":" + (phaseEnterTimes[6] > 0 ? (int)phaseEnterTimes[6] : 0) + ","
            + "\"upgradeToHydraulicVehicle\":" + (phaseEnterTimes[7] > 0 ? (int)phaseEnterTimes[7] : 0) + ","
            + "\"hydraulicVehicleCollectJunk\":" + (phaseEnterTimes[8] > 0 ? (int)phaseEnterTimes[8] : 0) + ","
            + "\"expandSpaceStation\":" + (phaseEnterTimes[9] > 0 ? (int)phaseEnterTimes[9] : 0) + ","
            + "\"showFullStationCTA\":" + (phaseEnterTimes[10] > 0 ? (int)phaseEnterTimes[10] : 0) + ""
            + "}"
            + "}";

        gameObject.name = "GFM|" + json;
    }
}
