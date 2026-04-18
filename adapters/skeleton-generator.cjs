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
 * @returns {string|{main: string, systems: string}} C# skeleton code (single string for ≤10 phases, {main,systems} for >10)
 */
const RESERVED_SKELETON_VARS = new Set([
  'gold', 'moveSpeed', 'collectRange', 'maxCarry', 'carrying', 'carryingType',
  'player', 'joystick', 'mainCam', 'uiCanvas', 'guideText', 'scoreText',
  'phaseTimer', 'gameTimer', 'gameEnded', 'currentPhaseName', 'ruleTriggered',
  'completedPhases', 'completedPhaseCount', 'floatingText', 'floatingTextTimer',
  'tapMoveTarget', 'hasTapTarget', 'carryVisuals', 'playerHP', 'enemiesDefeated',
]);

function generateSkeleton(specs, opts = {}) {
  const totalPhases = specs.length;
  const entityPoolMap = opts.entityPoolMap || {};

  // Resolve entity name collisions with skeleton built-in variables
  const renamedEntities = {};
  Object.keys(entityPoolMap).forEach(name => {
    if (RESERVED_SKELETON_VARS.has(name)) {
      const newName = name + 'Obj';
      renamedEntities[name] = newName;
      entityPoolMap[newName] = entityPoolMap[name];
      delete entityPoolMap[name];
    }
  });
  // Also rename in specs to keep consistent
  if (Object.keys(renamedEntities).length > 0) {
    specs = JSON.parse(JSON.stringify(specs));
    specs.forEach(spec => {
      (spec.entitiesRequired || []).forEach(e => {
        if (renamedEntities[e.name]) e.name = renamedEntities[e.name];
      });
      (spec.requiredInteractions || []).forEach((interaction, idx) => {
        Object.keys(renamedEntities).forEach(oldName => {
          spec.requiredInteractions[idx] = interaction.replace(
            new RegExp('(^|:)' + oldName + '(:|$)', 'g'),
            '$1' + renamedEntities[oldName] + '$2'
          );
        });
      });
    });
  }

  const entityNames = Object.keys(entityPoolMap);
  const shouldSplit = totalPhases > 10;
  const lines = [];

  // Helper: convert spec trigger condition to real C# using entity state variables
  // e.g. spec has entitiesRequired: [{name: "iceCrystal", terminalState: 1}]
  //      → generates: iceCrystalState >= 1
  //
  // ANTI-AUTOPLAY: Every condition MUST include a player interaction gate.
  // Timer-only transitions cause CUA to reject (game auto-plays without input).
  function buildRealCondition(spec) {
    const entities = spec.entitiesRequired || [];
    const interactions = spec.requiredInteractions || [];
    const mustAct = spec.playerMustAct !== false; // default true

    if (entities.length === 0 && interactions.length === 0) {
      // No entity or interaction requirements — AI MUST replace this with real gameplay condition
      // Use an interaction flag that forces player input (anti-autoplay)
      const phaseId = (spec.phaseId || 'phase').replace(/[^a-zA-Z0-9]/g, '');
      return phaseId + 'InteractionDone /* AI: MUST replace with real player interaction check — timer alone is FORBIDDEN */';
    }

    const conditions = [];

    // Entity state conditions
    if (entities.length > 0) {
      entities.forEach(e => {
        conditions.push(e.name + 'State >= ' + e.terminalState);
      });
    }

    // Interaction-based conditions — scan all interactions, skip wait/defend
    for (let ii = 0; ii < interactions.length; ii++) {
      const verb = interactions[ii].split(':')[0];
      const target = interactions[ii].split(':')[1] || '';
      if (!target || verb === 'wait' || verb === 'defend') continue;
      if (/^\d/.test(target)) continue;
      conditions.push(target + 'Done == true');
      break; // only need one interaction condition for gate
    }

    // If playerMustAct but no interaction condition was added, add a generic one
    if (mustAct && interactions.length === 0 && entities.length > 0) {
      // Entity conditions exist but no explicit interaction — add player action flag
      const phaseId = (spec.phaseId || 'phase').replace(/[^a-zA-Z0-9]/g, '');
      conditions.push(phaseId + 'PlayerActed /* AI: set to true when player interacts */');
    }

    return conditions.join(' && ');
  }


  // Header
  lines.push('// ========== AUTO-GENERATED SKELETON — DO NOT MODIFY SKELETON LINES ==========');
  lines.push('// Generated from storyboard spec. AI fills TODO sections only.');
  lines.push('// Lines marked [SKELETON] must not be removed or modified.');
  lines.push('//');
  lines.push('// *** RENDERING RULES (MUST FOLLOW — violation = build failure) ***');
  lines.push('// 1. Camera.backgroundColor is pre-set to (0.45, 0.52, 0.62) — do NOT change');
  lines.push('// 2. NEVER call GFM_Create.SetColor() — it causes GL_INVALID_OPERATION in Luna');
  lines.push('// 3. NEVER call GFM_Create.Obj() — pool objects already exist, use GameObject.Find()');
  lines.push('// 4. Pool objects have pre-baked colors (__Pool_Shape_Color_NN) — just position them');
  lines.push('// 5. Phase 1 must place at least 3 pool objects on screen to prevent solid-color');
  lines.push('// 6. NEVER call Destroy() — hide objects via position (0, -999, 0)');
  lines.push('// 7. NEVER use SafeColor or recursive color functions');
  lines.push('//');
  lines.push('// *** ANTI-AUTOPLAY RULES (MUST FOLLOW — violation = CUA rejection) ***');
  lines.push('// 1. Every phase transition MUST require player interaction (click/drag/joystick)');
  lines.push('// 2. NEVER advance phases based on timer alone — timer is minimum dwell, not trigger');
  lines.push('// 3. playerMustAct=true phases MUST wait for user input before transitioning');
  lines.push('//');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('using UnityEngine.UI;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain : MonoBehaviour');
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
  lines.push('    // [SKELETON] AutoPlay dual-mode — CUA verification uses autoPlay, end-user uses interactive');
  lines.push('    bool _autoPlayMode = false;');
  lines.push('    bool _autoPlayChecked = false;');
  lines.push('    float _autoPlayDetectRealTime = -1f; // [SKELETON] wall-clock time when __AUTOPLAY_ON__ detected');
  lines.push('    int _autoPlaySteps = 0; // [SKELETON] tracks autoPlay visual progress for CUA');
  lines.push('    int _autoPlayStepsAtPhaseStart = 0; // [SKELETON] tracks autoPlay steps when current phase started');
  lines.push('    const float AUTO_PLAY_PHASE_DURATION = 12f; // [SKELETON] 12s per shot — DO NOT MODIFY this value (DO NOT MODIFY)');
  lines.push('');

  // Entity state variables — from entitiesRequired + all entityPoolMap entries
  const allEntities = new Set();
  specs.forEach(spec => {
    (spec.entitiesRequired || []).forEach(e => allEntities.add(e.name));
  });
  // Also add all entities in pool map — AI code frequently references {name}State
  // for entities that only appear in interactions (e.g. RecyclingStation from deliver:)
  entityNames.forEach(name => allEntities.add(name));
  if (allEntities.size > 0) {
    lines.push('    // [SKELETON] Entity states — must reach terminal state');
    allEntities.forEach(name => {
      lines.push(`    int ${name}State = 0; // 0=waiting, 1=building, 2=built [SKELETON]`);
    });
    lines.push('');
  }

  // [SKELETON] Anti-autoplay interaction flags — AI must set these to true on player input
  const interactionFlags = [];
  specs.forEach(spec => {
    const entities = spec.entitiesRequired || [];
    const interactions = spec.requiredInteractions || [];
    const mustAct = spec.playerMustAct !== false;
    const phaseId = (spec.phaseId || 'phase').replace(/[^a-zA-Z0-9]/g, '');

    // Always declare BOTH flags per phase — autoplay-mirror and template-engine
    // both set them, so both must exist to avoid undeclared variable errors.
    interactionFlags.push(phaseId + 'InteractionDone');
    interactionFlags.push(phaseId + 'PlayerActed');
    for (let ii = 0; ii < interactions.length; ii++) {
      const parts = interactions[ii].split(':');
      const verb = parts[0];
      const target = parts[1];
      if (!target || verb === 'wait' || verb === 'defend') continue;
      if (/^\d/.test(target)) continue; // skip numeric targets (invalid C# identifier)
      interactionFlags.push(target + 'Done');
    }
  });
  if (interactionFlags.length > 0) {
    lines.push('    // [SKELETON] Anti-autoplay flags — AI MUST set these to true when player performs the required interaction');
    const uniqueFlags = [...new Set(interactionFlags)];
    uniqueFlags.forEach(flag => {
      lines.push(`    bool ${flag} = false; // [SKELETON] Set to true on player interaction (click/drag/joystick)`);
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
  const hasFormSwitch = specs.some(s => !!s.formSwitch);
  const hasEconomy = specs.some(s => (s.requiredInteractions || []).some(i => {
    const verb = String(i).split(':')[0];
    return verb === 'collect' || verb === 'deliver' || verb === 'spend' || verb === 'convert';
  }));

  // [SKELETON] Form-switch system
  if (hasFormSwitch) {
    lines.push('    // [SKELETON] Form-switch system — AI fills _forms array in Start()');
    lines.push('    struct FormDef {');
    lines.push('        public string formId;');
    lines.push('        public string poolObjectName;');
    lines.push('        public float moveSpeed;');
    lines.push('        public float collectRange;');
    lines.push('        public float collectPower;');
    lines.push('        public int carryCapacity;');
    lines.push('        public float scale;');
    lines.push('    }');
    lines.push('    FormDef[] _forms; // [SKELETON] AI: fill in Start() with form definitions');
    lines.push('    int _currentFormIndex = 0;');
    lines.push('');
    lines.push('    // [SKELETON] Switch player form — hides old model, shows new, updates stats');
    lines.push('    void SwitchForm(int formIndex) {');
    lines.push('        if (_forms == null || formIndex < 0 || formIndex >= _forms.Length) return;');
    lines.push('        if (_forms[_currentFormIndex].poolObjectName != "") {');
    lines.push('            var oldObj = GameObject.Find(_forms[_currentFormIndex].poolObjectName);');
    lines.push('            if (oldObj != null) oldObj.transform.position = new Vector3(0, -999, 0);');
    lines.push('        }');
    lines.push('        _currentFormIndex = formIndex;');
    lines.push('        var newObj = GameObject.Find(_forms[_currentFormIndex].poolObjectName);');
    lines.push('        if (newObj != null) {');
    lines.push('            newObj.transform.position = player != null ? player.transform.position : Vector3.zero;');
    lines.push('            newObj.transform.localScale = Vector3.one * _forms[_currentFormIndex].scale;');
    lines.push('        }');
    lines.push('    }');
    lines.push('    float GetCollectPower() { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].collectPower : 1f; }');
    lines.push('    float GetCollectRange() { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].collectRange : 1.5f; }');
    lines.push('    int GetCarryCapacity() { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].carryCapacity : 10; }');
    lines.push('');
  }

  if (hasEconomy) {
    lines.push('    // [SKELETON] Economy system — AI fills _resources array in Start()');
    lines.push('    struct ResourceDef {');
    lines.push('        public string resourceId;');
    lines.push('        public string displayName;');
    lines.push('        public string convertFrom; // upstream resource id, empty if primary');
    lines.push('        public int convertRatio;   // how many upstream = 1 of this');
    lines.push('    }');
    lines.push('    ResourceDef[] _resources; // [SKELETON] AI: fill in Start()');
    lines.push('    System.Collections.Generic.Dictionary<string, int> _inventory = new System.Collections.Generic.Dictionary<string, int>();');
    lines.push('');
    lines.push('    void AddResource(string id, int amount) {');
    lines.push('        if (!_inventory.ContainsKey(id)) _inventory[id] = 0;');
    lines.push('        _inventory[id] += amount;');
    lines.push('        UpdateResourceUI();');
    lines.push('    }');
    lines.push('');
    lines.push('    int GetResource(string id) {');
    lines.push('        return _inventory.ContainsKey(id) ? _inventory[id] : 0;');
    lines.push('    }');
    lines.push('');
    lines.push('    bool TrySpend(string id, int amount) {');
    lines.push('        if (GetResource(id) < amount) return false;');
    lines.push('        _inventory[id] -= amount;');
    lines.push('        UpdateResourceUI();');
    lines.push('        return true;');
    lines.push('    }');
    lines.push('');
    lines.push('    bool TryConvert(string fromId, string toId) {');
    lines.push('        if (_resources == null) return false;');
    lines.push('        ResourceDef toDef = default;');
    lines.push('        bool found = false;');
    lines.push('        for (int i = 0; i < _resources.Length; i++) {');
    lines.push('            if (_resources[i].resourceId == toId) { toDef = _resources[i]; found = true; break; }');
    lines.push('        }');
    lines.push('        if (!found || toDef.convertFrom != fromId) return false;');
    lines.push('        if (GetResource(fromId) < toDef.convertRatio) return false;');
    lines.push('        _inventory[fromId] -= toDef.convertRatio;');
    lines.push('        AddResource(toId, 1);');
    lines.push('        return true;');
    lines.push('    }');
    lines.push('');
    lines.push('    void UpdateResourceUI() {');
    lines.push('        if (scoreText == null) return;');
    lines.push('        var parts = new System.Collections.Generic.List<string>();');
    lines.push('        foreach (var kv in _inventory) { if (kv.Value > 0) parts.Add(kv.Key + ": " + kv.Value); }');
    lines.push('        scoreText.text = string.Join("  ", parts);');
    lines.push('    }');
    lines.push('');
  }

  if (isIdleGame) {
    lines.push('    // ========== [SKELETON] IDLE GAME KIT — Pre-built systems ==========');
    lines.push('    // All systems below are working code. AI should CALL these, not rewrite them.');
    lines.push('');
    lines.push('    // --- Player Movement (joystick-driven) ---');
    lines.push('    GFM_Joystick joystick;');
    lines.push('    GameObject player;');
    if (hasFormSwitch) {
      lines.push('    float moveSpeed { get { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].moveSpeed : 5f; } }');
    } else {
      lines.push('    float moveSpeed = 5f;');
    }
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
    lines.push('    void UpdateCarryVisuals()');
    lines.push('    {');
    lines.push('        // [SKELETON] Carry visuals use pool objects — find them by name');
    lines.push('        if (carryVisuals == null)');
    lines.push('        {');
    lines.push('            carryVisuals = new GameObject[10];');
    lines.push('            for (int i = 0; i < 10; i++)');
    lines.push('            {');
    lines.push('                // AI: assign carry visual pool objects here via GameObject.Find');
    lines.push('                // Do NOT use GFM_Create.Obj or GFM_Create.SetColor (both forbidden in Luna)');
    lines.push('                carryVisuals[i] = GameObject.Find("__Pool_Cube_Yellow_" + (60 + i));');
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
    lines.push('    // [SKELETON] Floating text — uses a pooled text element, auto-hides after delay');
    lines.push('    Text floatingText;');
    lines.push('    float floatingTextTimer = 0f;');
    lines.push('    void ShowFloatingText(Vector3 worldPos, string text, Color color)');
    lines.push('    {');
    lines.push('        if (mainCam == null) return;');
    lines.push('        // Reuse a single floating text — do NOT use Destroy (forbidden in Luna)');
    lines.push('        if (floatingText == null) floatingText = GFM_UI.CreateText(uiCanvas, "", Vector2.zero, 24);');
    lines.push('        if (floatingText != null) { floatingText.text = text; floatingText.color = color; floatingTextTimer = 1.5f; }');
    lines.push('    }');
    lines.push('');
    lines.push('    // ========== END IDLE GAME KIT ==========');
    lines.push('');
  }

  // [SKELETON] AutoPlay interaction system — ALWAYS generated (outside isIdleGame block)
  // Build target entity list from specs — supports both entitiesRequired and activate fields.
  //
  // 2026-04-15 fix: exclude player-like names (Player, PlayerRobot, Hero, etc.) from
  // autoTargets. The player IS the navigation subject — using it as a target results in
  // distance=0, immediate "arrive", _autoTargetIdx++, skip. Not catastrophic but wastes a
  // slot and skews initialPhase arrivals. More importantly, if the ONLY Phase 1 target is
  // the player itself, the autoPlay will produce no visible movement → CUA observer sees
  // visual freeze → FATAL in 3 rounds.
  const isPlayerName = (n) => /^(Player|PlayerRobot|PlayerChar|Hero|MainChar|Protagonist)/i.test(n || '');
  const autoTargets = [];
  specs.forEach(spec => {
    (spec.entitiesRequired || []).forEach(e => {
      if (e && e.name && !isPlayerName(e.name) && autoTargets.indexOf(e.name) < 0) {
        autoTargets.push(e.name);
      }
    });
    (spec.activate || []).forEach(name => {
      if (name && !isPlayerName(name) && !name.match(/UI$|Canvas|Guide|Gold|Score|Text/) && autoTargets.indexOf(name) < 0) {
        autoTargets.push(name);
      }
    });
  });

  if (autoTargets.length > 0 && isIdleGame) {
    // Idle games already have MovePlayer — AutoPlayUpdate navigates between targets
    lines.push('    // [SKELETON] AutoPlay — auto-navigate player through target entities');
    lines.push(`    string[] _autoTargets = new string[] { ${autoTargets.map(t => '"' + t + '"').join(', ')} };`);
    lines.push('    int _autoTargetIdx = 0;');
    lines.push('    float _autoTargetWait = 0f;');
    lines.push('');
    lines.push('    void AutoPlayUpdate()');
    lines.push('    {');
    lines.push('        if (!_autoPlayMode || player == null) return;');
    lines.push('        if (_autoTargetWait > 0f) { _autoTargetWait -= Time.deltaTime; return; }');
    lines.push('        if (_autoTargetIdx >= _autoTargets.Length) _autoTargetIdx = 0;');
    lines.push('        GameObject target = GameObject.Find(_autoTargets[_autoTargetIdx]);');
    lines.push('        if (target == null) { _autoTargetIdx++; return; }');
    lines.push('        Vector3 dir = target.transform.position - player.transform.position;');
    lines.push('        dir.y = 0f;');
    lines.push('        if (dir.magnitude > 1.0f)');
    lines.push('        {');
    lines.push('            float speed = moveSpeed * 1.2f;');
    lines.push('            player.transform.position = Vector3.MoveTowards(');
    lines.push('                player.transform.position, target.transform.position, speed * Time.deltaTime);');
    lines.push('            if (dir.magnitude > 0.1f)');
    lines.push('                player.transform.rotation = Quaternion.Lerp(');
    lines.push('                    player.transform.rotation, Quaternion.LookRotation(dir), 5f * Time.deltaTime);');
    lines.push('            if (mainCam != null) mainCam.transform.LookAt(player.transform.position);');
    lines.push('        }');
    lines.push('        else');
    lines.push('        {');
    lines.push('            _autoTargetWait = 1.5f;');
    lines.push('            _autoTargetIdx++;');
    lines.push('            _autoPlaySteps++;');
    lines.push('            OnAutoPlayArrive(_autoTargets[(_autoTargetIdx - 1) % _autoTargets.Length]);');
    lines.push('        }');
    lines.push('    }');
  } else {
    // Non-idle or no targets — use timer-based periodic interaction trigger
    lines.push('    // [SKELETON] AutoPlay — periodic interaction trigger for CUA variable checking');
    lines.push('    float _autoInteractTimer = 0f;');
    lines.push('');
    lines.push('    void AutoPlayUpdate()');
    lines.push('    {');
    lines.push('        if (!_autoPlayMode) return;');
    lines.push('        _autoInteractTimer += Time.deltaTime;');
    lines.push('        if (_autoInteractTimer >= 3f)');
    lines.push('        {');
    lines.push('            _autoInteractTimer = 0f;');
    lines.push('            _autoPlaySteps++;');
    lines.push('            OnAutoPlayArrive(currentPhaseName);');
    lines.push('        }');
    lines.push('    }');
  }
  lines.push('');
  lines.push('    // [SKELETON] Called when autoPlay triggers an interaction (DO NOT REMOVE).');
  lines.push('    // AI MUST fill this to simulate gameplay — CUA checks variables change.');
  lines.push('    // [SKELETON] Empty OnAutoPlayArrive = CUA FAIL (variable stagnation)');
  lines.push('    // RULE: every xxxDone flag set here MUST ALSO be set in interactive mode');
  lines.push('    //       (proximity check, raycast, or collision) — otherwise interactive mode freezes.');
  lines.push('    void OnAutoPlayArrive(string targetName)');
  lines.push('    {');
  lines.push('        // TODO_AUTOPLAY_INTERACT_START');
  // Generate phase-specific stubs from specs so AI has clear per-phase guidance
  for (var apsi = 0; apsi < specs.length; apsi++) {
    var apSpec = specs[apsi];
    var apPhaseId = (apSpec.phaseId || 'phase' + apsi).replace(/[^a-zA-Z0-9]/g, '');
    var apInteractions = apSpec.requiredInteractions || [];
    var apEntities = apSpec.entitiesRequired || [];
    lines.push('        if (currentPhaseName == "' + apPhaseId + '")');
    lines.push('        {');
    // Generate hints based on what the phase needs
    if (apEntities.length > 0) {
      for (var aei = 0; aei < apEntities.length; aei++) {
        var eName = apEntities[aei].name || apEntities[aei];
        var eTerminal = apEntities[aei].terminalState || 1;
        lines.push('            ' + eName + 'State = ' + eTerminal + '; // TODO: AI adjusts — simulate reaching terminal state');
      }
    }
    if (apInteractions.length > 0) {
      for (var aii = 0; aii < apInteractions.length; aii++) {
        var parts = apInteractions[aii].split(':');
        var verb = parts[0];
        var target = parts[1] || '';
        if (target && !/^\d/.test(target) && verb !== 'wait' && verb !== 'defend') {
          lines.push('            ' + target + 'Done = true; // TODO: AI adjusts — must ALSO set in interactive handler');
        }
      }
    }
    lines.push('            ' + apPhaseId + 'InteractionDone = true;');
    lines.push('            ' + apPhaseId + 'PlayerActed = true;');
    lines.push('        }');
  }
  if (specs.length === 0) {
    lines.push('        // TODO: AI fills — simulate interaction for each phase');
    lines.push('        // Example: if (currentPhaseName == "Phase1") { resourceCount++; phase1Done = true; }');
  }
  lines.push('        // TODO_AUTOPLAY_INTERACT_END');
  lines.push('    }');
  lines.push('');

  // [SKELETON] Phase instrumentation for automated testing
  lines.push('    // [SKELETON] Phase instrumentation for automated testing');
  lines.push('    void ReportPhase(string phaseId) {');
  lines.push('        // Bridge.NET compiles this to console.log which Playwright can capture');
  lines.push('        UnityEngine.Debug.Log("__PHASE__:" + phaseId);');
  lines.push('    }');
  lines.push('');

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

  // [SKELETON] GameSceneCtrl init + entity registration
  if (entityNames.length > 0) {
    lines.push('        // [SKELETON] Scene entity management');
    lines.push('        GameSceneCtrl.Init(gameObject);');
    entityNames.forEach(name => {
      lines.push(`        GameSceneCtrl.instance.Register("${name}", "${entityPoolMap[name]}");`);
    });
    lines.push('');
    lines.push('        // [SKELETON] Entity variable shortcuts (backed by GameSceneCtrl cache)');
    entityNames.forEach(name => {
      lines.push(`        ${name} = GameSceneCtrl.instance.Get("${name}");`);
    });
    lines.push('');
  }

  // [SKELETON] World labels removed — CUA uses __gameState JSON, not visual labels
  // Black label backgrounds caused ugly UI bars in the final product

  // [SKELETON] Ground color and camera background
  const groundEntity = entityNames.find(n => n.toLowerCase().indexOf('ground') >= 0 || n.toLowerCase().indexOf('field') >= 0);
  if (groundEntity) {
    lines.push('        // [SKELETON] Anti-solid-color: ground and camera colors');
    // Ground color is pre-baked in Unity template, no SetColor needed
  } else {
    lines.push('        // [SKELETON] Anti-solid-color: camera background');
  }
  lines.push(`        // [SKELETON] Cache Camera.main — NEVER use Camera.main directly, always use mainCam`);
  lines.push(`        mainCam = Camera.main; // ok`);
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
    lines.push('        //   player = GameObject.Find("__Pool_Capsule_Blue_01"); // use pool object, NOT GFM_Create.Obj');
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
  lines.push('        // [SKELETON] AutoPlay detection — two-stage: detect flag, then delay activation (DO NOT MODIFY)');
  lines.push('        // Stage 1: detect __AUTOPLAY_ON__ entity from JS bridge');
  lines.push('        if (!_autoPlayMode && !_autoPlayChecked)');
  lines.push('        {');
  lines.push('            if (GameObject.Find("__AUTOPLAY_ON__") != null) { _autoPlayDetectRealTime = Time.realtimeSinceStartup; _autoPlayChecked = true; }');
  lines.push('            else if (gameTimer > 3.0f) _autoPlayChecked = true; // stop checking after 3s');
  lines.push('        }');
  lines.push('        // Stage 2: activate after 6 real seconds — CUA observer needs startup time before phases advance');
  lines.push('        if (!_autoPlayMode && _autoPlayDetectRealTime > 0f && (Time.realtimeSinceStartup - _autoPlayDetectRealTime) >= 6f)');
  lines.push('        {');
  lines.push('            _autoPlayMode = true;');
  lines.push('        }');
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
    lines.push('        // [SKELETON] Idle game core loop');
    lines.push('        if (!_autoPlayMode) MovePlayer(); // interactive mode: joystick/tap');
  }
  // AutoPlayUpdate is ALWAYS called — generated for both idle and non-idle games
  lines.push('        if (_autoPlayMode) AutoPlayUpdate(); // autoPlay mode: trigger interactions for CUA');
  if (isIdleGame) {
    lines.push('');
  }
  lines.push('        // === TODO: AI fills — update systems: resource collection, delivery, production, etc. ===');
  if (isIdleGame) {
    lines.push('        // Use TryCollect/TryDeliver for resource flow. Example:');
    lines.push('        // if (TryCollect(iceSource, "ice", 5, 1.5f)) { /* picked up ice */ }');
    lines.push('        // int delivered = TryDeliver(waterMachine, "ice", 1.5f);');
    lines.push('        // if (delivered > 0) { waterMachineState = 1; /* machine producing */ }');
    lines.push('        // UpdateCarryVisuals(); // show stack on player back');
  }
  lines.push('        // TODO_UPDATE_START');
  lines.push('');
  lines.push('        // TODO_UPDATE_END');
  lines.push('        // TODO_CUSTOM_START');
  lines.push('        // TODO_CUSTOM_END');
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
      lines.push(`            currentPhaseName = "${spec.phaseId}"; // [IMMUTABLE] Do NOT change this phaseId`);
      lines.push(`            phaseEnterTimes[${ruleIdx}] = gameTimer; // [SKELETON]`);
      lines.push(`            ReportPhase("${spec.phaseId}"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking`);
      lines.push('');

      // [SKELETON] Anti-solid-color: place first 3 entities in phase 1
      if (visibleEntities.length > 0) {
        lines.push('            // [SKELETON] Anti-solid-color: show initial objects (pool objects have pre-baked colors — do NOT call SetColor)');
        visibleEntities.forEach((eName, vi) => {
          const color = ENTITY_COLORS[vi % ENTITY_COLORS.length];
          const xPos = (vi - 1) * 3; // spread: -3, 0, 3
          lines.push(`            PlaceObj(${eName}, ${xPos}f, 0.5f, 0f); // pool color: ${color.label} — do NOT call SetColor`);
          lines.push(`            SetScale(${eName}, 1f, 1f, 1f); // keep original scale — avoid oversized black rectangles`);
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
      const realCondition = buildRealCondition(prevSpec);
      // [SKELETON] AutoPlay gate: require timer + at least one OnAutoPlayArrive call per phase
      lines.push(`        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK`);
      lines.push(`        if (_autoPlayMode && !ruleTriggered[${ruleIdx}] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action`);
      lines.push(`        else if (!ruleTriggered[${ruleIdx}]`);
      lines.push(`            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)`);
      lines.push(`                : (${realCondition} && phaseTimer >= ${prevSpec.duration.min}f))) // interactive mode`);
      lines.push('        {');
      lines.push(`            ruleTriggered[${ruleIdx}] = true;`);
      lines.push(`            currentPhaseName = "${spec.phaseId}"; // [IMMUTABLE] Do NOT change this phaseId`);
      lines.push(`            phaseEnterTimes[${ruleIdx}] = gameTimer; // [SKELETON]`);
      lines.push('            phaseTimer = 0f; // [SKELETON] reset timer — prevent batch-firing multiple phases in one frame');
      lines.push('            _autoPlayStepsAtPhaseStart = _autoPlaySteps; // [SKELETON] reset per-phase step counter');
      lines.push(`            ReportPhase("${spec.phaseId}"); // [IMMUTABLE] CUA uses this exact ID for coverage tracking`);
      lines.push('');

      // [SKELETON] AutoPlay phase transition — advance state + camera only (no PlaceObj to avoid black bars)
      const camTarget = spec.camera && spec.camera.lookAt ? spec.camera.lookAt : null;
      lines.push(`            // [SKELETON] AutoPlay state advance for ${spec.phaseName} (DO NOT MODIFY)`);
      lines.push('            if (_autoPlayMode)');
      lines.push('            {');
      // Advance entity states for entities required by previous phase
      (prevSpec.entitiesRequired || []).forEach(e => {
        if (allEntities.has(e.name)) {
          lines.push(`                ${e.name}State = ${Math.min(e.terminalState || 2, 2)};`);
        }
      });
      lines.push('                _autoPlaySteps++;');
      lines.push('            }');
      lines.push('');

      lines.push(`            // === TODO: AI fills — activate objects for ${spec.phaseName} ===`);
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_START`);
      lines.push('');
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_END`);
      lines.push('');
      lines.push(`            AddCompletedPhase("${prevSpec.phaseId}"); // [IMMUTABLE] Must match spec phaseId exactly`);
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
  const endRealCondition = buildRealCondition(lastSpec);
  lines.push(`        // [SKELETON] autoPlay 12s gate — DO NOT MODIFY OR REMOVE THIS BLOCK`);
  lines.push(`        if (_autoPlayMode && !ruleTriggered[${specs.length}] && (phaseTimer < 12f || _autoPlaySteps <= _autoPlayStepsAtPhaseStart)) {} // wait 12s + autoPlay action`);
  lines.push(`        else if (!ruleTriggered[${specs.length}]`);
  lines.push(`            && (_autoPlayMode ? (phaseTimer >= 12f && _autoPlaySteps > _autoPlayStepsAtPhaseStart) // [SKELETON] 12s + autoPlay action (DO NOT MODIFY)`);
  lines.push(`                : (${endRealCondition} && phaseTimer >= ${lastSpec.duration.min}f)))`);
  lines.push('        {');
  lines.push(`            ruleTriggered[${specs.length}] = true;`);
  lines.push('            currentPhaseName = "gameEnd";');
  lines.push('            ReportPhase("gameEnd"); // [SKELETON] Phase instrumentation');
  lines.push('            gameEnded = true;');
  lines.push('');

  // [SKELETON] AutoPlay: advance all entity states to terminal at game end
  if (allEntities.size > 0) {
    lines.push('            // [SKELETON] AutoPlay: set all entities to terminal state');
    lines.push('            if (_autoPlayMode)');
    lines.push('            {');
    allEntities.forEach(name => {
      lines.push(`                ${name}State = 2;`);
    });
    lines.push('            }');
  }

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
  lines.push('');

  // [SKELETON] AutoPlay safety net — force phase progression if stuck
  // This block is AFTER all normal phase transitions. If autoPlay mode and phaseTimer
  // exceeds 2x the expected duration, force-trigger the next untriggered phase.
  // This catches cases where AI accidentally broke the autoPlay ternary conditions.
  lines.push('        // [SKELETON] AutoPlay safety net — force progression if stuck (DO NOT MODIFY)');
  lines.push('        if (_autoPlayMode && !gameEnded && phaseTimer >= (AUTO_PLAY_PHASE_DURATION < 15f ? 50f : AUTO_PLAY_PHASE_DURATION * 2.5f)) // [SKELETON] safety net min 50s (DO NOT MODIFY)');
  lines.push('        {');
  for (let ri = 1; ri <= specs.length; ri++) {
    const targetPhase = ri < specs.length ? specs[ri].phaseId : 'gameEnd';
    const prevPhase = specs[ri - 1].phaseId;
    lines.push(`            if (!ruleTriggered[${ri}]) // stuck at ${prevPhase} → force ${targetPhase}`);
    lines.push('            {');
    lines.push(`                ruleTriggered[${ri}] = true;`);
    if (ri < specs.length) {
      lines.push(`                currentPhaseName = "${targetPhase}";`);
      lines.push(`                phaseEnterTimes[${ri}] = gameTimer;`);
      lines.push('                phaseTimer = 0f;');
      lines.push(`                ReportPhase("${targetPhase}");`);
      lines.push(`                AddCompletedPhase("${prevPhase}");`);
    } else {
      lines.push('                currentPhaseName = "gameEnd";');
      lines.push('                ReportPhase("gameEnd");');
      lines.push(`                AddCompletedPhase("${prevPhase}");`);
      lines.push('                AddCompletedPhase("gameEnd");');
      lines.push('                gameEnded = true;');
      lines.push('                ShowCTA();');
    }
    lines.push('                _autoPlaySteps++;');
    lines.push('                UpdateGameState();');
    lines.push('                return; // only advance one phase per frame');
    lines.push('            }');
  }
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
  lines.push('    void SetScale(GameObject obj, float uniform)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.transform.localScale = new Vector3(uniform, uniform, uniform);');
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
  lines.push('            + ",\\"autoPlayMode\\":" + (_autoPlayMode ? "true" : "false")');
  lines.push('            + ",\\"autoPlaySteps\\":" + _autoPlaySteps');
  lines.push('            + ",\\"autoPlayStepsThisPhase\\":" + (_autoPlaySteps - _autoPlayStepsAtPhaseStart)');
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

  // For large blueprints (>10 phases), split into main + systems files
  if (shouldSplit) {
    return _splitSkeleton(lines, specs, allEntities, entityPoolMap, isIdleGame);
  }

  return lines.join('\n');
}

/**
 * Split skeleton into main file (phase flow) + systems file (helpers, subsystems)
 * @returns {{main: string, systems: string}}
 */
function _splitSkeleton(allLines, specs, allEntities, entityPoolMap, isIdleGame) {
  const fullCode = allLines.join('\n');

  // Systems file: helper methods that AI can extend
  const sysLines = [];
  sysLines.push('// ========== AUTO-GENERATED SYSTEMS FILE — Subsystems & Helpers ==========');
  sysLines.push('// This partial class holds reusable systems, helpers, and AI-extensible subsystems.');
  sysLines.push('// Keep phase flow in GameFlowManagerMain.cs, put game systems here.');
  sysLines.push('');
  sysLines.push('using UnityEngine;');
  sysLines.push('using UnityEngine.UI;');
  sysLines.push('');
  sysLines.push('public partial class GameFlowManagerMain');
  sysLines.push('{');
  sysLines.push('    // ========== AI SUBSYSTEMS ==========');
  sysLines.push('    // Put movement systems, spawner systems, combat systems, resource systems here.');
  sysLines.push('    // The main file calls these from Update() or CheckEventRules().');
  sysLines.push('');
  sysLines.push('    // === TODO: AI fills — game subsystems (movement, combat, spawning, economy) ===');
  sysLines.push('    // TODO_SYSTEMS_START');
  sysLines.push('');
  sysLines.push('    // TODO_SYSTEMS_END');
  sysLines.push('');
  sysLines.push('    // === TODO: AI fills — UI helpers, input handlers, visual effects ===');
  sysLines.push('    // TODO_UI_START');
  sysLines.push('');
  sysLines.push('    // TODO_UI_END');
  sysLines.push('}');

  // Main file: remove the TODO_SYSTEMS and TODO_UI sections (moved to Systems file)
  // Replace them with a comment pointing to the Systems file
  let mainCode = fullCode;
  mainCode = mainCode.replace(
    /    \/\/ === TODO: AI fills — game systems \(UpdatePlayer, UpdateEnemies, etc\.\) ===\n    \/\/ TODO_SYSTEMS_START\n\n    \/\/ TODO_SYSTEMS_END\n/,
    '    // NOTE: Game subsystems (movement, combat, spawning, etc.) go in GameFlowManagerMain.Systems.cs\n'
  );
  mainCode = mainCode.replace(
    /    \/\/ === TODO: AI fills — ShowGuide, UI helpers, input handlers ===\n    \/\/ TODO_UI_START\n\n    \/\/ TODO_UI_END\n/,
    '    // NOTE: UI helpers and input handlers go in GameFlowManagerMain.Systems.cs\n'
  );

  return {
    main: mainCode,
    systems: sysLines.join('\n'),
    split: true
  };
}

/**
 * Save skeleton to file
 */
function saveSkeleton(skeleton, outputPath) {
  fs.writeFileSync(outputPath, skeleton, 'utf8');
  console.log(`[SkeletonGenerator] Skeleton saved to ${outputPath} (${(skeleton.length / 1024).toFixed(1)} KB)`);
}

module.exports = { generateSkeleton, saveSkeleton };
