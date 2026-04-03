/**
 * Skeleton Generator — Generate GameFlowManagerMain.cs skeleton from phase specs
 *
 * Input: Phase specs array + entity→pool mapping + GFM_Tools API configuration
 * Output: C# skeleton code with enforced phaseTimer, interaction gates, pre-generated boilerplate
 *
 * The skeleton ensures:
 * - Every phase has minimum dwell time (from spec.duration.min)
 * - Every phase transition requires spec.triggerNext.condition
 * - AI can only fill TODO sections, cannot remove skeleton-enforced code
 * - All entities must reach terminal state before game ends
 * - Start() is pre-populated with Find() calls, colors, camera, GFM_Luna.Init()
 * - ShowCTA() is pre-generated with InstallFullGame()
 * - Phase 1 places 3 objects to prevent solid-color screen
 */

const fs = require('fs');
const path = require('path');

// Default colors for anti-solid-color initialization
const GROUND_COLOR = { r: 0.75, g: 0.78, b: 0.82 };
const CAMERA_BG = { r: 0.45, g: 0.52, b: 0.62 };
const ENTITY_COLORS = [
  { r: 0.6, g: 0.3, b: 0.15, label: 'brown' },
  { r: 0.2, g: 0.4, b: 0.9, label: 'blue' },
  { r: 0.8, g: 0.2, b: 0.2, label: 'red' },
  { r: 0.2, g: 0.7, b: 0.3, label: 'green' },
  { r: 0.9, g: 0.7, b: 0.1, label: 'gold' }
];

/**
 * Generate C# skeleton from specs
 * @param {Array} specs - Phase specs from spec-extractor
 * @param {object} opts - { projectName, entityPoolMap: {entityName: poolObjName} }
 * @returns {string} C# skeleton code
 */
function generateSkeleton(specs, opts = {}) {
  const totalPhases = specs.length;
  const entityPoolMap = opts.entityPoolMap || {};
  const entityNames = Object.keys(entityPoolMap);
  const lines = [];

  // Header
  lines.push('// ========== AUTO-GENERATED SKELETON — DO NOT MODIFY SKELETON LINES ==========');
  lines.push('// Generated from storyboard spec. AI fills TODO sections only.');
  lines.push('// Lines marked [SKELETON] must not be removed or modified.');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('using UnityEngine.UI;');
  lines.push('');
  lines.push('public class GameFlowManagerMain : MonoBehaviour');
  lines.push('{');

  // Phase timer system (skeleton-enforced)
  lines.push('    // [SKELETON] Phase timing system — enforces minimum dwell time per phase');
  lines.push('    float phaseTimer = 0f;');
  lines.push('    string lastPhaseForTimer = "";');
  lines.push('    float[] phaseEnterTimes;  // [SKELETON] records when each phase was entered');
  lines.push('');

  // Game state variables (skeleton-enforced)
  lines.push('    // [SKELETON] Phase tracking');
  lines.push(`    const int RULE_COUNT = ${totalPhases + 2};`);
  lines.push('    bool[] ruleTriggered;');
  lines.push('    string currentPhaseName = "init";');
  lines.push('    string[] completedPhases;');
  lines.push('    int completedPhaseCount = 0;');
  lines.push('    float gameTimer;');
  lines.push('    bool gameEnded = false;');
  lines.push('');

  // Entity state variables from specs
  const allEntities = new Set();
  specs.forEach(spec => {
    (spec.entitiesRequired || []).forEach(e => allEntities.add(e.name));
  });
  if (allEntities.size > 0) {
    lines.push('    // [SKELETON] Entity states — must reach terminal state');
    allEntities.forEach(name => {
      lines.push(`    int ${name}State = 0; // 0=waiting, 1=building, 2=built [SKELETON]`);
    });
    lines.push('');
  }

  // [SKELETON] Pre-generated GameObject declarations from entity→pool mapping
  if (entityNames.length > 0) {
    lines.push('    // [SKELETON] Object references (auto-mapped from entity→pool)');
    entityNames.forEach(name => {
      lines.push(`    GameObject ${name}; // → ${entityPoolMap[name]}`);
    });
    lines.push('');
  }

  // [SKELETON] Pre-created Camera, Canvas, UI references
  lines.push('    // [SKELETON] Camera reference — use mainCam instead of Camera.main');
  lines.push('    Camera mainCam;');
  lines.push('    // [SKELETON] UI references — canvas and text pre-created, use directly');
  lines.push('    Canvas uiCanvas;');
  lines.push('    Text guideText;');
  lines.push('    Text scoreText;');
  lines.push('');

  // Detect idle/tycoon game pattern (has joystick + resource interactions)
  const hasJoystick = specs.some(s => (s.requiredInteractions || []).some(i => i.startsWith('move_to:')));
  const hasResources = specs.some(s => (s.requiredInteractions || []).some(i => i.startsWith('collect:') || i.startsWith('deliver:')));
  const isIdleGame = hasJoystick && hasResources;

  if (isIdleGame) {
    lines.push('    // ========== [SKELETON] IDLE GAME KIT — Pre-built systems ==========');
    lines.push('    // All systems below are working code. AI should CALL these, not rewrite them.');
    lines.push('');
    lines.push('    // --- Player Movement (joystick-driven) ---');
    lines.push('    GFM_Joystick joystick;');
    lines.push('    GameObject player;');
    lines.push('    float moveSpeed = 5f;');
    lines.push('    int carrying = 0; // generic resource count on player back');
    lines.push('    string carryingType = ""; // what resource type');
    lines.push('    int gold = 0;');
    lines.push('');
    lines.push('    // [SKELETON] Tap-to-move target (fallback for joystick)');
    lines.push('    Vector3 tapMoveTarget = Vector3.zero;');
    lines.push('    bool hasTapTarget = false;');
    lines.push('');
    lines.push('    // [SKELETON] Move player by joystick + tap-to-move fallback — call in Update()');
    lines.push('    void MovePlayer()');
    lines.push('    {');
    lines.push('        if (player == null) return;');
    lines.push('        // Priority 1: Joystick');
    lines.push('        if (joystick != null)');
    lines.push('        {');
    lines.push('            float h = joystick.Horizontal;');
    lines.push('            float v = joystick.Vertical;');
    lines.push('            if (Mathf.Abs(h) > 0.1f || Mathf.Abs(v) > 0.1f)');
    lines.push('            {');
    lines.push('                Vector3 move = new Vector3(h, 0, v) * moveSpeed * Time.deltaTime;');
    lines.push('                player.transform.position += move;');
    lines.push('                player.transform.rotation = Quaternion.LookRotation(new Vector3(h, 0, v));');
    lines.push('                hasTapTarget = false;');
    lines.push('                return;');
    lines.push('            }');
    lines.push('        }');
    lines.push('        // Priority 2: Tap-to-move (click on game area → raycast → move toward click)');
    lines.push('        if (Input.GetMouseButtonDown(0) && mainCam != null)');
    lines.push('        {');
    lines.push('            Vector2 sp = Input.mousePosition;');
    lines.push('            // Ignore clicks on joystick area (bottom-left 200x200)');
    lines.push('            if (sp.x > 200f || sp.y > 200f)');
    lines.push('            {');
    lines.push('                Ray ray = mainCam.ScreenPointToRay(sp);');
    lines.push('                float t = -ray.origin.y / ray.direction.y;');
    lines.push('                if (t > 0f) { tapMoveTarget = ray.origin + ray.direction * t; hasTapTarget = true; }');
    lines.push('            }');
    lines.push('        }');
    lines.push('        // Move toward tap target');
    lines.push('        if (hasTapTarget)');
    lines.push('        {');
    lines.push('            Vector3 diff = tapMoveTarget - player.transform.position;');
    lines.push('            diff.y = 0;');
    lines.push('            if (diff.magnitude > 0.3f)');
    lines.push('            {');
    lines.push('                Vector3 move = diff.normalized * moveSpeed * Time.deltaTime;');
    lines.push('                player.transform.position += move;');
    lines.push('                player.transform.rotation = Quaternion.LookRotation(diff.normalized);');
    lines.push('            }');
    lines.push('            else { hasTapTarget = false; }');
    lines.push('        }');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] Check if player is near a target (proximity trigger)');
    lines.push('    bool IsNear(GameObject target, float range)');
    lines.push('    {');
    lines.push('        if (player == null || target == null) return false;');
    lines.push('        return Vector3.Distance(player.transform.position, target.transform.position) < range;');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] Auto-collect: when player near source, pick up resources');
    lines.push('    // Returns true if collected this frame');
    lines.push('    bool TryCollect(GameObject source, string resType, int maxCarry, float range)');
    lines.push('    {');
    lines.push('        if (source == null || !IsNear(source, range)) return false;');
    lines.push('        if (carrying >= maxCarry) return false;');
    lines.push('        carrying++;');
    lines.push('        carryingType = resType;');
    lines.push('        return true;');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] Auto-deliver: when player near machine/sellpoint, drop off resources');
    lines.push('    // Returns number of items delivered');
    lines.push('    int TryDeliver(GameObject target, string expectedType, float range)');
    lines.push('    {');
    lines.push('        if (target == null || !IsNear(target, range)) return 0;');
    lines.push('        if (carrying <= 0 || carryingType != expectedType) return 0;');
    lines.push('        int delivered = carrying;');
    lines.push('        carrying = 0;');
    lines.push('        carryingType = "";');
    lines.push('        return delivered;');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] Show carry stack on player back (visual feedback)');
    lines.push('    GameObject[] carryVisuals;');
    lines.push('    void UpdateCarryVisuals(Color resColor)');
    lines.push('    {');
    lines.push('        if (carryVisuals == null)');
    lines.push('        {');
    lines.push('            carryVisuals = new GameObject[10];');
    lines.push('            for (int i = 0; i < 10; i++)');
    lines.push('            {');
    lines.push('                carryVisuals[i] = GFM_Create.Obj(PrimitiveType.Cube, Vector3.zero, new Vector3(0.3f,0.3f,0.3f), "carry_" + i);');
    lines.push('                if (carryVisuals[i] != null) GFM_Create.SetColor(carryVisuals[i], resColor);');
    lines.push('                HideObj(carryVisuals[i]);');
    lines.push('            }');
    lines.push('        }');
    lines.push('        for (int i = 0; i < carryVisuals.Length; i++)');
    lines.push('        {');
    lines.push('            if (i < carrying && player != null)');
    lines.push('            {');
    lines.push('                Vector3 p = player.transform.position + new Vector3(0, 1f + i * 0.35f, -0.3f);');
    lines.push('                PlaceObj(carryVisuals[i], p.x, p.y, p.z);');
    lines.push('            }');
    lines.push('            else HideObj(carryVisuals[i]);');
    lines.push('        }');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] Gold UI update helper');
    lines.push('    void AddGold(int amount)');
    lines.push('    {');
    lines.push('        gold += amount;');
    lines.push('        if (scoreText != null) scoreText.text = "💰 " + gold;');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] Show floating text (+3 gold) effect');
    lines.push('    void ShowFloatingText(Vector3 worldPos, string text, Color color)');
    lines.push('    {');
    lines.push('        if (mainCam == null) return;');
    lines.push('        // Create temporary UI text that fades');
    lines.push('        Text ft = GFM_UI.CreateText(uiCanvas, text, Vector2.zero, 24);');
    lines.push('        if (ft != null) { ft.color = color; Destroy(ft.gameObject, 1.5f); }');
    lines.push('    }');
    lines.push('');
    lines.push('    // ========== END IDLE GAME KIT ==========');
    lines.push('');
  }

  // TODO: AI declares additional variables
  lines.push('    // === TODO: AI declares pools, counters, and game-specific variables below ===');
  lines.push('    // TODO_VARIABLES_START');
  lines.push('');
  lines.push('    // TODO_VARIABLES_END');
  lines.push('');

  // Start method — pre-populated with Find() calls and initialization
  lines.push('    void Start()');
  lines.push('    {');
  lines.push('        // [SKELETON] Initialize phase tracking');
  lines.push(`        ruleTriggered = new bool[RULE_COUNT];`);
  lines.push(`        completedPhases = new string[RULE_COUNT + 5];`);
  lines.push(`        phaseEnterTimes = new float[RULE_COUNT];`);
  lines.push('');

  // [SKELETON] Pre-generated initialization
  lines.push('        // [SKELETON] Material and pool initialization');
  lines.push('        GFM_Create.InitMaterialFromScene();');
  // ResetPool removed — using pre-colored pool objects
  lines.push('');

  // [SKELETON] Pre-generated Find() calls
  if (entityNames.length > 0) {
    lines.push('        // [SKELETON] Find all scene objects');
    entityNames.forEach(name => {
      lines.push(`        ${name} = GameObject.Find("${entityPoolMap[name]}");`);
    });
    lines.push('');
  }

  // [SKELETON] Add world labels to all entities — VLM can read these in screenshots
  if (entityNames.length > 0) {
    lines.push('        // [SKELETON] World labels for PlayableAgent VLM identification');
    entityNames.forEach(name => {
      // Convert camelCase entity name to readable Chinese-friendly label
      // e.g., "WaterMachine" → "WaterMachine", "Player" → "Player"
      lines.push(`        if (${name} != null) GFM_UI.AddWorldLabel(${name}, "${name}", 1.5f);`);
    });
    lines.push('');
  }

  // [SKELETON] Ground color and camera background
  const groundEntity = entityNames.find(n => n.toLowerCase().indexOf('ground') >= 0 || n.toLowerCase().indexOf('field') >= 0);
  if (groundEntity) {
    lines.push('        // [SKELETON] Anti-solid-color: ground and camera colors');
    // Ground color is pre-baked in Unity template, no SetColor needed
  } else {
    lines.push('        // [SKELETON] Anti-solid-color: camera background');
  }
  lines.push(`        // [SKELETON] Cache Camera.main — NEVER use Camera.main directly, always use mainCam`);
  lines.push(`        mainCam = Camera.main;`);
  lines.push(`        if (mainCam != null) mainCam.backgroundColor = new Color(${CAMERA_BG.r}f, ${CAMERA_BG.g}f, ${CAMERA_BG.b}f);`);
  lines.push('');

  // [SKELETON] GFM_Luna.Init for iOS audio
  lines.push('        // [SKELETON] Luna platform init (iOS audio pre-play)');
  lines.push('        GFM_Luna.Init(gameObject);');
  lines.push('');

  // [SKELETON] Pre-create Canvas and UI text
  lines.push('        // [SKELETON] Create Canvas and UI text — use uiCanvas/guideText/scoreText directly');
  lines.push('        uiCanvas = GFM_UI.CreateCanvas(960, 640);');
  lines.push('        guideText = GFM_UI.CreateText(uiCanvas, "", new Vector2(0, 270), 26);');
  lines.push('        scoreText = GFM_UI.CreateText(uiCanvas, "Score: 0", new Vector2(340, 290), 20);');
  lines.push('');

  if (isIdleGame) {
    lines.push('        // [SKELETON] Idle game initialization — joystick + isometric camera');
    lines.push('        joystick = GFM_Joystick.Create(uiCanvas, 180f);');
    lines.push('        if (mainCam != null)');
    lines.push('        {');
    lines.push('            mainCam.orthographic = true;');
    lines.push('            mainCam.orthographicSize = 8f;');
    lines.push('            mainCam.transform.position = new Vector3(0, 12f, -8f);');
    lines.push('            mainCam.transform.rotation = Quaternion.Euler(50f, 0f, 0f);');
    lines.push('        }');
    lines.push('');
  }
  lines.push('        // === TODO: AI fills — create game objects, setup scene layout, etc. ===');
  lines.push('        // IMPORTANT: Do NOT create Canvas again (use uiCanvas). Do NOT use Camera.main (use mainCam).');
  if (isIdleGame) {
    lines.push('        // IMPORTANT for idle games: Use the pre-built MovePlayer(), TryCollect(), TryDeliver() in Update.');
    lines.push('        //   player = GFM_Create.Obj(PrimitiveType.Capsule, new Vector3(0,0.75f,0), new Vector3(0.8f,0.8f,0.8f), "Player");');
    lines.push('        //   Then in Update: MovePlayer(); TryCollect(iceSource, "ice", 5, 1.5f); TryDeliver(machine, "ice", 1.5f);');
  }
  lines.push('        // TODO_START_START');
  lines.push('');
  lines.push('        // TODO_START_END');
  lines.push('');
  lines.push('        UpdateGameState();');
  lines.push('    }');
  lines.push('');

  // Update method
  lines.push('    void Update()');
  lines.push('    {');
  lines.push('        if (gameEnded) return;');
  lines.push('');
  lines.push('        float dt = Time.deltaTime;');
  lines.push('        gameTimer += dt;');
  lines.push('');
  lines.push('        // [SKELETON] Phase timer update');
  lines.push('        if (currentPhaseName != lastPhaseForTimer) {');
  lines.push('            phaseTimer = 0f;');
  lines.push('            lastPhaseForTimer = currentPhaseName;');
  lines.push('        }');
  lines.push('        phaseTimer += dt;');
  lines.push('');
  lines.push('        CheckEventRules();');
  lines.push('');
  if (isIdleGame) {
    lines.push('        // [SKELETON] Idle game core loop — always run these');
    lines.push('        MovePlayer();');
    lines.push('');
  }
  lines.push('        // === TODO: AI fills — update systems: resource collection, delivery, production, etc. ===');
  if (isIdleGame) {
    lines.push('        // Use TryCollect/TryDeliver for resource flow. Example:');
    lines.push('        // if (TryCollect(iceSource, "ice", 5, 1.5f)) { /* picked up ice */ }');
    lines.push('        // int delivered = TryDeliver(waterMachine, "ice", 1.5f);');
    lines.push('        // if (delivered > 0) { waterMachineState = 1; /* machine producing */ }');
    lines.push('        // UpdateCarryVisuals(Color.cyan); // show stack on player back');
  }
  lines.push('        // TODO_UPDATE_START');
  lines.push('');
  lines.push('        // TODO_UPDATE_END');
  lines.push('    }');
  lines.push('');

  // CheckEventRules — the core skeleton
  lines.push('    void CheckEventRules()');
  lines.push('    {');

  // Pick first 3 non-ground entities for anti-solid-color placement in phase 1
  const visibleEntities = entityNames.filter(n => {
    const lower = n.toLowerCase();
    return lower.indexOf('ground') < 0 && lower.indexOf('field') < 0
      && lower.indexOf('spawner') < 0 && lower.indexOf('ui') < 0
      && lower.indexOf('cta') < 0 && lower.indexOf('hint') < 0;
  }).slice(0, 3);

  specs.forEach((spec, i) => {
    const ruleIdx = i;
    const isLast = i === specs.length - 1;

    lines.push(`        // ========== Phase ${i + 1}: ${spec.phaseName} (${spec.phaseId}) ==========`);
    lines.push(`        // Duration: ${spec.duration.min}-${spec.duration.max}s`);
    lines.push(`        // Interactions: ${(spec.requiredInteractions || []).join(', ') || 'none'}`);
    lines.push(`        // Player must act: ${spec.playerMustAct}`);

    if (i === 0) {
      // First rule: game start
      lines.push(`        if (!ruleTriggered[${ruleIdx}])`);
      lines.push('        {');
      lines.push(`            ruleTriggered[${ruleIdx}] = true;`);
      lines.push(`            currentPhaseName = "${spec.phaseId}";`);
      lines.push(`            phaseEnterTimes[${ruleIdx}] = gameTimer; // [SKELETON]`);
      lines.push('');

      // [SKELETON] Anti-solid-color: place first 3 entities in phase 1
      if (visibleEntities.length > 0) {
        lines.push('            // [SKELETON] Anti-solid-color: show initial objects');
        visibleEntities.forEach((eName, vi) => {
          const color = ENTITY_COLORS[vi % ENTITY_COLORS.length];
          const xPos = (vi - 1) * 3; // spread: -3, 0, 3
          lines.push(`            PlaceObj(${eName}, ${xPos}f, 0.5f, 0f);`);
          lines.push(`            SetScale(${eName}, 2f, 2f, 2f);`);
          lines.push(`            GFM_Create.SetColor(${eName}, new Color(${color.r}f, ${color.g}f, ${color.b}f)); // ${color.label}`);
        });
        lines.push('');
      }

      lines.push(`            // === TODO: AI fills — place additional objects, set colors, show guide ===`);
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_START`);
      lines.push('');
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_END`);
      lines.push('');
      lines.push('            AddCompletedPhase("gameStart");');
      lines.push('            UpdateGameState();');
      lines.push('        }');
    } else {
      // Subsequent rules: require previous phase condition + minimum dwell time
      const prevSpec = specs[i - 1];
      const conditionHint = prevSpec.triggerNext && prevSpec.triggerNext.condition
        ? prevSpec.triggerNext.condition
        : 'previous phase complete';

      lines.push(`        // [SKELETON] Transition from ${prevSpec.phaseId} → ${spec.phaseId}`);
      lines.push(`        // Requires: ${prevSpec.triggerNext ? prevSpec.triggerNext.description : 'previous phase complete'}`);
      lines.push(`        // Condition hint: ${conditionHint}`);
      lines.push(`        if (!ruleTriggered[${ruleIdx}]`);
      lines.push(`            && true /* TODO: AI replaces with real C# condition for: ${conditionHint} */`);
      lines.push(`            && phaseTimer >= ${prevSpec.duration.min}f) // [SKELETON] min dwell time`);
      lines.push('        {');
      lines.push(`            ruleTriggered[${ruleIdx}] = true;`);
      lines.push(`            currentPhaseName = "${spec.phaseId}";`);
      lines.push(`            phaseEnterTimes[${ruleIdx}] = gameTimer; // [SKELETON]`);
      lines.push('');
      lines.push(`            // === TODO: AI fills — activate objects for ${spec.phaseName} ===`);
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_START`);
      lines.push('');
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_END`);
      lines.push('');
      lines.push(`            AddCompletedPhase("${prevSpec.phaseId}");`);
      lines.push('            UpdateGameState();');
      lines.push('        }');
    }
    lines.push('');
  });

  // Final rule: game end
  const lastSpec = specs[specs.length - 1];
  lines.push(`        // ========== Game End ==========`);
  const endConditionHint = lastSpec.triggerNext ? lastSpec.triggerNext.condition : 'game end condition';
  lines.push(`        // End condition hint: ${endConditionHint}`);
  lines.push(`        if (!ruleTriggered[${specs.length}]`);
  lines.push(`            && true /* TODO: AI replaces with real C# condition for game end: ${endConditionHint} */`);
  lines.push(`            && phaseTimer >= ${lastSpec.duration.min}f) // [SKELETON]`);
  lines.push('        {');
  lines.push(`            ruleTriggered[${specs.length}] = true;`);
  lines.push('            currentPhaseName = "gameEnd";');
  lines.push('            gameEnded = true;');
  lines.push('');

  // Verify all entities reached terminal state
  if (allEntities.size > 0) {
    lines.push('            // [SKELETON] Verify all entities reached terminal state');
    allEntities.forEach(name => {
      lines.push(`            // Assert: ${name}State should be 2 at game end`);
    });
  }

  lines.push('');
  lines.push(`            AddCompletedPhase("${lastSpec.phaseId}");`);
  lines.push('            AddCompletedPhase("gameEnd");');
  lines.push('            ShowCTA();');
  lines.push('            UpdateGameState();');
  lines.push('            Luna.Unity.LifeCycle.GameEnded();');
  lines.push('        }');
  lines.push('    }');
  lines.push('');

  // Helper methods (skeleton)
  lines.push('    // === TODO: AI fills — game systems (UpdatePlayer, UpdateEnemies, etc.) ===');
  lines.push('    // TODO_SYSTEMS_START');
  lines.push('');
  lines.push('    // TODO_SYSTEMS_END');
  lines.push('');

  // Standard helpers
  lines.push('    // ========== SKELETON HELPERS (do not modify) ==========');
  lines.push('');
  lines.push('    void AddCompletedPhase(string phaseName)');
  lines.push('    {');
  lines.push('        if (completedPhaseCount < completedPhases.Length)');
  lines.push('        {');
  lines.push('            completedPhases[completedPhaseCount] = phaseName;');
  lines.push('            completedPhaseCount++;');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    void PlaceObj(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.transform.position = new Vector3(x, y, z);');
  lines.push('    }');
  lines.push('');
  lines.push('    void HideObj(GameObject obj)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.transform.position = new Vector3(0f, -999f, 0f);');
  lines.push('    }');
  lines.push('');
  lines.push('    void SetScale(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.transform.localScale = new Vector3(x, y, z);');
  lines.push('    }');
  lines.push('');

  // [SKELETON] Pre-generated ShowCTA with InstallFullGame
  lines.push('    // [SKELETON] CTA button — pre-generated, do not remove');
  lines.push('    void ShowCTA()');
  lines.push('    {');
  lines.push('        Luna.Unity.LifeCycle.GameEnded();');
  lines.push('        Luna.Unity.Playable.InstallFullGame();');
  lines.push('    }');
  lines.push('');

  // UpdateGameState with phaseTimestamps
  lines.push('    void UpdateGameState()');
  lines.push('    {');
  lines.push('        // [SKELETON] Expose game state for CUA verification');
  lines.push('        string completedJson = "[";');
  lines.push('        for (int i = 0; i < completedPhaseCount; i++)');
  lines.push('        {');
  lines.push('            if (i > 0) completedJson += ",";');
  lines.push('            completedJson += "\\"" + completedPhases[i] + "\\"";');
  lines.push('        }');
  lines.push('        completedJson += "]";');
  lines.push('');
  lines.push('        string json = "{"');

  // Build entity states JSON
  lines.push('            + "\\"currentPhase\\":\\"" + currentPhaseName + "\\","');
  lines.push('            + "\\"completedPhases\\":" + completedJson + ","');

  // Entity states
  lines.push('            + "\\"entityStates\\":{"');
  const entityList = Array.from(allEntities);
  entityList.forEach((name, i) => {
    const comma = i < entityList.length - 1 ? ',' : '';
    lines.push(`            + "\\"${name}\\":\\"" + ${name}State + "\\"${comma}"`);
  });
  lines.push('            + "},"');

  // Variables (AI fills)
  lines.push('            + "\\"variables\\":{"');
  lines.push('            + "\\"gameTimer\\":" + (int)gameTimer');
  lines.push('            // TODO: AI adds game-specific variables here (gold, wood, ammo, etc.)');
  lines.push('            + "}"');

  // Phase timestamps
  lines.push('            + ",\\"phaseTimestamps\\":{"');
  specs.forEach((spec, i) => {
    const comma = i < specs.length - 1 ? ',' : '';
    lines.push(`            + "\\"${spec.phaseId}\\":" + (phaseEnterTimes[${i}] > 0 ? (int)phaseEnterTimes[${i}] : 0) + "${comma}"`);
  });
  lines.push('            + "}"');

  lines.push('            + "}";');
  lines.push('');
  lines.push('        // [SKELETON] Expose game state to JavaScript for CUA verification');
  lines.push('        // Luna bridge exposes C# strings to JS via gameObject.name trick');
  lines.push('        gameObject.name = "GFM|" + json;');
  lines.push('    }');
  lines.push('');

  // TODO: AI fills remaining UI methods
  lines.push('    // === TODO: AI fills — ShowGuide, UI helpers, input handlers ===');
  lines.push('    // TODO_UI_START');
  lines.push('');
  lines.push('    // TODO_UI_END');
  lines.push('}');

  return lines.join('\n');
}

/**
 * Save skeleton to file
 */
function saveSkeleton(skeleton, outputPath) {
  fs.writeFileSync(outputPath, skeleton, 'utf8');
  console.log(`[SkeletonGenerator] Skeleton saved to ${outputPath} (${(skeleton.length / 1024).toFixed(1)} KB)`);
}

module.exports = { generateSkeleton, saveSkeleton };
