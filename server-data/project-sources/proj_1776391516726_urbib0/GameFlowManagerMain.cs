// ========== AUTO-GENERATED SKELETON — DO NOT MODIFY SKELETON LINES ==========
// Generated from storyboard spec. AI fills TODO sections only.
// Lines marked [SKELETON] must not be removed or modified.
//
// *** RENDERING RULES (MUST FOLLOW — violation = build failure) ***
// 1. Camera.backgroundColor is pre-set to (0.45, 0.52, 0.62) — do NOT change
// 2. NEVER call GFM_Create.SetColor() — it causes GL_INVALID_OPERATION in Luna
// 3. NEVER call GFM_Create.Obj() — pool objects already exist, use GameObject.Find()
// 4. Pool objects have pre-baked colors (__Pool_Shape_Color_NN) — just position them
// 5. Phase 1 must place at least 3 pool objects on screen to prevent solid-color
// 6. NEVER call Destroy() — hide objects via position (0, -999, 0)
// 7. NEVER use SafeColor or recursive color functions
//
// *** ANTI-AUTOPLAY RULES (MUST FOLLOW — violation = CUA rejection) ***
// 1. Every phase transition MUST require player interaction (click/drag/joystick)
// 2. NEVER advance phases based on timer alone — timer is minimum dwell, not trigger
// 3. playerMustAct=true phases MUST wait for user input before transitioning
//

using UnityEngine;
using UnityEngine.UI;

public partial class GameFlowManagerMain : MonoBehaviour
{
    // [SKELETON] Phase timing system — enforces minimum dwell time per phase
    float phaseTimer = 0f;
    string lastPhaseForTimer = "";
    float[] phaseEnterTimes;  // [SKELETON] records when each phase was entered

    // [SKELETON] Phase tracking
    const int RULE_COUNT = 13;
    bool[] ruleTriggered;
    string currentPhaseName = "init";
    string[] completedPhases;
    int completedPhaseCount = 0;
    float gameTimer;
    bool gameEnded = false;

    // [SKELETON] AutoPlay — state owner is GFM_AutoPlay (canonical library)
    // Local snapshots are synced at top of Update() each frame for backward compat
    // with downstream skeleton code that reads _autoPlayMode / _autoPlaySteps.
    bool _autoPlayMode = false;
    int _autoPlaySteps = 0;
    int _autoPlayStepsAtPhaseStart = 0; // tracks autoPlay steps when current phase started
    const float AUTO_PLAY_PHASE_DURATION = 12f; // [SKELETON] 12s per shot — DO NOT MODIFY this value

    // [SKELETON] Entity states — must reach terminal state
    int ForgeWorkshopState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int PlayerTripleDrillState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int CrusherVehicleState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int HydraulicVehicleState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int CanteenState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int DormitoryState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int PastureState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int SpaceJunkState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int MetalShardState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int RecyclingStationState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int ForgeBlueprintState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int PlayerSingleDrillState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int CanteenBlueprintState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int DormBlueprintState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int PastureBlueprintState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int CTAButtonState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int goldObjState = 0; // 0=waiting, 1=building, 2=built [SKELETON]

    // [SKELETON] Anti-autoplay flags — AI MUST set these to true when player performs the required interaction
    bool initialCollectSpaceJunkInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool initialCollectSpaceJunkPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool SpaceJunkDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool MetalShardDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool sellShardToRecyclingStationInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool sellShardToRecyclingStationPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool RecyclingStationDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool buildForgeWorkshopInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool buildForgeWorkshopPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool ForgeBlueprintDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool goldObjDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool ForgeWorkshopDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToTripleDrillInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToTripleDrillPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool PlayerSingleDrillDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool tripleDrillCollectJunkInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool tripleDrillCollectJunkPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToCrusherVehicleInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToCrusherVehiclePlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool PlayerTripleDrillDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool crusherVehicleCollectJunkInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool crusherVehicleCollectJunkPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToHydraulicVehicleInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToHydraulicVehiclePlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool CrusherVehicleDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool hydraulicVehicleCollectJunkInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool hydraulicVehicleCollectJunkPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool expandSpaceStationModulesInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool expandSpaceStationModulesPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool CanteenBlueprintDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool CanteenDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool DormBlueprintDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool DormitoryDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool PastureBlueprintDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool PastureDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool showFullStationCTAInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool showFullStationCTAPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool CTAButtonDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)

    // [SKELETON] Object references (auto-mapped from entity→pool)
    GameObject ForgeWorkshop; // → __Pool_Cube_Red_01
    GameObject PlayerTripleDrill; // → __Pool_Cube_Blue_01
    GameObject CrusherVehicle; // → __Pool_Cube_Blue_02
    GameObject HydraulicVehicle; // → __Pool_Cube_Blue_03
    GameObject Canteen; // → __Pool_Cube_Blue_04
    GameObject Dormitory; // → __Pool_Cube_Green_01
    GameObject Pasture; // → __Pool_Cube_Yellow_01
    GameObject SpaceJunk; // → __Pool_Cube_Orange_01
    GameObject MetalShard; // → __Pool_Cube_Purple_01
    GameObject RecyclingStation; // → __Pool_Cube_White_01
    GameObject ForgeBlueprint; // → __Pool_Cube_Brown_01
    GameObject PlayerSingleDrill; // → __Pool_Cube_Blue_05
    GameObject CanteenBlueprint; // → __Pool_Cube_Cyan_01
    GameObject DormBlueprint; // → __Pool_Cube_Pink_01
    GameObject PastureBlueprint; // → __Pool_Cube_Red_02
    GameObject CTAButton; // → __Pool_Cube_Red_03
    GameObject goldObj; // → __Pool_Cube_Yellow_02

    // [SKELETON] Camera reference — use mainCam instead of Camera.main
    Camera mainCam;
    // [SKELETON] UI references — canvas and text pre-created, use directly
    Canvas uiCanvas;
    Text guideText;
    Text scoreText;

    // [SKELETON] Form-switch system — AI fills _forms array in Start()
    struct FormDef {
        public string formId;
        public string poolObjectName;
        public float moveSpeed;
        public float collectRange;
        public float collectPower;
        public int carryCapacity;
        public float scale;
    }
    FormDef[] _forms; // [SKELETON] AI: fill in Start() with form definitions
    int _currentFormIndex = 0;

    // [SKELETON] Switch player form — hides old model, shows new, updates stats
    void SwitchForm(int formIndex) {
        if (_forms == null || formIndex < 0 || formIndex >= _forms.Length) return;
        if (_forms[_currentFormIndex].poolObjectName != "") {
            var oldObj = GameObject.Find(_forms[_currentFormIndex].poolObjectName);
            if (oldObj != null) oldObj.transform.position = new Vector3(0, -999, 0);
        }
        _currentFormIndex = formIndex;
        var newObj = GameObject.Find(_forms[_currentFormIndex].poolObjectName);
        if (newObj != null) {
            newObj.transform.position = player != null ? player.transform.position : Vector3.zero;
            newObj.transform.localScale = Vector3.one * _forms[_currentFormIndex].scale;
        }
    }
    float GetCollectPower() { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].collectPower : 1f; }
    float GetCollectRange() { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].collectRange : 1.5f; }
    int GetCarryCapacity() { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].carryCapacity : 10; }

    // [SKELETON] Economy system — delegated to GFM_EconomyManager (state owner)
    // AI fills _resources array in Start(); skeleton syncs it to Manager once.
    struct ResourceDef {
        public string resourceId;
        public string displayName;
        public string convertFrom; // upstream resource id, empty if primary
        public int convertRatio;   // how many upstream = 1 of this
    }
    ResourceDef[] _resources; // [SKELETON] AI: fill in Start(); auto-synced to Manager

    // [SKELETON] Sync locally-filled _resources into GFM_EconomyManager (once)
    void _SyncResourcesToManager() {
        if (_resources == null || _resources.Length == 0) return;
        var mgr = GFM_EconomyManager.Instance;
        var mgrDefs = new GFM_EconomyManager.ResourceDef[_resources.Length];
        for (int i = 0; i < _resources.Length; i++) {
            mgrDefs[i] = new GFM_EconomyManager.ResourceDef {
                resourceId = _resources[i].resourceId,
                displayName = _resources[i].displayName,
                convertFrom = _resources[i].convertFrom,
                convertRatio = _resources[i].convertRatio
            };
        }
        mgr.SetResources(mgrDefs);
    }

    // [SKELETON] Delegate stubs — forward to GFM_EconomyManager (single source of truth)
    void AddResource(string id, int amount) { GFM_EconomyManager.Instance.AddResource(id, amount); }
    int GetResource(string id) { return GFM_EconomyManager.Instance.GetResource(id); }
    bool TrySpend(string id, int amount) { return GFM_EconomyManager.Instance.TrySpend(id, amount); }
    bool TryConvert(string fromId, string toId) { return GFM_EconomyManager.Instance.TryConvert(fromId, toId); }
    void UpdateResourceUI() {
        // Manager 自动更新 scoreText；如果主文件用本地 scoreText，在这里额外拉取展示。
        if (scoreText == null) return;
        var mgr = GFM_EconomyManager.Instance;
        // Luna 禁用 List<T>，用 string 累加（InvCount 通常 < 10，无性能问题）
        string display = "";
        for (int i = 0; i < mgr.InvCount; i++) {
            int v = mgr.InvVal(i);
            if (v > 0) {
                if (display.Length > 0) display += "  ";
                display += mgr.InvKey(i) + ": " + v;
            }
        }
        scoreText.text = display;
    }

    // ========== [SKELETON] IDLE GAME KIT — Pre-built systems ==========
    // All systems below are working code. AI should CALL these, not rewrite them.

    // --- Player Movement (joystick-driven) ---
    GFM_Joystick joystick;
    GameObject player;
    float moveSpeed { get { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].moveSpeed : 5f; } }
    int carrying = 0; // generic resource count on player back
    string carryingType = ""; // what resource type
    int gold = 0;

    // [SKELETON] Tap-to-move target (fallback for joystick)
    Vector3 tapMoveTarget = Vector3.zero;
    bool hasTapTarget = false;
    // [SKELETON] Reusable buffer for per-frame move/look vectors — avoids alloc
    Vector3 _moveBuf = Vector3.zero;
    // [SKELETON] Batch 2 collect cooldown infra — shared across all collect templates
    float collectCooldownInterval = 0.3f;
    float _collectCooldown = 0f;
    string _lastScoreText = "";

    // [SKELETON] Move player by joystick + tap-to-move fallback — call in Update()
    void MovePlayer()
    {
        if (player == null) return;
        // Priority 1: Joystick
        if (joystick != null)
        {
            float h = joystick.Horizontal;
            float v = joystick.Vertical;
            if (Mathf.Abs(h) > 0.1f || Mathf.Abs(v) > 0.1f)
            {
                _moveBuf.x = h; _moveBuf.y = 0f; _moveBuf.z = v;
                float step = moveSpeed * Time.deltaTime;
                var p = player.transform.position;
                p.x += _moveBuf.x * step; p.z += _moveBuf.z * step;
                player.transform.position = p;
                player.transform.rotation = Quaternion.LookRotation(_moveBuf);
                hasTapTarget = false;
                return;
            }
        }
        // Priority 2: Tap-to-move (click on game area → raycast → move toward click)
        if (Input.GetMouseButtonDown(0) && mainCam != null)
        {
            Vector2 sp = Input.mousePosition;
            // Ignore clicks on joystick area (bottom-left 200x200)
            if (sp.x > 200f || sp.y > 200f)
            {
                Ray ray = mainCam.ScreenPointToRay(sp);
                float t = -ray.origin.y / ray.direction.y;
                if (t > 0f) { tapMoveTarget = ray.origin + ray.direction * t; hasTapTarget = true; }
            }
        }
        // Move toward tap target
        if (hasTapTarget)
        {
            Vector3 diff = tapMoveTarget - player.transform.position;
            diff.y = 0;
            if (diff.magnitude > 0.3f)
            {
                Vector3 move = diff.normalized * moveSpeed * Time.deltaTime;
                player.transform.position += move;
                player.transform.rotation = Quaternion.LookRotation(diff.normalized);
            }
            else { hasTapTarget = false; }
        }
    }

    // [SKELETON] Check if player is near a target (proximity trigger) — XZ sqr distance, no sqrt/alloc
    bool IsNear(GameObject target, float range)
    {
        if (player == null || target == null) return false;
        float dx = player.transform.position.x - target.transform.position.x;
        float dz = player.transform.position.z - target.transform.position.z;
        return (dx * dx + dz * dz) < (range * range);
    }

    // [SKELETON] Auto-collect: when player near source, pick up resources
    // Returns true if collected this frame
    bool TryCollect(GameObject source, string resType, int maxCarry, float range)
    {
        if (source == null || !IsNear(source, range)) return false;
        if (carrying >= maxCarry) return false;
        carrying++;
        carryingType = resType;
        return true;
    }

    // [SKELETON] Auto-deliver: when player near machine/sellpoint, drop off resources
    // Returns number of items delivered
    int TryDeliver(GameObject target, string expectedType, float range)
    {
        if (target == null || !IsNear(target, range)) return 0;
        if (carrying <= 0 || carryingType != expectedType) return 0;
        int delivered = carrying;
        carrying = 0;
        carryingType = "";
        return delivered;
    }

    // [SKELETON] Show carry stack on player back (visual feedback)
    GameObject[] carryVisuals;
    void UpdateCarryVisuals()
    {
        // [SKELETON] Carry visuals use pool objects — find them by name
        if (carryVisuals == null)
        {
            // Carry visuals disabled — pool schema does not approve additional cube visuals
            carryVisuals = new GameObject[0];
        }
        for (int i = 0; i < carryVisuals.Length; i++)
        {
            if (i < carrying && player != null)
            {
                Vector3 p = player.transform.position + new Vector3(0, 1f + i * 0.35f, -0.3f);
                PlaceObj(carryVisuals[i], p.x, p.y, p.z);
            }
            else HideObj(carryVisuals[i]);
        }
    }

    // [SKELETON] Gold UI update helper
    void AddGold(int amount)
    {
        gold += amount;
        if (scoreText != null) scoreText.text = "💰 " + gold;
    }

    // [SKELETON] Show floating text (+3 gold) effect
    // [SKELETON] Floating text — uses a pooled text element, auto-hides after delay
    Text floatingText;
    float floatingTextTimer = 0f;
    void ShowFloatingText(Vector3 worldPos, string text, Color color)
    {
        if (mainCam == null) return;
        // Reuse a single floating text — do NOT use Destroy (forbidden in Luna)
        if (floatingText == null) floatingText = GFM_UI.CreateText(uiCanvas, "", Vector2.zero, 48);
        if (floatingText != null) { floatingText.text = text; floatingText.color = color; floatingTextTimer = 1.5f; }
    }

    // ========== END IDLE GAME KIT ==========

    // [SKELETON] AutoPlay targets — passed to GFM_AutoPlay.Instance in Start()
    string[] _autoTargets = new string[] { "ForgeWorkshop", "CrusherVehicle", "HydraulicVehicle", "Canteen", "Dormitory", "Pasture" };

    // [SKELETON] AutoPlayUpdate — delegates to GFM_AutoPlay.Instance (navigation + OnArrive)
    void AutoPlayUpdate()
    {
        GFM_AutoPlay.Instance.Tick();
        _autoPlaySteps = GFM_AutoPlay.Instance.Steps; // sync local for backward compat
    }

    // [SKELETON] Called when autoPlay triggers an interaction (DO NOT REMOVE).
    // AI MUST fill this to simulate gameplay — CUA checks variables change.
    // [SKELETON] Empty OnAutoPlayArrive = CUA FAIL (variable stagnation)
    // RULE: every xxxDone flag set here MUST ALSO be set in interactive mode
    //       (proximity check, raycast, or collision) — otherwise interactive mode freezes.
    void OnAutoPlayArrive(string targetName)
    {
        // TODO_AUTOPLAY_INTERACT_START
        // Auto-play interaction simulation
        switch (currentPhaseName) {
            case "initialCollectSpaceJunk": {
                AddResource("MetalShard", 10);
                initialCollectSpaceJunkInteractionDone = true;
                initialCollectSpaceJunkPlayerActed = true;
                break;
            }
            case "sellShardToRecyclingStation": {
                AddResource("Gold", 20);
                sellShardToRecyclingStationInteractionDone = true;
                sellShardToRecyclingStationPlayerActed = true;
                break;
            }
            case "buildForgeWorkshop": {
                ForgeWorkshopState = 2;
                ForgeBlueprintDone = true;
                ForgeWorkshopDone = true;
                buildForgeWorkshopInteractionDone = true;
                buildForgeWorkshopPlayerActed = true;
                break;
            }
            case "upgradeToTripleDrill": {
                PlayerTripleDrillState = 2;
                PlayerTripleDrillDone = true;
                ForgeWorkshopDone = true;
                upgradeToTripleDrillInteractionDone = true;
                upgradeToTripleDrillPlayerActed = true;
                break;
            }
            case "tripleDrillCollectJunk": {
                AddResource("MetalShard", 20);
                tripleDrillCollectJunkInteractionDone = true;
                tripleDrillCollectJunkPlayerActed = true;
                break;
            }
            case "upgradeToCrusherVehicle": {
                CrusherVehicleState = 2;
                upgradeToCrusherVehicleInteractionDone = true;
                upgradeToCrusherVehiclePlayerActed = true;
                break;
            }
            case "crusherVehicleCollectJunk": {
                AddResource("MetalShard", 30);
                crusherVehicleCollectJunkInteractionDone = true;
                crusherVehicleCollectJunkPlayerActed = true;
                break;
            }
            case "upgradeToHydraulicVehicle": {
                HydraulicVehicleState = 2;
                upgradeToHydraulicVehicleInteractionDone = true;
                upgradeToHydraulicVehiclePlayerActed = true;
                break;
            }
            case "hydraulicVehicleCollectJunk": {
                AddResource("MetalShard", 50);
                hydraulicVehicleCollectJunkInteractionDone = true;
                hydraulicVehicleCollectJunkPlayerActed = true;
                break;
            }
            case "expandSpaceStationModules": {
                CanteenState = 2;
                DormitoryState = 2;
                PastureState = 2;
                CanteenBlueprintDone = true;
                DormBlueprintDone = true;
                PastureBlueprintDone = true;
                CanteenDone = true;
                DormitoryDone = true;
                PastureDone = true;
                expandSpaceStationModulesInteractionDone = true;
                expandSpaceStationModulesPlayerActed = true;
                break;
            }
            case "showFullStationCTA": {
                CTAButtonDone = true;
                CTAButtonState++;
                showFullStationCTAInteractionDone = true;
                showFullStationCTAPlayerActed = true;
                break;
            }
        }
        // TODO_AUTOPLAY_INTERACT_END
    }

    // [SKELETON] Phase instrumentation for automated testing
    void ReportPhase(string phaseId) {
        // Non-console signaling — expose via gameObject.name (Luna-safe)
        // UpdateGameState() also updates gameObject.name with full JSON
        currentPhaseName = phaseId;
    }

    // === TODO: AI declares pools, counters, and game-specific variables below ===
    // TODO_VARIABLES_START
    int MetalShardCarried = 0;
    int GoldCarried = 0;
    int UnknownState = 0;
    GameObject CrusherUpgrade;
    GameObject HydraulicUpgrade;
    GameObject GoldUI;
    GameObject GuideUI;
    float collectRange = 1.5f;
    int maxCarry = 10;
        // TODO_VARIABLES_END

    void Start()
    {
        // [SKELETON] Initialize phase tracking
        ruleTriggered = new bool[RULE_COUNT];
        completedPhases = new string[RULE_COUNT + 5];
        phaseEnterTimes = new float[RULE_COUNT];

        // [SKELETON] Material and pool initialization (InitMaterialFromScene removed — pool colors pre-baked)

        // [SKELETON] Scene entity management
        GameSceneCtrl.Init(gameObject);
        GameSceneCtrl.instance.Register("ForgeWorkshop", "__Pool_Cube_Red_01");
        GameSceneCtrl.instance.Register("PlayerTripleDrill", "__Pool_Cube_Blue_01");
        GameSceneCtrl.instance.Register("CrusherVehicle", "__Pool_Cube_Blue_02");
        GameSceneCtrl.instance.Register("HydraulicVehicle", "__Pool_Cube_Blue_03");
        GameSceneCtrl.instance.Register("Canteen", "__Pool_Cube_Blue_04");
        GameSceneCtrl.instance.Register("Dormitory", "__Pool_Cube_Green_01");
        GameSceneCtrl.instance.Register("Pasture", "__Pool_Cube_Yellow_01");
        GameSceneCtrl.instance.Register("SpaceJunk", "__Pool_Cube_Orange_01");
        GameSceneCtrl.instance.Register("MetalShard", "__Pool_Cube_Purple_01");
        GameSceneCtrl.instance.Register("RecyclingStation", "__Pool_Cube_White_01");
        GameSceneCtrl.instance.Register("ForgeBlueprint", "__Pool_Cube_Brown_01");
        GameSceneCtrl.instance.Register("PlayerSingleDrill", "__Pool_Cube_Blue_05");
        GameSceneCtrl.instance.Register("CanteenBlueprint", "__Pool_Cube_Cyan_01");
        GameSceneCtrl.instance.Register("DormBlueprint", "__Pool_Cube_Pink_01");
        GameSceneCtrl.instance.Register("PastureBlueprint", "__Pool_Cube_Red_02");
        GameSceneCtrl.instance.Register("CTAButton", "__Pool_Cube_Red_03");
        GameSceneCtrl.instance.Register("goldObj", "__Pool_Cube_Yellow_02");

        // [SKELETON] Entity variable shortcuts (backed by GameSceneCtrl cache)
        ForgeWorkshop = GameSceneCtrl.instance.Get("ForgeWorkshop");
        PlayerTripleDrill = GameSceneCtrl.instance.Get("PlayerTripleDrill");
        CrusherVehicle = GameSceneCtrl.instance.Get("CrusherVehicle");
        HydraulicVehicle = GameSceneCtrl.instance.Get("HydraulicVehicle");
        Canteen = GameSceneCtrl.instance.Get("Canteen");
        Dormitory = GameSceneCtrl.instance.Get("Dormitory");
        Pasture = GameSceneCtrl.instance.Get("Pasture");
        SpaceJunk = GameSceneCtrl.instance.Get("SpaceJunk");
        MetalShard = GameSceneCtrl.instance.Get("MetalShard");
        RecyclingStation = GameSceneCtrl.instance.Get("RecyclingStation");
        ForgeBlueprint = GameSceneCtrl.instance.Get("ForgeBlueprint");
        PlayerSingleDrill = GameSceneCtrl.instance.Get("PlayerSingleDrill");
        CanteenBlueprint = GameSceneCtrl.instance.Get("CanteenBlueprint");
        DormBlueprint = GameSceneCtrl.instance.Get("DormBlueprint");
        PastureBlueprint = GameSceneCtrl.instance.Get("PastureBlueprint");
        CTAButton = GameSceneCtrl.instance.Get("CTAButton");
        goldObj = GameSceneCtrl.instance.Get("goldObj");

        // [SKELETON] World-space Chinese labels on target entities
        GFM_UI.AddWorldLabel(ForgeWorkshop, "锻造间", 1.10f);
        GFM_UI.AddWorldLabel(Canteen, "餐厅", 1.00f);
        GFM_UI.AddWorldLabel(Dormitory, "宿舍", 1.00f);
        GFM_UI.AddWorldLabel(Pasture, "牧场", 1.00f);
        GFM_UI.AddWorldLabel(SpaceJunk, "太空垃圾", 0.90f);
        GFM_UI.AddWorldLabel(MetalShard, "金属碎片", 0.65f);
        GFM_UI.AddWorldLabel(RecyclingStation, "回收空间站", 1.25f);

        // [SKELETON] Anti-solid-color: camera background
        // [SKELETON] Cache Camera.main — NEVER use Camera.main directly, always use mainCam
        mainCam = Camera.main; // ok — skeleton preset background color retained

        // [SKELETON] Luna platform init (iOS audio pre-play)
        GFM_Luna.Init(gameObject);

        // [SKELETON] Create Canvas and UI text — use uiCanvas/guideText/scoreText directly
        uiCanvas = GFM_UI.CreateCanvas(1920, 1080);
        guideText = GFM_UI.CreateText(uiCanvas, "", new Vector2(0, 450), 52);
        scoreText = GFM_UI.CreateText(uiCanvas, "Score: 0", new Vector2(680, 480), 40);

        // [SKELETON] Idle game initialization — joystick + isometric camera
        joystick = GFM_Joystick.Create(uiCanvas, 180f);
        if (mainCam != null)
        {
            mainCam.orthographic = true;
            mainCam.orthographicSize = 8f;
            mainCam.transform.position = new Vector3(0, 12f, -8f);
            mainCam.transform.rotation = Quaternion.Euler(50f, 0f, 0f);
        }

        // === TODO: AI fills — create game objects, setup scene layout, etc. ===
        // IMPORTANT: Do NOT create Canvas again (use uiCanvas). Do NOT use Camera.main (use mainCam).
        // IMPORTANT for idle games: Use the pre-built MovePlayer(), TryCollect(), TryDeliver() in Update.
        //   player = GameObject.Find("__Pool_Capsule_Blue_01"); // use pool object, NOT GFM_Create.Obj
        //   Then in Update: MovePlayer(); TryCollect(iceSource, "ice", 5, 1.5f); TryDeliver(machine, "ice", 1.5f);
        // TODO_START_START
        // Entities already registered/fetched via GameSceneCtrl above. Just ensure hidden initially.
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
        // Extra upgrade/UI visuals removed — only approved pool mapping entities used
        CrusherUpgrade = null;
        HydraulicUpgrade = null;
        GoldUI = null;
        GuideUI = null;
        // Assign player to PlayerSingleDrill (pool object) and place it visible.
        player = PlayerSingleDrill;
        if (player != null) {
            var pp = player.transform.position;
            pp.x = 0f; pp.y = 0.5f; pp.z = -2f;
            player.transform.position = pp;
        }
        // Initialize form table so SwitchForm/SwitchPlayerForm actually swap the controlled model
        InitForms();
        _resources = new ResourceDef[] {
            new ResourceDef { resourceId="MetalShard", displayName="MetalShard", convertFrom="", convertRatio=1 },
            new ResourceDef { resourceId="Gold", displayName="Gold", convertFrom="MetalShard", convertRatio=1 }
        };
        // TODO_START_END

        // [SKELETON] Sync AI-filled _resources into GFM_EconomyManager (state owner)
        _SyncResourcesToManager();

        // [SKELETON] Register AutoPlay targets with GFM_AutoPlay (state owner)
        GFM_AutoPlay.Instance.SetTargets(_autoTargets);

        // [SKELETON] Wire AutoPlay arrival callback — Manager calls OnAutoPlayArrive per target
        GFM_AutoPlay.Instance.OnArrive = OnAutoPlayArrive;

        UpdateGameState();
    }

    void Update()
    {
        if (gameEnded) return;

        float dt = Time.deltaTime;
        gameTimer += dt;

        // [SKELETON] AutoPlay activation — delegated to GFM_AutoPlay.Instance (DO NOT MODIFY)
        // Manager does 2-stage detection (flag + 6s real-time delay) internally.
        GFM_AutoPlay.Instance.CheckActivation(gameTimer);
        _autoPlayMode = GFM_AutoPlay.Instance.IsActive;      // sync local for skeleton reads
        _autoPlaySteps = GFM_AutoPlay.Instance.Steps;        // sync step count

        // [SKELETON] Phase timer update
        if (currentPhaseName != lastPhaseForTimer) {
            phaseTimer = 0f;
            lastPhaseForTimer = currentPhaseName;
        }
        phaseTimer += dt;
        if (_collectCooldown > 0f) _collectCooldown -= Time.deltaTime;

        CheckEventRules();

        // [SKELETON] Idle game core loop
        if (!_autoPlayMode) MovePlayer(); // interactive mode: joystick/tap
        if (_autoPlayMode) AutoPlayUpdate(); // autoPlay mode: trigger interactions for CUA

        // === TODO: AI fills — update systems: resource collection, delivery, production, etc. ===
        // Use TryCollect/TryDeliver for resource flow. Example:
        // if (TryCollect(iceSource, "ice", 5, 1.5f)) { /* picked up ice */ }
        // int delivered = TryDeliver(waterMachine, "ice", 1.5f);
        // if (delivered > 0) { waterMachineState = 1; /* machine producing */ }
        // UpdateCarryVisuals(); // show stack on player back
        // TODO_UPDATE_START
        UpdateCTAButtonInteractive();
        // Target-specific interaction — a tap only counts if the player is near the phase's required target.
        if (!_autoPlayMode && (Input.GetMouseButtonDown(0) || (Input.touchCount > 0 && Input.GetTouch(0).phase == TouchPhase.Began))) {
            switch (currentPhaseName) {
                case "initialCollectSpaceJunk":
                    if (IsNear(SpaceJunk, 2.5f) || IsNear(MetalShard, 2.5f)) {
                        initialCollectSpaceJunkInteractionDone = true; initialCollectSpaceJunkPlayerActed = true;
                        SpaceJunkDone = true; MetalShardDone = true;
                    }
                    break;
                case "sellShardToRecyclingStation":
                    if (IsNear(RecyclingStation, 3f)) {
                        sellShardToRecyclingStationInteractionDone = true; sellShardToRecyclingStationPlayerActed = true;
                        RecyclingStationDone = true;
                    }
                    break;
                case "buildForgeWorkshop":
                    if (IsNear(ForgeBlueprint, 2.5f) || IsNear(ForgeWorkshop, 2.5f)) {
                        buildForgeWorkshopInteractionDone = true; buildForgeWorkshopPlayerActed = true;
                        ForgeBlueprintDone = true;
                        if (ForgeWorkshopState < 2) ForgeWorkshopState = 2;
                        ForgeWorkshopDone = true;
                    }
                    break;
                case "upgradeToTripleDrill":
                    if (IsNear(ForgeWorkshop, 2.5f)) {
                        upgradeToTripleDrillInteractionDone = true; upgradeToTripleDrillPlayerActed = true;
                        if (PlayerTripleDrillState < 2) PlayerTripleDrillState = 2;
                        PlayerTripleDrillDone = true;
                    }
                    break;
                case "tripleDrillCollectJunk":
                    if (IsNear(SpaceJunk, 2.5f) || IsNear(MetalShard, 2.5f)) {
                        tripleDrillCollectJunkInteractionDone = true; tripleDrillCollectJunkPlayerActed = true;
                    }
                    break;
                case "upgradeToCrusherVehicle":
                    if (IsNear(ForgeWorkshop, 2.5f)) {
                        upgradeToCrusherVehicleInteractionDone = true; upgradeToCrusherVehiclePlayerActed = true;
                        if (CrusherVehicleState < 2) CrusherVehicleState = 2;
                        CrusherVehicleDone = true;
                    }
                    break;
                case "crusherVehicleCollectJunk":
                    if (IsNear(SpaceJunk, 2.5f) || IsNear(MetalShard, 2.5f)) {
                        crusherVehicleCollectJunkInteractionDone = true; crusherVehicleCollectJunkPlayerActed = true;
                    }
                    break;
                case "upgradeToHydraulicVehicle":
                    if (IsNear(ForgeWorkshop, 2.5f)) {
                        upgradeToHydraulicVehicleInteractionDone = true; upgradeToHydraulicVehiclePlayerActed = true;
                        if (HydraulicVehicleState < 2) HydraulicVehicleState = 2;
                    }
                    break;
                case "hydraulicVehicleCollectJunk":
                    if (IsNear(SpaceJunk, 2.5f) || IsNear(MetalShard, 2.5f)) {
                        hydraulicVehicleCollectJunkInteractionDone = true; hydraulicVehicleCollectJunkPlayerActed = true;
                    }
                    break;
                case "expandSpaceStationModules":
                    if (IsNear(CanteenBlueprint, 2.5f) || IsNear(Canteen, 2.5f)) {
                        CanteenBlueprintDone = true;
                        if (CanteenState < 2) CanteenState = 2;
                        CanteenDone = true;
                    }
                    if (IsNear(DormBlueprint, 2.5f) || IsNear(Dormitory, 2.5f)) {
                        DormBlueprintDone = true;
                        if (DormitoryState < 2) DormitoryState = 2;
                        DormitoryDone = true;
                    }
                    if (IsNear(PastureBlueprint, 2.5f) || IsNear(Pasture, 2.5f)) {
                        PastureBlueprintDone = true;
                        if (PastureState < 2) PastureState = 2;
                        PastureDone = true;
                    }
                    // Phase completes only when all three modules are built
                    if (CanteenDone && DormitoryDone && PastureDone) {
                        expandSpaceStationModulesInteractionDone = true;
                        expandSpaceStationModulesPlayerActed = true;
                    }
                    break;
                case "showFullStationCTA":
                    if (IsNear(CTAButton, 2.5f)) {
                        showFullStationCTAInteractionDone = true; showFullStationCTAPlayerActed = true;
                        CTAButtonDone = true;
                        if (CTAButtonState < 2) CTAButtonState++;
                    }
                    break;
            }
        }


        if (_collectCooldown <= 0f && IsNear(MetalShard, collectRange)) {
            if (MetalShardCarried < maxCarry) {
                MetalShardCarried++;
                _collectCooldown = collectCooldownInterval;
                string _score_MetalShard = "MetalShard: " + MetalShardCarried + "/" + maxCarry;
                if (_lastScoreText != _score_MetalShard) { scoreText.text = _score_MetalShard; _lastScoreText = _score_MetalShard; }
            }
        }

        if (_collectCooldown <= 0f && IsNear(GoldUI, collectRange)) {
            if (GoldCarried < maxCarry) {
                GoldCarried++;
                _collectCooldown = collectCooldownInterval;
                string _score_Gold = "Gold: " + GoldCarried + "/" + maxCarry;
                if (_lastScoreText != _score_Gold) { scoreText.text = _score_Gold; _lastScoreText = _score_Gold; }
            }
        }

        if (IsNear(ForgeWorkshop, 2f)) {
            if (MetalShardCarried > 0) {
                AddResource("MetalShard", MetalShardCarried);
                MetalShardCarried = 0;
                if (GetResource("MetalShard") >= 1) {
                    ForgeWorkshopState++;
                }
            }
            if (GoldCarried > 0) {
                AddResource("Gold", GoldCarried);
                GoldCarried = 0;
                if (GetResource("Gold") >= 1) {
                    ForgeWorkshopState++;
                }
            }
        }

        if (IsNear(PlayerTripleDrill, 2f)) {
            if (MetalShardCarried > 0) {
                AddResource("MetalShard", MetalShardCarried);
                MetalShardCarried = 0;
                if (GetResource("MetalShard") >= 1) {
                    PlayerTripleDrillState++;
                }
            }
            if (GoldCarried > 0) {
                AddResource("Gold", GoldCarried);
                GoldCarried = 0;
                if (GetResource("Gold") >= 1) {
                    PlayerTripleDrillState++;
                }
            }
        }

        if (IsNear(CrusherVehicle, 2f)) {
            if (MetalShardCarried > 0) {
                AddResource("MetalShard", MetalShardCarried);
                MetalShardCarried = 0;
                if (GetResource("MetalShard") >= 1) {
                    CrusherVehicleState++;
                }
            }
            if (GoldCarried > 0) {
                AddResource("Gold", GoldCarried);
                GoldCarried = 0;
                if (GetResource("Gold") >= 1) {
                    CrusherVehicleState++;
                }
            }
        }

        if (IsNear(HydraulicVehicle, 2f)) {
            if (MetalShardCarried > 0) {
                AddResource("MetalShard", MetalShardCarried);
                MetalShardCarried = 0;
                if (GetResource("MetalShard") >= 1) {
                    HydraulicVehicleState++;
                }
            }
            if (GoldCarried > 0) {
                AddResource("Gold", GoldCarried);
                GoldCarried = 0;
                if (GetResource("Gold") >= 1) {
                    HydraulicVehicleState++;
                }
            }
        }
        // TODO_UPDATE_END
        // TODO_CUSTOM_START
        // TODO_CUSTOM_START
        // TODO_CUSTOM_1: 根据当前飞船形态设置采集间隔
        float _drillInterval = 1f;
        if (HydraulicVehicleState >= 2) _drillInterval = 0.1f;
        else if (CrusherVehicleState >= 2) _drillInterval = 0.2f;
        else if (PlayerTripleDrillState >= 2) _drillInterval = 0.5f;
        else _drillInterval = 1f;

        if (_collectCooldown <= 0f && SpaceJunk != null && IsNear(SpaceJunk, 2.5f)) {
            if (MetalShardCarried < 10) {
                MetalShardCarried++;
                AddResource("MetalShard", 1);
                _collectCooldown = _drillInterval;
                SpaceJunkDone = true;
                MetalShardDone = true;
                if (player != null) ShowFloatingText(player.transform.position, "+1 碎片", Color.cyan);
            }
        }

        // TODO_CUSTOM_2: 接近回收站自动吸附采集资源并转换为金币
        if (RecyclingStation != null && IsNear(RecyclingStation, 3f)) {
            // 吸附：将玩家身上携带的碎片拉向回收站方向
            if (player != null) {
                Vector3 pullDir = RecyclingStation.transform.position - player.transform.position;
                pullDir.y = 0f;
                if (pullDir.magnitude > 0.1f) {
                    player.transform.position += pullDir.normalized * 2f * Time.deltaTime;
                }
            }
            // 自动转换为金币
            if (MetalShardCarried > 0) {
                int _converted = MetalShardCarried;
                GoldCarried += _converted * 2;
                AddGold(_converted * 2);
                AddResource("Gold", _converted * 2);
                MetalShardCarried = 0;
                if (TrySpend("MetalShard", _converted)) { /* consumed */ }
                RecyclingStationDone = true;
                sellShardToRecyclingStationInteractionDone = true;
                sellShardToRecyclingStationPlayerActed = true;
                if (player != null) ShowFloatingText(player.transform.position, "+" + (_converted * 2) + " 金币", Color.yellow);
            }
        }
        // TODO_CUSTOM_END

        // TODO_CUSTOM_END
    }

    void CheckEventRules()
    {
        // ========== Phase 1: 初始太空捡垃圾 (initialCollectSpaceJunk) ==========
        // Duration: 3-8s
        // Interactions: move_to:SpaceJunk, collect:MetalShard:1
        // Player must act: true
        if (!ruleTriggered[0])
        {
            ruleTriggered[0] = true;
            currentPhaseName = "initialCollectSpaceJunk"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[0] = gameTimer; // [SKELETON]
            ReportPhase("initialCollectSpaceJunk"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] Anti-solid-color: show initial objects (pool objects have pre-baked colors — do NOT call SetColor)
            PlaceObj(ForgeWorkshop, -3f, 0.5f, 0f); // pool color: brown — do NOT call SetColor
            SetScale(ForgeWorkshop, 1f, 1f, 1f); // keep original scale — avoid oversized black rectangles
            PlaceObj(PlayerTripleDrill, 0f, 0.5f, 0f); // pool color: blue — do NOT call SetColor
            SetScale(PlayerTripleDrill, 1f, 1f, 1f); // keep original scale — avoid oversized black rectangles
            PlaceObj(CrusherVehicle, 3f, 0.5f, 0f); // pool color: red — do NOT call SetColor
            SetScale(CrusherVehicle, 1f, 1f, 1f); // keep original scale — avoid oversized black rectangles

            // === TODO: AI fills — place additional objects, set colors, show guide ===
            // TODO_PHASE_1_INIT_START
                PlaceObj(PlayerSingleDrill, 2f, 0.5f, -2f);
                PlaceObj(SpaceJunk, 4f, 0.5f, 2f);
                SetScale(SpaceJunk, 0.8f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                PlaceObj(MetalShard, 4f, 0.7f, 2f);
                SetScale(MetalShard, 0.3f);
                guideText.text = "收集太空垃圾获取金属碎片";
                AddResource("default", 1);
        // TODO_PHASE_1_INIT_END

            AddCompletedPhase("gameStart");
            UpdateGameState();
        }

        // ========== Phase 2: 回站售卖碎片换金币 (sellShardToRecyclingStation) ==========
        // Duration: 2-7s
        // Interactions: move_to:RecyclingStation, deliver:MetalShard:RecyclingStation
        // Player must act: true
        // [SKELETON] Transition from initialCollectSpaceJunk → sellShardToRecyclingStation
        // Requires: 玩家单钻头飞船收纳仓装满金属碎片
        // Condition hint: PlayerSingleDrill.StorageFull == true
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[1] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[1]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (SpaceJunkDone == true && phaseTimer >= 3f))) // interactive mode
        {
            ruleTriggered[1] = true;
            currentPhaseName = "sellShardToRecyclingStation"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[1] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("sellShardToRecyclingStation"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 回站售卖碎片换金币 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 回站售卖碎片换金币 ===
            // TODO_PHASE_2_INIT_START
                PlaceObj(PlayerSingleDrill, 2f, 0.5f, -2f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                PlaceObj(MetalShard, 4f, 0.7f, 2f);
                SetScale(MetalShard, 0.3f);
                HideObj(SpaceJunk);
                guideText.text = "将碎片运送回收站换取金币";
                AddResource("default", 1);
        // TODO_PHASE_2_INIT_END

            AddCompletedPhase("initialCollectSpaceJunk"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 3: 建造锻造间 (buildForgeWorkshop) ==========
        // Duration: 3-8s
        // Interactions: click:ForgeBlueprint, spend:goldObj:1, build:ForgeWorkshop
        // Player must act: true
        // [SKELETON] Transition from sellShardToRecyclingStation → buildForgeWorkshop
        // Requires: 所有金属碎片售卖完成
        // Condition hint: PlayerSingleDrill.StorageEmpty == true
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[2] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[2]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (RecyclingStationDone == true && phaseTimer >= 2f))) // interactive mode
        {
            ruleTriggered[2] = true;
            currentPhaseName = "buildForgeWorkshop"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[2] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("buildForgeWorkshop"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 建造锻造间 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 建造锻造间 ===
            // TODO_PHASE_3_INIT_START
                PlaceObj(PlayerSingleDrill, 2f, 0.5f, -2f);
                PlaceObj(ForgeBlueprint, -3f, 1.2f, 1f);
                SetScale(ForgeBlueprint, 1.2f);
                PlaceObj(ForgeWorkshop, -3f, 0.8f, 1f);
                SetScale(ForgeWorkshop, 1.2f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                HideObj(MetalShard);
                guideText.text = "点击蓝图建造锻造间";
                UnknownState = 1;
        // TODO_PHASE_3_INIT_END

            AddCompletedPhase("sellShardToRecyclingStation"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 4: 升级三钻头飞船 (upgradeToTripleDrill) ==========
        // Duration: 2-7s
        // Interactions: click:ForgeWorkshop, spend:goldObj:1, upgrade:PlayerSingleDrill:2
        // Player must act: true
        // [SKELETON] Transition from buildForgeWorkshop → upgradeToTripleDrill
        // Requires: 锻造间建造完成
        // Condition hint: ForgeWorkshop.State == 2
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[3] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[3]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (ForgeWorkshopState >= 2 && ForgeBlueprintDone == true && phaseTimer >= 3f))) // interactive mode
        {
            ruleTriggered[3] = true;
            currentPhaseName = "upgradeToTripleDrill"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[3] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("upgradeToTripleDrill"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 升级三钻头飞船 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                ForgeWorkshopState = 2;
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 升级三钻头飞船 ===
            // TODO_PHASE_4_INIT_START
                PlaceObj(PlayerTripleDrill, 2f, 0.5f, -2f);
                SetScale(PlayerTripleDrill, 1.1f);
                PlaceObj(ForgeWorkshop, -3f, 0.8f, 1f);
                SetScale(ForgeWorkshop, 1.2f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                HideObj(ForgeBlueprint);
                guideText.text = "在锻造间升级三钻头飞船";
                SwitchPlayerForm(1); // single → triple drill (also hides PlayerSingleDrill)
        // TODO_PHASE_4_INIT_END

            AddCompletedPhase("buildForgeWorkshop"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 5: 三钻头高效收集垃圾 (tripleDrillCollectJunk) ==========
        // Duration: 3-8s
        // Interactions: move_to:SpaceJunk, collect:MetalShard:1
        // Player must act: true
        // [SKELETON] Transition from upgradeToTripleDrill → tripleDrillCollectJunk
        // Requires: 三钻头飞船升级完成
        // Condition hint: PlayerTripleDrill.State == 2
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[4] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[4]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (PlayerTripleDrillState >= 2 && ForgeWorkshopDone == true && phaseTimer >= 2f))) // interactive mode
        {
            ruleTriggered[4] = true;
            currentPhaseName = "tripleDrillCollectJunk"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[4] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("tripleDrillCollectJunk"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 三钻头高效收集垃圾 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                PlayerTripleDrillState = 2;
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 三钻头高效收集垃圾 ===
            // TODO_PHASE_5_INIT_START
                PlaceObj(PlayerTripleDrill, 2f, 0.5f, -2f);
                SetScale(PlayerTripleDrill, 1.1f);
                PlaceObj(SpaceJunk, 4f, 0.5f, 2f);
                SetScale(SpaceJunk, 0.8f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                PlaceObj(MetalShard, 4f, 0.7f, 2f);
                SetScale(MetalShard, 0.3f);
                guideText.text = "三钻头高效收集垃圾";
                AddResource("default", 1);
        // TODO_PHASE_5_INIT_END

            AddCompletedPhase("upgradeToTripleDrill"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 6: 升级粉碎车 (upgradeToCrusherVehicle) ==========
        // Duration: 2-7s
        // Interactions: click:ForgeWorkshop, spend:goldObj:1, upgrade:PlayerTripleDrill:3
        // Player must act: true
        // [SKELETON] Transition from tripleDrillCollectJunk → upgradeToCrusherVehicle
        // Requires: 三钻头飞船收纳仓装满金属碎片
        // Condition hint: PlayerTripleDrill.StorageFull == true
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[5] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[5]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (tripleDrillCollectJunkInteractionDone == true && phaseTimer >= 3f))) // interactive mode
        {
            ruleTriggered[5] = true;
            currentPhaseName = "upgradeToCrusherVehicle"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[5] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("upgradeToCrusherVehicle"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 升级粉碎车 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 升级粉碎车 ===
            // TODO_PHASE_6_INIT_START
                PlaceObj(CrusherVehicle, 2f, 0.5f, -2f);
                SetScale(CrusherVehicle, 1.2f);
                PlaceObj(ForgeWorkshop, -3f, 0.8f, 1f);
                SetScale(ForgeWorkshop, 1.2f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                HideObj(SpaceJunk);
                HideObj(MetalShard);
                guideText.text = "升级粉碎车解锁新能力";
                SwitchPlayerForm(2); // triple → crusher vehicle (also hides PlayerTripleDrill)
        // TODO_PHASE_6_INIT_END

            AddCompletedPhase("tripleDrillCollectJunk"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 7: 粉碎车收集大型垃圾 (crusherVehicleCollectJunk) ==========
        // Duration: 3-8s
        // Interactions: move_to:SpaceJunk, collect:MetalShard:1
        // Player must act: true
        // [SKELETON] Transition from upgradeToCrusherVehicle → crusherVehicleCollectJunk
        // Requires: 粉碎车升级完成
        // Condition hint: CrusherVehicle.State == 2
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[6] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[6]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (CrusherVehicleState >= 2 && ForgeWorkshopDone == true && phaseTimer >= 2f))) // interactive mode
        {
            ruleTriggered[6] = true;
            currentPhaseName = "crusherVehicleCollectJunk"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[6] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("crusherVehicleCollectJunk"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 粉碎车收集大型垃圾 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                CrusherVehicleState = 2;
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 粉碎车收集大型垃圾 ===
            // TODO_PHASE_7_INIT_START
                PlaceObj(CrusherVehicle, 2f, 0.5f, -2f);
                SetScale(CrusherVehicle, 1.2f);
                PlaceObj(SpaceJunk, 4f, 0.5f, 2f);
                SetScale(SpaceJunk, 0.8f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                PlaceObj(MetalShard, 4f, 0.7f, 2f);
                SetScale(MetalShard, 0.3f);
                guideText.text = "粉碎车海量收集太空垃圾";
                AddResource("default", 1);
        // TODO_PHASE_7_INIT_END

            AddCompletedPhase("upgradeToCrusherVehicle"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 8: 升级液压车 (upgradeToHydraulicVehicle) ==========
        // Duration: 2-7s
        // Interactions: click:ForgeWorkshop, spend:goldObj:1, upgrade:CrusherVehicle:4
        // Player must act: true
        // [SKELETON] Transition from crusherVehicleCollectJunk → upgradeToHydraulicVehicle
        // Requires: 粉碎车收纳仓装满金属碎片
        // Condition hint: CrusherVehicle.StorageFull == true
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[7] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[7]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (crusherVehicleCollectJunkInteractionDone == true && phaseTimer >= 3f))) // interactive mode
        {
            ruleTriggered[7] = true;
            currentPhaseName = "upgradeToHydraulicVehicle"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[7] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("upgradeToHydraulicVehicle"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 升级液压车 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 升级液压车 ===
            // TODO_PHASE_8_INIT_START
                PlaceObj(HydraulicVehicle, 2f, 0.5f, -2f);
                SetScale(HydraulicVehicle, 1.3f);
                PlaceObj(ForgeWorkshop, -3f, 0.8f, 1f);
                SetScale(ForgeWorkshop, 1.2f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                HideObj(SpaceJunk);
                HideObj(MetalShard);
                guideText.text = "升级液压车达到最终形态";
                SwitchPlayerForm(3); // crusher → hydraulic vehicle (also hides CrusherVehicle)
        // TODO_PHASE_8_INIT_END

            AddCompletedPhase("crusherVehicleCollectJunk"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 9: 液压车海量收集垃圾 (hydraulicVehicleCollectJunk) ==========
        // Duration: 3-8s
        // Interactions: move_to:SpaceJunk, collect:MetalShard:1
        // Player must act: true
        // [SKELETON] Transition from upgradeToHydraulicVehicle → hydraulicVehicleCollectJunk
        // Requires: 液压车升级完成
        // Condition hint: HydraulicVehicle.State == 2
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[8] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[8]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (HydraulicVehicleState >= 2 && ForgeWorkshopDone == true && phaseTimer >= 2f))) // interactive mode
        {
            ruleTriggered[8] = true;
            currentPhaseName = "hydraulicVehicleCollectJunk"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[8] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("hydraulicVehicleCollectJunk"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 液压车海量收集垃圾 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                HydraulicVehicleState = 2;
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 液压车海量收集垃圾 ===
            // TODO_PHASE_9_INIT_START
                PlaceObj(HydraulicVehicle, 2f, 0.5f, -2f);
                SetScale(HydraulicVehicle, 1.3f);
                PlaceObj(SpaceJunk, 4f, 0.5f, 2f);
                SetScale(SpaceJunk, 0.8f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                PlaceObj(MetalShard, 4f, 0.7f, 2f);
                SetScale(MetalShard, 0.3f);
                guideText.text = "液压车极速收集积累财富";
                AddResource("default", 1);
        // TODO_PHASE_9_INIT_END

            AddCompletedPhase("upgradeToHydraulicVehicle"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 10: 解锁新船舱扩建空间站 (expandSpaceStationModules) ==========
        // Duration: 4-9s
        // Interactions: click:CanteenBlueprint, spend:goldObj:1, build:Canteen, click:DormBlueprint, spend:goldObj:1, build:Dormitory, click:PastureBlueprint, spend:goldObj:1, build:Pasture
        // Player must act: true
        // [SKELETON] Transition from hydraulicVehicleCollectJunk → expandSpaceStationModules
        // Requires: 液压车收纳仓装满金属碎片
        // Condition hint: HydraulicVehicle.StorageFull == true
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[9] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[9]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (hydraulicVehicleCollectJunkInteractionDone == true && phaseTimer >= 3f))) // interactive mode
        {
            ruleTriggered[9] = true;
            currentPhaseName = "expandSpaceStationModules"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[9] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("expandSpaceStationModules"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 解锁新船舱扩建空间站 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 解锁新船舱扩建空间站 ===
            // TODO_PHASE_10_INIT_START
                PlaceObj(CanteenBlueprint, 4f, 1.2f, 0f);
                PlaceObj(Canteen, 4f, 0.8f, 0f);
                PlaceObj(DormBlueprint, 6f, 1.2f, 0f);
                PlaceObj(Dormitory, 6f, 0.8f, 0f);
                PlaceObj(PastureBlueprint, -4f, 1.2f, -2f);
                PlaceObj(Pasture, -4f, 0.8f, -2f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                // Keep HydraulicVehicle visible — it is the active player form in this phase
                PlaceObj(HydraulicVehicle, 2f, 0.5f, -2f);
                HideObj(SpaceJunk);
                HideObj(MetalShard);
                guideText.text = "建造餐厅宿舍牧场扩建空间站";
                UnknownState = 1;
        // TODO_PHASE_10_INIT_END

            AddCompletedPhase("hydraulicVehicleCollectJunk"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 11: 完整空间站展示+下载CTA (showFullStationCTA) ==========
        // Duration: 5-15s
        // Interactions: wait:5, click:CTAButton
        // Player must act: true
        // [SKELETON] Transition from expandSpaceStationModules → showFullStationCTA
        // Requires: 餐厅、宿舍、牧场全部建造完成
        // Condition hint: Canteen.State == 2 && Dormitory.State == 2 && Pasture.State == 2
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[10] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[10]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (CanteenState >= 2 && DormitoryState >= 2 && PastureState >= 2 && CanteenBlueprintDone == true && phaseTimer >= 4f))) // interactive mode
        {
            ruleTriggered[10] = true;
            currentPhaseName = "showFullStationCTA"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[10] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("showFullStationCTA"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 完整空间站展示+下载CTA (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                CanteenState = 2;
                DormitoryState = 2;
                PastureState = 2;
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 完整空间站展示+下载CTA ===
            // TODO_PHASE_11_INIT_START
                PlaceObj(Canteen, 4f, 0.8f, 0f);
                PlaceObj(Dormitory, 6f, 0.8f, 0f);
                PlaceObj(Pasture, -4f, 0.8f, -2f);
                PlaceObj(CTAButton, 0.5f, 0.8f, 0f);
                SetScale(CTAButton, 0.8f);
                PlaceObj(RecyclingStation, 0f, 0.8f, 0f);
                SetScale(RecyclingStation, 1.5f);
                HideObj(CanteenBlueprint);
                HideObj(DormBlueprint);
                HideObj(PastureBlueprint);
                guideText.text = "完整空间站建成点击下载完整版";
                if (player != null) ShowFloatingText(player.transform.position, "空间站完成!", Color.yellow);
        // TODO_PHASE_11_INIT_END

            AddCompletedPhase("expandSpaceStationModules"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Game End ==========
        // End condition hint: CTAButton.Clicked == true
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[11] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[11]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (CTAButtonDone == true && phaseTimer >= 5f)))
        {
            ruleTriggered[11] = true;
            currentPhaseName = "gameEnd";
            ReportPhase("gameEnd"); // [SKELETON] Phase instrumentation
            gameEnded = true;

            // [SKELETON] AutoPlay: set all entities to terminal state
            if (_autoPlayMode)
            {
                ForgeWorkshopState = 2;
                PlayerTripleDrillState = 2;
                CrusherVehicleState = 2;
                HydraulicVehicleState = 2;
                CanteenState = 2;
                DormitoryState = 2;
                PastureState = 2;
                SpaceJunkState = 2;
                MetalShardState = 2;
                RecyclingStationState = 2;
                ForgeBlueprintState = 2;
                PlayerSingleDrillState = 2;
                CanteenBlueprintState = 2;
                DormBlueprintState = 2;
                PastureBlueprintState = 2;
                CTAButtonState = 2;
                goldObjState = 2;
            }
            // [SKELETON] Verify all entities reached terminal state
            // Assert: ForgeWorkshopState should be 2 at game end
            // Assert: PlayerTripleDrillState should be 2 at game end
            // Assert: CrusherVehicleState should be 2 at game end
            // Assert: HydraulicVehicleState should be 2 at game end
            // Assert: CanteenState should be 2 at game end
            // Assert: DormitoryState should be 2 at game end
            // Assert: PastureState should be 2 at game end
            // Assert: SpaceJunkState should be 2 at game end
            // Assert: MetalShardState should be 2 at game end
            // Assert: RecyclingStationState should be 2 at game end
            // Assert: ForgeBlueprintState should be 2 at game end
            // Assert: PlayerSingleDrillState should be 2 at game end
            // Assert: CanteenBlueprintState should be 2 at game end
            // Assert: DormBlueprintState should be 2 at game end
            // Assert: PastureBlueprintState should be 2 at game end
            // Assert: CTAButtonState should be 2 at game end
            // Assert: goldObjState should be 2 at game end

            AddCompletedPhase("showFullStationCTA");
            AddCompletedPhase("gameEnd");
            ShowCTA();
            UpdateGameState();
        }

        // [SKELETON] AutoPlay safety net — force progression if stuck (DO NOT MODIFY)
        if (_autoPlayMode && !gameEnded && phaseTimer >= (AUTO_PLAY_PHASE_DURATION < 15f ? 50f : AUTO_PLAY_PHASE_DURATION * 2.5f)) // [SKELETON] safety net min 50s (DO NOT MODIFY)
        {
            if (!ruleTriggered[1]) // stuck at initialCollectSpaceJunk → force sellShardToRecyclingStation
            {
                ruleTriggered[1] = true;
                currentPhaseName = "sellShardToRecyclingStation";
                phaseEnterTimes[1] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("sellShardToRecyclingStation");
                AddCompletedPhase("initialCollectSpaceJunk");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[2]) // stuck at sellShardToRecyclingStation → force buildForgeWorkshop
            {
                ruleTriggered[2] = true;
                currentPhaseName = "buildForgeWorkshop";
                phaseEnterTimes[2] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("buildForgeWorkshop");
                AddCompletedPhase("sellShardToRecyclingStation");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[3]) // stuck at buildForgeWorkshop → force upgradeToTripleDrill
            {
                ruleTriggered[3] = true;
                currentPhaseName = "upgradeToTripleDrill";
                phaseEnterTimes[3] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("upgradeToTripleDrill");
                AddCompletedPhase("buildForgeWorkshop");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[4]) // stuck at upgradeToTripleDrill → force tripleDrillCollectJunk
            {
                ruleTriggered[4] = true;
                currentPhaseName = "tripleDrillCollectJunk";
                phaseEnterTimes[4] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("tripleDrillCollectJunk");
                AddCompletedPhase("upgradeToTripleDrill");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[5]) // stuck at tripleDrillCollectJunk → force upgradeToCrusherVehicle
            {
                ruleTriggered[5] = true;
                currentPhaseName = "upgradeToCrusherVehicle";
                phaseEnterTimes[5] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("upgradeToCrusherVehicle");
                AddCompletedPhase("tripleDrillCollectJunk");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[6]) // stuck at upgradeToCrusherVehicle → force crusherVehicleCollectJunk
            {
                ruleTriggered[6] = true;
                currentPhaseName = "crusherVehicleCollectJunk";
                phaseEnterTimes[6] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("crusherVehicleCollectJunk");
                AddCompletedPhase("upgradeToCrusherVehicle");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[7]) // stuck at crusherVehicleCollectJunk → force upgradeToHydraulicVehicle
            {
                ruleTriggered[7] = true;
                currentPhaseName = "upgradeToHydraulicVehicle";
                phaseEnterTimes[7] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("upgradeToHydraulicVehicle");
                AddCompletedPhase("crusherVehicleCollectJunk");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[8]) // stuck at upgradeToHydraulicVehicle → force hydraulicVehicleCollectJunk
            {
                ruleTriggered[8] = true;
                currentPhaseName = "hydraulicVehicleCollectJunk";
                phaseEnterTimes[8] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("hydraulicVehicleCollectJunk");
                AddCompletedPhase("upgradeToHydraulicVehicle");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[9]) // stuck at hydraulicVehicleCollectJunk → force expandSpaceStationModules
            {
                ruleTriggered[9] = true;
                currentPhaseName = "expandSpaceStationModules";
                phaseEnterTimes[9] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("expandSpaceStationModules");
                AddCompletedPhase("hydraulicVehicleCollectJunk");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[10]) // stuck at expandSpaceStationModules → force showFullStationCTA
            {
                ruleTriggered[10] = true;
                currentPhaseName = "showFullStationCTA";
                phaseEnterTimes[10] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("showFullStationCTA");
                AddCompletedPhase("expandSpaceStationModules");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[11]) // stuck at showFullStationCTA → force gameEnd
            {
                ruleTriggered[11] = true;
                currentPhaseName = "gameEnd";
                ReportPhase("gameEnd");
                AddCompletedPhase("showFullStationCTA");
                AddCompletedPhase("gameEnd");
                gameEnded = true;
                ShowCTA();
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
        }
    }

    // NOTE: Game subsystems (movement, combat, spawning, etc.) go in GameFlowManagerMain.Systems.cs

    // ========== SKELETON HELPERS (do not modify) ==========

    void AddCompletedPhase(string phaseName)
    {
        if (completedPhaseCount < completedPhases.Length)
        {
            completedPhases[completedPhaseCount] = phaseName;
            completedPhaseCount++;
        }
    }

    // [SKELETON] Transform helpers — struct-copy pattern to minimize Vector3 alloc on hot paths
    void PlaceObj(GameObject obj, float x, float y, float z)
    {
        if (obj == null) return;
        var pos = obj.transform.position;
        pos.x = x; pos.y = y; pos.z = z;
        obj.transform.position = pos;
    }

    void HideObj(GameObject obj)
    {
        if (obj == null) return;
        var pos = obj.transform.position;
        pos.x = 0f; pos.y = -999f; pos.z = 0f;
        obj.transform.position = pos;
    }

    void SetScale(GameObject obj, float x, float y, float z)
    {
        if (obj == null) return;
        var s = obj.transform.localScale;
        s.x = x; s.y = y; s.z = z;
        obj.transform.localScale = s;
    }
    void SetScale(GameObject obj, float uniform)
    {
        if (obj == null) return;
        var s = obj.transform.localScale;
        s.x = uniform; s.y = uniform; s.z = uniform;
        obj.transform.localScale = s;
    }

    // [SKELETON] CTA button — pre-generated, do not remove
    void ShowCTA()
    {
        Luna.Unity.LifeCycle.GameEnded();
        Luna.Unity.Playable.InstallFullGame();
    }

    void UpdateGameState()
    {
        // [SKELETON] Expose game state for CUA verification
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
            + "\"SpaceJunk\":\"" + SpaceJunkState + "\","
            + "\"MetalShard\":\"" + MetalShardState + "\","
            + "\"RecyclingStation\":\"" + RecyclingStationState + "\","
            + "\"ForgeBlueprint\":\"" + ForgeBlueprintState + "\","
            + "\"PlayerSingleDrill\":\"" + PlayerSingleDrillState + "\","
            + "\"CanteenBlueprint\":\"" + CanteenBlueprintState + "\","
            + "\"DormBlueprint\":\"" + DormBlueprintState + "\","
            + "\"PastureBlueprint\":\"" + PastureBlueprintState + "\","
            + "\"CTAButton\":\"" + CTAButtonState + "\","
            + "\"goldObj\":\"" + goldObjState + "\""
            + "},"
            + "\"variables\":{"
            + "\"gameTimer\":" + (int)gameTimer
            + ",\"autoPlayMode\":" + (_autoPlayMode ? "true" : "false")
            + ",\"autoPlaySteps\":" + _autoPlaySteps
            + ",\"autoPlayStepsThisPhase\":" + (_autoPlaySteps - _autoPlayStepsAtPhaseStart)
            // TODO: AI adds game-specific variables here (gold, wood, ammo, etc.)
            + "}"
            + ",\"phaseTimestamps\":{"
            + "\"initialCollectSpaceJunk\":" + (phaseEnterTimes[0] > 0 ? (int)phaseEnterTimes[0] : 0) + ","
            + "\"sellShardToRecyclingStation\":" + (phaseEnterTimes[1] > 0 ? (int)phaseEnterTimes[1] : 0) + ","
            + "\"buildForgeWorkshop\":" + (phaseEnterTimes[2] > 0 ? (int)phaseEnterTimes[2] : 0) + ","
            + "\"upgradeToTripleDrill\":" + (phaseEnterTimes[3] > 0 ? (int)phaseEnterTimes[3] : 0) + ","
            + "\"tripleDrillCollectJunk\":" + (phaseEnterTimes[4] > 0 ? (int)phaseEnterTimes[4] : 0) + ","
            + "\"upgradeToCrusherVehicle\":" + (phaseEnterTimes[5] > 0 ? (int)phaseEnterTimes[5] : 0) + ","
            + "\"crusherVehicleCollectJunk\":" + (phaseEnterTimes[6] > 0 ? (int)phaseEnterTimes[6] : 0) + ","
            + "\"upgradeToHydraulicVehicle\":" + (phaseEnterTimes[7] > 0 ? (int)phaseEnterTimes[7] : 0) + ","
            + "\"hydraulicVehicleCollectJunk\":" + (phaseEnterTimes[8] > 0 ? (int)phaseEnterTimes[8] : 0) + ","
            + "\"expandSpaceStationModules\":" + (phaseEnterTimes[9] > 0 ? (int)phaseEnterTimes[9] : 0) + ","
            + "\"showFullStationCTA\":" + (phaseEnterTimes[10] > 0 ? (int)phaseEnterTimes[10] : 0) + ""
            + "}"
            + "}";

        // [SKELETON] Expose game state to JavaScript for CUA verification
        // Luna bridge exposes C# strings to JS via gameObject.name trick
        gameObject.name = "GFM|" + json;
    }

    // NOTE: UI helpers and input handlers go in GameFlowManagerMain.Systems.cs
}