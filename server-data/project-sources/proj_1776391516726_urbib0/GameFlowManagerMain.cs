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

    // [SKELETON] AutoPlay dual-mode — CUA verification uses autoPlay, end-user uses interactive
    bool _autoPlayMode = false;
    bool _autoPlayChecked = false;
    int _autoPlaySteps = 0; // [SKELETON] tracks autoPlay visual progress for CUA
    int _autoPlayStepsAtPhaseStart = 0; // [SKELETON] tracks autoPlay steps when current phase started
    const float AUTO_PLAY_PHASE_DURATION = 12f; // [SKELETON] 12s per shot — DO NOT MODIFY this value (DO NOT MODIFY)

    // [SKELETON] Entity states — must reach terminal state
    int ForgeWorkshopState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int PlayerTripleDrillState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int CrusherVehicleState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int HydraulicVehicleState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int CanteenState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int DormitoryState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int PastureState = 0; // 0=waiting, 1=building, 2=built [SKELETON]
    int CTAButtonState = 0; // 0=waiting, 1=building, 2=built [SKELETON]

    // [SKELETON] Anti-autoplay flags — AI MUST set these to true when player performs the required interaction
    bool initialCollectSpaceJunkInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool initialCollectSpaceJunkPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool SpaceJunkDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool sellShardsGetGoldInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool sellShardsGetGoldPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool RecyclingStationDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool buildForgeWorkshopInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool buildForgeWorkshopPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool ForgeBlueprintDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToTripleDrillInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToTripleDrillPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool ForgeWorkshopDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool tripleDrillCollectJunkInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool tripleDrillCollectJunkPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToCrusherVehicleInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToCrusherVehiclePlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool crusherVehicleCollectJunkInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool crusherVehicleCollectJunkPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToHydraulicVehicleInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool upgradeToHydraulicVehiclePlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool hydraulicVehicleCollectJunkInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool hydraulicVehicleCollectJunkPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool expandSpaceStationInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool expandSpaceStationPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool CanteenBlueprintDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool showFullStationCTAInteractionDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool showFullStationCTAPlayerActed = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)
    bool CTAButtonDone = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)

    // [SKELETON] Object references (auto-mapped from entity→pool)
    GameObject ForgeWorkshop; // → __Pool_Cube_Red_01
    GameObject PlayerTripleDrill; // → __Pool_Cube_Blue_01
    GameObject CrusherVehicle; // → __Pool_Cube_Blue_02
    GameObject HydraulicVehicle; // → __Pool_Cube_Green_01
    GameObject Canteen; // → __Pool_Cube_Yellow_01
    GameObject Dormitory; // → __Pool_Cube_Orange_01
    GameObject Pasture; // → __Pool_Cube_Purple_01
    GameObject CTAButton; // → __Pool_Cube_White_01
    GameObject SpaceJunk; // → __Pool_Cube_Brown_01
    GameObject MetalShard; // → __Pool_Cube_Cyan_01
    GameObject RecyclingStation; // → __Pool_Cube_Pink_01
    GameObject ForgeBlueprint; // → __Pool_Cube_Red_02
    GameObject goldObj; // → __Pool_Cube_Yellow_02
    GameObject PlayerSingleDrill; // → __Pool_Cube_Blue_03
    GameObject CanteenBlueprint; // → __Pool_Cube_Blue_04
    GameObject DormBlueprint; // → __Pool_Cube_Green_02
    GameObject PastureBlueprint; // → __Pool_Cube_Yellow_03

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

    // [SKELETON] Economy system — AI fills _resources array in Start()
    struct ResourceDef {
        public string resourceId;
        public string displayName;
        public string convertFrom; // upstream resource id, empty if primary
        public int convertRatio;   // how many upstream = 1 of this
    }
    ResourceDef[] _resources; // [SKELETON] AI: fill in Start()
    System.Collections.Generic.Dictionary<string, int> _inventory = new System.Collections.Generic.Dictionary<string, int>();

    void AddResource(string id, int amount) {
        if (!_inventory.ContainsKey(id)) _inventory[id] = 0;
        _inventory[id] += amount;
        UpdateResourceUI();
    }

    int GetResource(string id) {
        return _inventory.ContainsKey(id) ? _inventory[id] : 0;
    }

    bool TrySpend(string id, int amount) {
        if (GetResource(id) < amount) return false;
        _inventory[id] -= amount;
        UpdateResourceUI();
        return true;
    }

    bool TryConvert(string fromId, string toId) {
        if (_resources == null) return false;
        ResourceDef toDef = default;
        bool found = false;
        for (int i = 0; i < _resources.Length; i++) {
            if (_resources[i].resourceId == toId) { toDef = _resources[i]; found = true; break; }
        }
        if (!found || toDef.convertFrom != fromId) return false;
        if (GetResource(fromId) < toDef.convertRatio) return false;
        _inventory[fromId] -= toDef.convertRatio;
        AddResource(toId, 1);
        return true;
    }

    void UpdateResourceUI() {
        if (scoreText == null) return;
        var parts = new System.Collections.Generic.List<string>();
        foreach (var kv in _inventory) { if (kv.Value > 0) parts.Add(kv.Key + ": " + kv.Value); }
        scoreText.text = string.Join("  ", parts);
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
                Vector3 move = new Vector3(h, 0, v) * moveSpeed * Time.deltaTime;
                player.transform.position += move;
                player.transform.rotation = Quaternion.LookRotation(new Vector3(h, 0, v));
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

    // [SKELETON] Check if player is near a target (proximity trigger)
    bool IsNear(GameObject target, float range)
    {
        if (player == null || target == null) return false;
        return Vector3.Distance(player.transform.position, target.transform.position) < range;
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
            carryVisuals = new GameObject[10];
            for (int i = 0; i < 10; i++)
            {
                // AI: assign carry visual pool objects here via GameObject.Find
                // Do NOT use GFM_Create.Obj or GFM_Create.SetColor (both forbidden in Luna)
                carryVisuals[i] = GameObject.Find("__Pool_Cube_Yellow_" + (60 + i));
                HideObj(carryVisuals[i]);
            }
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
        if (floatingText == null) floatingText = GFM_UI.CreateText(uiCanvas, "", Vector2.zero, 24);
        if (floatingText != null) { floatingText.text = text; floatingText.color = color; floatingTextTimer = 1.5f; }
    }

    // ========== END IDLE GAME KIT ==========

    // [SKELETON] AutoPlay — auto-navigate player through target entities
    string[] _autoTargets = new string[] { "ForgeWorkshop", "CrusherVehicle", "HydraulicVehicle", "Canteen", "Dormitory", "Pasture", "CTAButton" };
    int _autoTargetIdx = 0;
    float _autoTargetWait = 0f;

    void AutoPlayUpdate()
    {
        if (!_autoPlayMode || player == null) return;
        if (_autoTargetWait > 0f) { _autoTargetWait -= Time.deltaTime; return; }
        if (_autoTargetIdx >= _autoTargets.Length) _autoTargetIdx = 0;
        GameObject target = GameObject.Find(_autoTargets[_autoTargetIdx]);
        if (target == null) { _autoTargetIdx++; return; }
        Vector3 dir = target.transform.position - player.transform.position;
        dir.y = 0f;
        if (dir.magnitude > 1.0f)
        {
            float speed = moveSpeed * 1.2f;
            player.transform.position = Vector3.MoveTowards(
                player.transform.position, target.transform.position, speed * Time.deltaTime);
            if (dir.magnitude > 0.1f)
                player.transform.rotation = Quaternion.Lerp(
                    player.transform.rotation, Quaternion.LookRotation(dir), 5f * Time.deltaTime);
            if (mainCam != null) mainCam.transform.LookAt(player.transform.position);
        }
        else
        {
            _autoTargetWait = 1.5f;
            _autoTargetIdx++;
            _autoPlaySteps++;
            OnAutoPlayArrive(_autoTargets[(_autoTargetIdx - 1) % _autoTargets.Length]);
        }
    }

    // [SKELETON] Called when autoPlay triggers an interaction (DO NOT REMOVE).
    // AI MUST fill this to simulate gameplay — CUA checks variables change.
    // [SKELETON] Empty OnAutoPlayArrive = CUA FAIL (variable stagnation)
    void OnAutoPlayArrive(string targetName)
    {
        // === TODO: AI fills — simulate interaction for each phase ===
        // Example: when targetName equals "rescuedCrew", do rescuedCount++ and gold += 10
        // TODO_AUTOPLAY_INTERACT_START
        // Auto-play interaction simulation
        if (currentPhaseName == "initialCollectSpaceJunk") {
            AddResource("MetalShard", 5);
            initialCollectSpaceJunkInteractionDone = true;
            initialCollectSpaceJunkPlayerActed = true;
        }
        if (currentPhaseName == "sellShardsGetGold") {
            RecyclingStationDone = true;
            RecyclingStationState++;
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
            AddResource("MetalShard", 8);
            tripleDrillCollectJunkInteractionDone = true;
            tripleDrillCollectJunkPlayerActed = true;
        }
        if (currentPhaseName == "upgradeToCrusherVehicle") {
            CrusherVehicleState = 2;
            upgradeToCrusherVehicleInteractionDone = true;
            upgradeToCrusherVehiclePlayerActed = true;
        }
        if (currentPhaseName == "crusherVehicleCollectJunk") {
            AddResource("MetalShard", 10);
            crusherVehicleCollectJunkInteractionDone = true;
            crusherVehicleCollectJunkPlayerActed = true;
        }
        if (currentPhaseName == "upgradeToHydraulicVehicle") {
            HydraulicVehicleState = 2;
            upgradeToHydraulicVehicleInteractionDone = true;
            upgradeToHydraulicVehiclePlayerActed = true;
        }
        if (currentPhaseName == "hydraulicVehicleCollectJunk") {
            AddResource("MetalShard", 15);
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
        // TODO_AUTOPLAY_INTERACT_END
    }

    // [SKELETON] Phase instrumentation for automated testing
    void ReportPhase(string phaseId) {
        // Bridge.NET compiles this to console.log which Playwright can capture
        UnityEngine.Debug.Log("__PHASE__:" + phaseId);
    }

    // === TODO: AI declares pools, counters, and game-specific variables below ===
    // TODO_VARIABLES_START
    float collectRange = 2f;
    int maxCarry = 10;
    int RecyclingStationState = 0;
    GameObject SpaceJunk2;
    GameObject SpaceJunk3;
        // TODO_VARIABLES_END

    void Start()
    {
        // [SKELETON] Initialize phase tracking
        ruleTriggered = new bool[RULE_COUNT];
        completedPhases = new string[RULE_COUNT + 5];
        phaseEnterTimes = new float[RULE_COUNT];

        // [SKELETON] Material and pool initialization
        GFM_Create.InitMaterialFromScene();

        // [SKELETON] Find all scene objects
        ForgeWorkshop = GameObject.Find("__Pool_Cube_Red_01");
        PlayerTripleDrill = GameObject.Find("__Pool_Cube_Blue_01");
        CrusherVehicle = GameObject.Find("__Pool_Cube_Blue_02");
        HydraulicVehicle = GameObject.Find("__Pool_Cube_Green_01");
        Canteen = GameObject.Find("__Pool_Cube_Yellow_01");
        Dormitory = GameObject.Find("__Pool_Cube_Orange_01");
        Pasture = GameObject.Find("__Pool_Cube_Purple_01");
        CTAButton = GameObject.Find("__Pool_Cube_White_01");
        SpaceJunk = GameObject.Find("__Pool_Cube_Brown_01");
        MetalShard = GameObject.Find("__Pool_Cube_Cyan_01");
        RecyclingStation = GameObject.Find("__Pool_Cube_Pink_01");
        ForgeBlueprint = GameObject.Find("__Pool_Cube_Red_02");
        goldObj = GameObject.Find("__Pool_Cube_Yellow_02");
        PlayerSingleDrill = GameObject.Find("__Pool_Cube_Blue_03");
        CanteenBlueprint = GameObject.Find("__Pool_Cube_Blue_04");
        DormBlueprint = GameObject.Find("__Pool_Cube_Green_02");
        PastureBlueprint = GameObject.Find("__Pool_Cube_Yellow_03");

        // [SKELETON] Anti-solid-color: camera background
        // [SKELETON] Cache Camera.main — NEVER use Camera.main directly, always use mainCam
        mainCam = Camera.main; // ok
        if (mainCam != null) mainCam.backgroundColor = new Color(135f, 206f, 235f);

        // [SKELETON] Luna platform init (iOS audio pre-play)
        GFM_Luna.Init(gameObject);

        // [SKELETON] Create Canvas and UI text — use uiCanvas/guideText/scoreText directly
        uiCanvas = GFM_UI.CreateCanvas(960, 640);
        guideText = GFM_UI.CreateText(uiCanvas, "", new Vector2(0, 270), 26);
        scoreText = GFM_UI.CreateText(uiCanvas, "Score: 0", new Vector2(340, 290), 20);

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
        SpaceJunk = GameObject.Find("__Pool_Cube_Gray_01");
        HideObj(SpaceJunk);
        SpaceJunk2 = GameObject.Find("__Pool_Cube_Gray_02");
        HideObj(SpaceJunk2);
        SpaceJunk3 = GameObject.Find("__Pool_Cube_Gray_03");
        HideObj(SpaceJunk3);
        RecyclingStation = GameObject.Find("__Pool_Building_Blue_01");
        HideObj(RecyclingStation);
        ForgeWorkshop = GameObject.Find("__Pool_Building_Red_01");
        HideObj(ForgeWorkshop);
        PlayerSingleDrill = GameObject.Find("__Pool_Ship_Yellow_01");
        HideObj(PlayerSingleDrill);
        PlayerTripleDrill = GameObject.Find("__Pool_Ship_Yellow_02");
        HideObj(PlayerTripleDrill);
        CrusherVehicle = GameObject.Find("__Pool_Vehicle_Orange_01");
        HideObj(CrusherVehicle);
        HydraulicVehicle = GameObject.Find("__Pool_Vehicle_Purple_01");
        HideObj(HydraulicVehicle);
        Canteen = GameObject.Find("__Pool_Building_Green_01");
        HideObj(Canteen);
        Dormitory = GameObject.Find("__Pool_Building_Green_02");
        HideObj(Dormitory);
        Pasture = GameObject.Find("__Pool_Building_Green_03");
        HideObj(Pasture);
        CTAButton = GameObject.Find("__Pool_Cube_White_01");
        HideObj(CTAButton);
        _resources = new ResourceDef[] {
            new ResourceDef { resourceId="MetalShard", displayName="MetalShard", convertFrom="SpaceJunk", convertRatio=1 }
        };
        _inventory["MetalShard"] = 0;
        // TODO_START_END

        UpdateGameState();
    }

    void Update()
    {
        if (gameEnded) return;

        float dt = Time.deltaTime;
        gameTimer += dt;

        // [SKELETON] AutoPlay detection — keeps checking until found or timeout (DO NOT MODIFY)
        // JS bridge creates __AUTOPLAY_ON__ entity async via setInterval; may arrive after 0.5s
        if (!_autoPlayMode && !_autoPlayChecked)
        {
            if (GameObject.Find("__AUTOPLAY_ON__") != null) { _autoPlayMode = true; _autoPlayChecked = true; }
            else if (gameTimer > 3.0f) _autoPlayChecked = true; // stop checking after 3s
        }

        // [SKELETON] Phase timer update
        if (currentPhaseName != lastPhaseForTimer) {
            phaseTimer = 0f;
            lastPhaseForTimer = currentPhaseName;
        }
        phaseTimer += dt;

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
            if (currentPhaseName == "showFullStationCTA") { showFullStationCTAInteractionDone = true; showFullStationCTAPlayerActed = true; }
        }

        // TODO_UPDATE_END
        // TODO_CUSTOM_START
        // TODO_CUSTOM_START
        // TODO_CUSTOM_1: 每次收集交互在玩家库存中添加1个金属碎片
        if (SpaceJunk != null && IsNear(SpaceJunk, GetCollectRange()))
        {
            if (GetResource("MetalShard") < GetCarryCapacity())
            {
                AddResource("MetalShard", 1);
                SpaceJunkDone = true;
            }
        }
        if (GameObject.Find("__Pool_Cube_Gray_02") != null && IsNear(GameObject.Find("__Pool_Cube_Gray_02"), GetCollectRange()))
        {
            if (GetResource("MetalShard") < GetCarryCapacity())
            {
                AddResource("MetalShard", 1);
                SpaceJunkDone = true;
            }
        }

        // TODO_CUSTOM_2: 库存满时玩家必须返回回收站出售
        bool inventoryFull = GetResource("MetalShard") >= GetCarryCapacity();
        if (inventoryFull && guideText != null && currentPhaseName != "sellShardsGetGold")
        {
            guideText.text = "库存已满！返回回收站出售金属碎片";
        }

        // TODO_CUSTOM_3: 向回收站出售每次交付获得10金币
        if (RecyclingStation != null && IsNear(RecyclingStation, 2f))
        {
            int shardCount = GetResource("MetalShard");
            if (shardCount > 0 && TrySpend("MetalShard", shardCount))
            {
                AddGold(10 * shardCount);
                RecyclingStationDone = true;
                RecyclingStationState = 2;
                ShowFloatingText(player != null ? player.transform.position : Vector3.zero, "+" + (10 * shardCount) + " 金币", Color.yellow);
            }
        }

        // TODO_CUSTOM_4: 建造需要从锻造间UI花费指定金币
        if (ForgeWorkshop != null && IsNear(ForgeWorkshop, 2f) && Input.GetMouseButtonDown(0))
        {
            int buildCost = 10;
            if (gold >= buildCost)
            {
                gold -= buildCost;
                if (scoreText != null) scoreText.text = "💰 " + gold;
                ForgeBlueprintDone = true;
                ForgeWorkshopDone = true;
                if (ForgeWorkshopState < 2) ForgeWorkshopState = 2;
                else if (PlayerTripleDrillState < 2) { PlayerTripleDrillState = 2; SwitchForm(1); }
                else if (CrusherVehicleState < 2) { CrusherVehicleState = 2; SwitchForm(2); }
                else if (HydraulicVehicleState < 2) { HydraulicVehicleState = 2; SwitchForm(3); }
            }
        }

        // TODO_CUSTOM_5: 升级完成时形态立即切换
        if (PlayerTripleDrillState == 2 && _currentFormIndex < 1 && _forms != null && _forms.Length > 1)
        {
            SwitchForm(1);
        }
        if (CrusherVehicleState == 2 && _currentFormIndex < 2 && _forms != null && _forms.Length > 2)
        {
            SwitchForm(2);
        }
        if (HydraulicVehicleState == 2 && _currentFormIndex < 3 && _forms != null && _forms.Length > 3)
        {
            SwitchForm(3);
        }
        // TODO_CUSTOM_END

        // TODO_CUSTOM_END
    }

    void CheckEventRules()
    {
        // ========== Phase 1: 初始太空捡垃圾 (initialCollectSpaceJunk) ==========
        // Duration: 3-8s
        // Interactions: move_to:SpaceJunk, collect:MetalShard
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
                PlaceObj(PlayerSingleDrill, 0f, 0.5f, 0f);
                PlaceObj(SpaceJunk, 2f, 0.5f, -1.5f);
                SetScale(SpaceJunk, 0.8f);
                PlaceObj(SpaceJunk2, -2.5f, 0.5f, 2f);
                SetScale(SpaceJunk2, 0.85f);
                guideText.text = "移动到太空垃圾处并收集金属碎片";
                AddResource("MetalShard", 0);
        // TODO_PHASE_1_INIT_END

            AddCompletedPhase("gameStart");
            UpdateGameState();
        }

        // ========== Phase 2: 回站售卖碎片换金币 (sellShardsGetGold) ==========
        // Duration: 2-7s
        // Interactions: move_to:RecyclingStation, deliver:MetalShard:RecyclingStation
        // Player must act: true
        // [SKELETON] Transition from initialCollectSpaceJunk → sellShardsGetGold
        // Requires: 玩家单钻头飞船收纳仓装满金属碎片
        // Condition hint: PlayerSingleDrill.StorageFull == true
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[1] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[1]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (SpaceJunkDone == true && phaseTimer >= 3f))) // interactive mode
        {
            ruleTriggered[1] = true;
            currentPhaseName = "sellShardsGetGold"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[1] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("sellShardsGetGold"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 回站售卖碎片换金币 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 回站售卖碎片换金币 ===
            // TODO_PHASE_2_INIT_START
                PlaceObj(PlayerSingleDrill, 0f, 0.5f, 0f);
                PlaceObj(RecyclingStation, -5.5f, 1f, -3.5f);
                SetScale(RecyclingStation, 1.5f);
                HideObj(SpaceJunk);
                HideObj(SpaceJunk2);
                guideText.text = "回到回收站售卖金属碎片";
                RecyclingStationState = 1;
        // TODO_PHASE_2_INIT_END

            AddCompletedPhase("initialCollectSpaceJunk"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 3: 建造锻造间 (buildForgeWorkshop) ==========
        // Duration: 3-8s
        // Interactions: click:ForgeBlueprint, spend:gold:1, build:ForgeWorkshop
        // Player must act: true
        // [SKELETON] Transition from sellShardsGetGold → buildForgeWorkshop
        // Requires: 金属碎片全部售卖完成，金币到账
        // Condition hint: PlayerSingleDrill.StorageEmpty == true && GoldUI.Value > 0
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
                PlaceObj(PlayerSingleDrill, 0f, 0.5f, 0f);
                PlaceObj(ForgeWorkshop, 5.5f, 1f, 3.5f);
                SetScale(ForgeWorkshop, 1.3f);
                HideObj(RecyclingStation);
                guideText.text = "点击锻造间蓝图并建造";
                ForgeWorkshopState = 1;
        // TODO_PHASE_3_INIT_END

            AddCompletedPhase("sellShardsGetGold"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 4: 升级三钻头 (upgradeToTripleDrill) ==========
        // Duration: 2-7s
        // Interactions: click:ForgeWorkshop, spend:gold:1, transform:PlayerSingleDrill:PlayerTripleDrill
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

            // [SKELETON] AutoPlay state advance for 升级三钻头 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                ForgeWorkshopState = 2;
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 升级三钻头 ===
            // TODO_PHASE_4_INIT_START
                PlaceObj(PlayerTripleDrill, 0f, 0.5f, 0f);
                SetScale(PlayerTripleDrill, 1.2f);
                PlaceObj(ForgeWorkshop, 5.5f, 1f, 3.5f);
                SetScale(ForgeWorkshop, 1.3f);
                HideObj(PlayerSingleDrill);
                guideText.text = "在锻造间升级为三钻头飞船";
                SwitchForm(1);
        // TODO_PHASE_4_INIT_END

            AddCompletedPhase("buildForgeWorkshop"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 5: 三钻头高效收集垃圾 (tripleDrillCollectJunk) ==========
        // Duration: 3-8s
        // Interactions: move_to:SpaceJunk, collect:MetalShard
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
                PlaceObj(PlayerTripleDrill, 0f, 0.5f, 0f);
                SetScale(PlayerTripleDrill, 1.2f);
                PlaceObj(SpaceJunk, 2f, 0.5f, -1.5f);
                SetScale(SpaceJunk, 0.8f);
                PlaceObj(SpaceJunk3, 4.5f, 0.5f, 1f);
                SetScale(SpaceJunk3, 0.75f);
                HideObj(ForgeWorkshop);
                guideText.text = "用三钻头飞船高效收集垃圾";
                AddResource("MetalShard", 0);
        // TODO_PHASE_5_INIT_END

            AddCompletedPhase("upgradeToTripleDrill"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 6: 升级粉碎车 (upgradeToCrusherVehicle) ==========
        // Duration: 2-7s
        // Interactions: click:ForgeWorkshop, spend:gold:1, transform:PlayerTripleDrill:CrusherVehicle
        // Player must act: true
        // [SKELETON] Transition from tripleDrillCollectJunk → upgradeToCrusherVehicle
        // Requires: 三钻头飞船收纳仓装满金属碎片
        // Condition hint: PlayerTripleDrill.StorageFull == true
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[5] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[5]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (SpaceJunkDone == true && phaseTimer >= 3f))) // interactive mode
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
                PlaceObj(CrusherVehicle, 0f, 0.5f, 0f);
                SetScale(CrusherVehicle, 1.1f);
                PlaceObj(ForgeWorkshop, 5.5f, 1f, 3.5f);
                SetScale(ForgeWorkshop, 1.3f);
                HideObj(PlayerTripleDrill);
                HideObj(SpaceJunk);
                HideObj(SpaceJunk3);
                guideText.text = "升级为粉碎车增强收集力";
                SwitchForm(2);
        // TODO_PHASE_6_INIT_END

            AddCompletedPhase("tripleDrillCollectJunk"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 7: 粉碎车收集垃圾 (crusherVehicleCollectJunk) ==========
        // Duration: 3-8s
        // Interactions: move_to:SpaceJunk, collect:MetalShard
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

            // [SKELETON] AutoPlay state advance for 粉碎车收集垃圾 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                CrusherVehicleState = 2;
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 粉碎车收集垃圾 ===
            // TODO_PHASE_7_INIT_START
                PlaceObj(CrusherVehicle, 0f, 0.5f, 0f);
                SetScale(CrusherVehicle, 1.1f);
                PlaceObj(SpaceJunk2, -2.5f, 0.5f, 2f);
                SetScale(SpaceJunk2, 0.85f);
                PlaceObj(SpaceJunk, 2f, 0.5f, -1.5f);
                SetScale(SpaceJunk, 0.8f);
                HideObj(ForgeWorkshop);
                guideText.text = "驾驶粉碎车收集更多垃圾";
                AddResource("MetalShard", 0);
        // TODO_PHASE_7_INIT_END

            AddCompletedPhase("upgradeToCrusherVehicle"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 8: 升级液压车 (upgradeToHydraulicVehicle) ==========
        // Duration: 2-7s
        // Interactions: click:ForgeWorkshop, spend:gold:1, transform:CrusherVehicle:HydraulicVehicle
        // Player must act: true
        // [SKELETON] Transition from crusherVehicleCollectJunk → upgradeToHydraulicVehicle
        // Requires: 粉碎车收纳仓装满金属碎片
        // Condition hint: CrusherVehicle.StorageFull == true
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[7] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[7]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (SpaceJunkDone == true && phaseTimer >= 3f))) // interactive mode
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
                PlaceObj(HydraulicVehicle, 0f, 0.5f, 0f);
                SetScale(HydraulicVehicle, 1.15f);
                PlaceObj(ForgeWorkshop, 5.5f, 1f, 3.5f);
                SetScale(ForgeWorkshop, 1.3f);
                HideObj(CrusherVehicle);
                HideObj(SpaceJunk2);
                HideObj(SpaceJunk);
                guideText.text = "升级为液压车解锁终极模式";
                SwitchForm(3);
        // TODO_PHASE_8_INIT_END

            AddCompletedPhase("crusherVehicleCollectJunk"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 9: 液压车海量收集垃圾 (hydraulicVehicleCollectJunk) ==========
        // Duration: 3-8s
        // Interactions: move_to:SpaceJunk, collect:MetalShard
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
                PlaceObj(HydraulicVehicle, 0f, 0.5f, 0f);
                SetScale(HydraulicVehicle, 1.15f);
                PlaceObj(SpaceJunk3, 4.5f, 0.5f, 1f);
                SetScale(SpaceJunk3, 0.75f);
                PlaceObj(SpaceJunk, 2f, 0.5f, -1.5f);
                SetScale(SpaceJunk, 0.8f);
                HideObj(ForgeWorkshop);
                guideText.text = "用液压车海量收集太空垃圾";
                AddResource("MetalShard", 0);
        // TODO_PHASE_9_INIT_END

            AddCompletedPhase("upgradeToHydraulicVehicle"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 10: 解锁新船舱扩建空间站 (expandSpaceStation) ==========
        // Duration: 4-9s
        // Interactions: click:CanteenBlueprint, spend:gold:1, build:Canteen, click:DormBlueprint, spend:gold:1, build:Dormitory, click:PastureBlueprint, spend:gold:1, build:Pasture
        // Player must act: true
        // [SKELETON] Transition from hydraulicVehicleCollectJunk → expandSpaceStation
        // Requires: 液压车收纳仓装满，金币满足新船舱建造要求
        // Condition hint: HydraulicVehicle.StorageFull == true && GoldUI.Value >= 100
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[9] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[9]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (SpaceJunkDone == true && phaseTimer >= 3f))) // interactive mode
        {
            ruleTriggered[9] = true;
            currentPhaseName = "expandSpaceStation"; // [IMMUTABLE] Do NOT change this phaseId
            phaseEnterTimes[9] = gameTimer; // [SKELETON]
            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame
            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter
            ReportPhase("expandSpaceStation"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking

            // [SKELETON] AutoPlay state advance for 解锁新船舱扩建空间站 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 解锁新船舱扩建空间站 ===
            // TODO_PHASE_10_INIT_START
                PlaceObj(HydraulicVehicle, 0f, 0.5f, 0f);
                SetScale(HydraulicVehicle, 1.15f);
                PlaceObj(Canteen, 3.5f, 1f, -2f);
                SetScale(Canteen, 1.2f);
                PlaceObj(Dormitory, -4f, 1f, -2.5f);
                SetScale(Dormitory, 1.25f);
                PlaceObj(Pasture, 0.5f, 1f, 3.8f);
                SetScale(Pasture, 1.3f);
                HideObj(SpaceJunk3);
                HideObj(SpaceJunk);
                guideText.text = "建造餐厅、宿舍、牧场扩展空间站";
                CanteenState = 1;
                DormitoryState = 1;
                PastureState = 1;
        // TODO_PHASE_10_INIT_END

            AddCompletedPhase("hydraulicVehicleCollectJunk"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Phase 11: 完整空间站展示+下载引导 (showFullStationCTA) ==========
        // Duration: 5-10s
        // Interactions: wait:5, click:CTAButton
        // Player must act: false
        // [SKELETON] Transition from expandSpaceStation → showFullStationCTA
        // Requires: 餐厅、宿舍、牧场全部建造完成，空间站扩建完毕
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

            // [SKELETON] AutoPlay state advance for 完整空间站展示+下载引导 (DO NOT MODIFY)
            if (_autoPlayMode)
            {
                CanteenState = 2;
                DormitoryState = 2;
                PastureState = 2;
                _autoPlaySteps++;
            }

            // === TODO: AI fills — activate objects for 完整空间站展示+下载引导 ===
            // TODO_PHASE_11_INIT_START
                PlaceObj(HydraulicVehicle, 0f, 0.5f, 0f);
                SetScale(HydraulicVehicle, 1.15f);
                PlaceObj(Canteen, 3.5f, 1f, -2f);
                SetScale(Canteen, 1.2f);
                PlaceObj(Dormitory, -4f, 1f, -2.5f);
                SetScale(Dormitory, 1.25f);
                PlaceObj(Pasture, 0.5f, 1f, 3.8f);
                SetScale(Pasture, 1.3f);
                PlaceObj(CTAButton, 0f, 2f, 0f);
                guideText.text = "空间站建造完成！点击下载完整版";
                ShowFloatingText(player.transform.position, "游戏完整版等你来探索！", Color.yellow);
        // TODO_PHASE_11_INIT_END

            AddCompletedPhase("expandSpaceStation"); // [IMMUTABLE] Must match spec phaseId exactly
            UpdateGameState();
        }

        // ========== Game End ==========
        // End condition hint: CTAButton.Clicked == true || WaitTime >= 5
        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK
        if (_autoPlayMode && !ruleTriggered[11] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action
        else if (!ruleTriggered[11]
            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)
                : (CTAButtonState >= 1 && 5Done == true && phaseTimer >= 5f)))
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
                CTAButtonState = 2;
            }
            // [SKELETON] Verify all entities reached terminal state
            // Assert: ForgeWorkshopState should be 2 at game end
            // Assert: PlayerTripleDrillState should be 2 at game end
            // Assert: CrusherVehicleState should be 2 at game end
            // Assert: HydraulicVehicleState should be 2 at game end
            // Assert: CanteenState should be 2 at game end
            // Assert: DormitoryState should be 2 at game end
            // Assert: PastureState should be 2 at game end
            // Assert: CTAButtonState should be 2 at game end

            AddCompletedPhase("showFullStationCTA");
            AddCompletedPhase("gameEnd");
            ShowCTA();
            UpdateGameState();
            Luna.Unity.LifeCycle.GameEnded();
        }

        // [SKELETON] AutoPlay safety net — force progression if stuck (DO NOT MODIFY)
        if (_autoPlayMode && !gameEnded && phaseTimer >= (AUTO_PLAY_PHASE_DURATION < 15f ? 50f : AUTO_PLAY_PHASE_DURATION * 2.5f)) // [SKELETON] safety net min 50s (DO NOT MODIFY)
        {
            if (!ruleTriggered[1]) // stuck at initialCollectSpaceJunk → force sellShardsGetGold
            {
                ruleTriggered[1] = true;
                currentPhaseName = "sellShardsGetGold";
                phaseEnterTimes[1] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("sellShardsGetGold");
                AddCompletedPhase("initialCollectSpaceJunk");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[2]) // stuck at sellShardsGetGold → force buildForgeWorkshop
            {
                ruleTriggered[2] = true;
                currentPhaseName = "buildForgeWorkshop";
                phaseEnterTimes[2] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("buildForgeWorkshop");
                AddCompletedPhase("sellShardsGetGold");
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
            if (!ruleTriggered[9]) // stuck at hydraulicVehicleCollectJunk → force expandSpaceStation
            {
                ruleTriggered[9] = true;
                currentPhaseName = "expandSpaceStation";
                phaseEnterTimes[9] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("expandSpaceStation");
                AddCompletedPhase("hydraulicVehicleCollectJunk");
                _autoPlaySteps++;
                UpdateGameState();
                return; // only advance one phase per frame
            }
            if (!ruleTriggered[10]) // stuck at expandSpaceStation → force showFullStationCTA
            {
                ruleTriggered[10] = true;
                currentPhaseName = "showFullStationCTA";
                phaseEnterTimes[10] = gameTimer;
                phaseTimer = 0f;
                ReportPhase("showFullStationCTA");
                AddCompletedPhase("expandSpaceStation");
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

    void PlaceObj(GameObject obj, float x, float y, float z)
    {
        if (obj != null) obj.transform.position = new Vector3(x, y, z);
    }

    void HideObj(GameObject obj)
    {
        if (obj != null) obj.transform.position = new Vector3(0f, -999f, 0f);
    }

    void SetScale(GameObject obj, float x, float y, float z)
    {
        if (obj != null) obj.transform.localScale = new Vector3(x, y, z);
    }
    void SetScale(GameObject obj, float uniform)
    {
        if (obj != null) obj.transform.localScale = new Vector3(uniform, uniform, uniform);
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
            + "\"CTAButton\":\"" + CTAButtonState + "\""
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

        // [SKELETON] Expose game state to JavaScript for CUA verification
        // Luna bridge exposes C# strings to JS via gameObject.name trick
        gameObject.name = "GFM|" + json;
    }

    // NOTE: UI helpers and input handlers go in GameFlowManagerMain.Systems.cs
}