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
  // Defence in depth: spec-extract stage is supposed to guarantee non-empty
  // specs before codegen runs. If we still got undefined/empty here, fail with
  // a message that points at the contract instead of "Cannot read … 'length'".
  if (!Array.isArray(specs) || specs.length === 0) {
    const err = new Error('generateSkeleton called with empty/undefined specs — spec-extract stage must populate ctx.blueprint.specs before codegen');
    err.classification = 'FATAL';
    throw err;
  }
  const totalPhases = specs.length;
  const entityPoolMap = opts.entityPoolMap || {};
  // [SKELETON 2026-04-19] entities[] carries chineseName / showLabel for world labels
  const entityMeta = {};
  (opts.entities || []).forEach(ent => {
    if (ent && ent.name) entityMeta[ent.name] = ent;
  });

  // Resolve entity name collisions with skeleton built-in variables
  const renamedEntities = {};
  Object.keys(entityPoolMap).forEach(name => {
    if (RESERVED_SKELETON_VARS.has(name)) {
      const newName = name + 'Obj';
      renamedEntities[name] = newName;
      entityPoolMap[newName] = entityPoolMap[name];
      delete entityPoolMap[name];
      // carry meta over so chineseName/showLabel survive the rename
      if (entityMeta[name]) {
        entityMeta[newName] = Object.assign({}, entityMeta[name], { name: newName });
        delete entityMeta[name];
      }
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

  // Helper: list GameObject names that gate a phase's exit condition.
  // Prefers entities that will actually be moved by a known interaction template
  // (collect/deliver/sell/click/spend/build/move_to). Falls back to all
  // entitiesRequired + non-numeric interaction targets when no interaction is tagged
  // with a supported verb, to preserve behaviour for wait/defend/custom phases.
  //
  // Why: phase-exit binds to EntityAdvanced(X, _snap_XPos). If X has no interaction
  // that moves it during the phase, the gate is structurally unreachable — codex
  // reviewer reports "phase X unreachable" and fix-loop circuit-breaks (seen in
  // s6ae56 / nqw7z3 on 2026-04-21). Keeping only entities that a template moves
  // prevents that failure mode.
  const MOVING_VERBS = { collect: 1, deliver: 1, sell: 1, click: 1, spend: 1, build: 1, move_to: 1 };
  function phaseGateEntities(spec) {
    const entities = spec.entitiesRequired || [];
    const interactions = spec.requiredInteractions || [];

    // Preferred: targets of interactions whose verb is known to move the entity.
    const preferred = [];
    const preferredSeen = {};
    for (let ii = 0; ii < interactions.length; ii++) {
      const parts = interactions[ii].split(':');
      const verb = parts[0];
      const target = parts[1];
      if (!target) continue;
      if (/^\d/.test(target)) continue;
      if (!MOVING_VERBS[verb]) continue;
      if (!preferredSeen[target]) { preferred.push(target); preferredSeen[target] = true; }
    }
    if (preferred.length > 0) return preferred;

    // Fallback: original behaviour. Still filter out wait/defend verbs.
    const names = [];
    const seen = {};
    entities.forEach(e => {
      if (e && e.name && !seen[e.name]) { names.push(e.name); seen[e.name] = true; }
    });
    for (let ii = 0; ii < interactions.length; ii++) {
      const parts = interactions[ii].split(':');
      const verb = parts[0];
      const target = parts[1];
      if (!target || verb === 'wait' || verb === 'defend') continue;
      if (/^\d/.test(target)) continue;
      if (!seen[target]) { names.push(target); seen[target] = true; }
    }
    return names;
  }

  // Build the phase-exit realCondition. Unlike the old version, this no longer
  // reads fake flags (xxxState / xxxDone / xxxPlayerActed) — those can be assigned
  // by AI without any visible gameplay. Instead it binds to actual GameObject state:
  // a phase exits only when every required entity has moved > 1.5 units from the
  // position snapshotted at phase entry.
  //
  // NOTE: SetActive() is forbidden in Luna (see static-check `setactive` rule),
  // so EntityAdvanced checks position only. The skeleton's PlaceObj/HideObj
  // move entities to (y >= 0) or (y = -999) respectively — both count as visible
  // movement and satisfy the condition.
  //
  // CUA alignment: because `EntityAdvanced` reads transform.position directly,
  // any satisfied condition is guaranteed to produce an observable visual diff.
  function buildRealCondition(spec) {
    const names = phaseGateEntities(spec);
    if (names.length === 0) {
      // No gate entity — check if this phase is legitimately a wait/defend beat.
      // wait:N / defend:N interactions mean "hold for N seconds of animation",
      // the timer gate is the real condition. Letting these through as `true`
      // means only `phaseTimer >= Xf` controls exit (no fakeable flags involved).
      const inter = spec.requiredInteractions || [];
      const onlyTimeBased = (inter.length === 0 && !spec.playerMustAct) || (inter.length > 0 && inter.every(function(s) {
        const v = (s || '').split(':')[0];
        return v === 'wait' || v === 'defend';
      }));
      if (onlyTimeBased) {
        return 'true /* time-only beat (wait/defend) — timer alone is the real gate */';
      }
      // Otherwise the phase spec is too loose. AI can't fix it by editing C#; block
      // hard so the bad spec doesn't silently pass.
      return 'false /* AI: phase spec lacks entities/interactions — add EntityAdvanced(...) check with GameObject + snapshot */';
    }
    const parts = names.map(function(n) {
      return 'EntityAdvanced(' + n + ', _snap_' + n + 'Pos)';
    });
    return parts.join(' && ');
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
  lines.push('    // [SKELETON] AutoPlay — state owner is GFM_AutoPlay (canonical library)');
  lines.push('    // Local snapshots are synced at top of Update() each frame for backward compat');
  lines.push('    // with downstream skeleton code that reads _autoPlayMode / _autoPlaySteps.');
  lines.push('    bool _autoPlayMode = false;');
  lines.push('    int _autoPlaySteps = 0;');
  lines.push('    int _autoPlayStepsAtPhaseStart = 0; // tracks autoPlay steps when current phase started');
  lines.push('    const float AUTO_PLAY_PHASE_DURATION = 12f; // [SKELETON] 12s per shot — DO NOT MODIFY this value');
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

  // [SKELETON 2026-04-20] Per-entity snapshots — captured at phase entry, checked at
  // phase exit. EntityAdvanced() reads these to decide whether a phase condition is
  // truly satisfied. This replaces the old xxxState / xxxDone / xxxPlayerActed faking
  // path (see 2026-04-20 autoplay condition enforcement postmortem).
  if (entityNames.length > 0) {
    lines.push('    // [SKELETON] Shared fallback pos for phase-entry snapshots (class field init, not hot path)');
    lines.push('    Vector3 _snapHidePos = new Vector3(0f, -999f, 0f);');
    lines.push('    // [SKELETON] Per-entity phase-entry snapshots — DO NOT MODIFY');
    entityNames.forEach(name => {
      lines.push(`    Vector3 _snap_${name}Pos;`);
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
    // [SKELETON] Economy system — state lives in GFM_EconomyManager (parallel arrays,
    // Luna-compatible, no Dictionary). Main file keeps thin delegate stubs so existing
    // templates that call AddResource/GetResource/TrySpend/TryConvert keep working.
    lines.push('    // [SKELETON] Economy system — delegated to GFM_EconomyManager (state owner)');
    lines.push('    // AI fills _resources array in Start(); skeleton syncs it to Manager once.');
    lines.push('    struct ResourceDef {');
    lines.push('        public string resourceId;');
    lines.push('        public string displayName;');
    lines.push('        public string convertFrom; // upstream resource id, empty if primary');
    lines.push('        public int convertRatio;   // how many upstream = 1 of this');
    lines.push('    }');
    lines.push('    ResourceDef[] _resources; // [SKELETON] AI: fill in Start(); auto-synced to Manager');
    lines.push('');
    lines.push('    // [SKELETON] Sync locally-filled _resources into GFM_EconomyManager (once)');
    lines.push('    void _SyncResourcesToManager() {');
    lines.push('        if (_resources == null || _resources.Length == 0) return;');
    lines.push('        var mgr = GFM_EconomyManager.Instance;');
    lines.push('        var mgrDefs = new GFM_EconomyManager.ResourceDef[_resources.Length];');
    lines.push('        for (int i = 0; i < _resources.Length; i++) {');
    lines.push('            mgrDefs[i] = new GFM_EconomyManager.ResourceDef {');
    lines.push('                resourceId = _resources[i].resourceId,');
    lines.push('                displayName = _resources[i].displayName,');
    lines.push('                convertFrom = _resources[i].convertFrom,');
    lines.push('                convertRatio = _resources[i].convertRatio');
    lines.push('            };');
    lines.push('        }');
    lines.push('        mgr.SetResources(mgrDefs);');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] Delegate stubs — forward to GFM_EconomyManager (single source of truth)');
    lines.push('    void AddResource(string id, int amount) { GFM_EconomyManager.Instance.AddResource(id, amount); }');
    lines.push('    int GetResource(string id) { return GFM_EconomyManager.Instance.GetResource(id); }');
    lines.push('    bool TrySpend(string id, int amount) { return GFM_EconomyManager.Instance.TrySpend(id, amount); }');
    lines.push('    bool TryConvert(string fromId, string toId) { return GFM_EconomyManager.Instance.TryConvert(fromId, toId); }');
    lines.push('    void UpdateResourceUI() {');
    lines.push('        // Manager 自动更新 scoreText；如果主文件用本地 scoreText，在这里额外拉取展示。');
    lines.push('        if (scoreText == null) return;');
    lines.push('        var mgr = GFM_EconomyManager.Instance;');
    lines.push('        // Luna 禁用 List<T>，用 string 累加（InvCount 通常 < 10，无性能问题）');
    lines.push('        string display = "";');
    lines.push('        for (int i = 0; i < mgr.InvCount; i++) {');
    lines.push('            int v = mgr.InvVal(i);');
    lines.push('            if (v > 0) {');
    lines.push('                if (display.Length > 0) display += "  ";');
    lines.push('                display += mgr.InvKey(i) + ": " + v;');
    lines.push('            }');
    lines.push('        }');
    lines.push('        scoreText.text = display;');
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
    lines.push('    // [SKELETON] Reusable buffer for per-frame move/look vectors — avoids alloc');
    lines.push('    Vector3 _moveBuf = Vector3.zero;');
    lines.push('    // [SKELETON] Batch 2 collect cooldown infra — shared across all collect templates');
    lines.push('    float collectCooldownInterval = ' + (specs.gameConfig && specs.gameConfig.collectCooldown ? specs.gameConfig.collectCooldown : 0.3) + 'f;');
    lines.push('    float _collectCooldown = 0f;');
    lines.push('    string _lastScoreText = "";');
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
    lines.push('                _moveBuf.x = h; _moveBuf.y = 0f; _moveBuf.z = v;');
    lines.push('                float step = moveSpeed * Time.deltaTime;');
    lines.push('                var p = player.transform.position;');
    lines.push('                p.x += _moveBuf.x * step; p.z += _moveBuf.z * step;');
    lines.push('                player.transform.position = p;');
    lines.push('                player.transform.rotation = Quaternion.LookRotation(_moveBuf);');
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
    lines.push('    // [SKELETON] Check if player is near a target (proximity trigger) — XZ sqr distance, no sqrt/alloc');
    lines.push('    bool IsNear(GameObject target, float range)');
    lines.push('    {');
    lines.push('        if (player == null || target == null) return false;');
    lines.push('        float dx = player.transform.position.x - target.transform.position.x;');
    lines.push('        float dz = player.transform.position.z - target.transform.position.z;');
    lines.push('        return (dx * dx + dz * dz) < (range * range);');
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
    lines.push('        if (floatingText == null) floatingText = GFM_UI.CreateText(uiCanvas, "", Vector2.zero, 48);');
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
    // Idle games: GFM_AutoPlay handles navigation. Skeleton captures target list + registers OnArrive in Start.
    lines.push('    // [SKELETON] AutoPlay targets — passed to GFM_AutoPlay.Instance in Start()');
    lines.push(`    string[] _autoTargets = new string[] { ${autoTargets.map(t => '"' + t + '"').join(', ')} };`);
    lines.push('');
    lines.push('    // [SKELETON] AutoPlayUpdate — delegates to GFM_AutoPlay.Instance (navigation + OnArrive)');
    lines.push('    void AutoPlayUpdate()');
    lines.push('    {');
    lines.push('        GFM_AutoPlay.Instance.Tick();');
    lines.push('        _autoPlaySteps = GFM_AutoPlay.Instance.Steps; // sync local for backward compat');
    lines.push('    }');
  } else {
    // Non-idle or no targets — use timer-based periodic interaction trigger (no player navigation needed)
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
    lines.push('            GFM_AutoPlay.Instance.IncrementSteps(); // sync step count to Manager');
    lines.push('            OnAutoPlayArrive(currentPhaseName);');
    lines.push('        }');
    lines.push('    }');
  }
  lines.push('');
  lines.push('    // [SKELETON 2026-04-20] OnAutoPlayArrive — MUST produce OBSERVABLE position changes.');
  lines.push('    // Phase-exit gate binds to EntityAdvanced() which reads transform.position only.');
  lines.push('    // Direct variable writes (xxxState=N, xxxDone=true) DO NOT satisfy conditions.');
  lines.push('    //');
  lines.push('    // REQUIRED per case — move the phase-required entity by > 1.5 units:');
  lines.push('    //   1. PlaceObj(entity, x, y, z)                      — show at given position');
  lines.push('    //   2. HideObj(entity)                                — move to y=-999 (hide)');
  lines.push('    //   3. entity.transform.position = new Vector3(...)   — direct move');
  lines.push('    //');
  lines.push('    // FORBIDDEN in this method (will fail static check):');
  lines.push('    //   - xxxState = <literal>         (State vars are now read-only)');
  lines.push('    //   - xxxDone = true               (Done flags no longer gate phases)');
  lines.push('    //   - xxxPlayerActed = true        (PlayerActed flags no longer gate phases)');
  lines.push('    //   - entity.SetActive(...)        (forbidden by Luna static-check)');
  lines.push('    void OnAutoPlayArrive(string targetName)');
  lines.push('    {');
  lines.push('        // TODO_AUTOPLAY_INTERACT_START');
  if (specs.length > 0) {
    lines.push('        switch (currentPhaseName)');
    lines.push('        {');
    for (var apsi = 0; apsi < specs.length; apsi++) {
      var apSpec = specs[apsi];
      var apPhaseId = (apSpec.phaseId || 'phase' + apsi).replace(/[^a-zA-Z0-9]/g, '');
      var apEntities = apSpec.entitiesRequired || [];
      lines.push('            case "' + apPhaseId + '":');
      // Emit GUIDANCE comments listing each entity that must be advanced here.
      // No auto-generated assignments — AI must write real PlaceObj/SetActive calls.
      if (apEntities.length > 0) {
        lines.push('                // REQUIRED: produce observable change for each entity below');
        for (var aei = 0; aei < apEntities.length; aei++) {
          var eName = apEntities[aei].name || apEntities[aei];
          lines.push('                //   - ' + eName + ': PlaceObj(' + eName + ', x, y, z) or HideObj(' + eName + ') or direct transform.position =');
        }
      } else {
        lines.push('                // REQUIRED: call PlaceObj / HideObj / transform.position = ... for the phase-required entity');
      }
      lines.push('                // TODO: AI fills — move/activate entities so EntityAdvanced(...) becomes true');
      lines.push('                break;');
    }
    lines.push('        }');
  } else {
    lines.push('        // TODO: AI fills — move/activate entities so EntityAdvanced(...) becomes true');
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

  // [SKELETON 2026-04-20] EntityAdvanced — phase-exit gate binds to GameObject state.
  // Returns true when the entity has moved more than ~1.5 units from its phase-entry
  // position. This is the ONLY way phase conditions can satisfy — variable
  // assignments alone (xxxState=N, xxxDone=true) are not readable here.
  //
  // Note: SetActive is forbidden in Luna, so we only check position. Use PlaceObj
  // (show) / HideObj (move to y=-999) / transform.position = ... to advance entities.
  lines.push('    // [SKELETON] Phase condition helper — reads REAL GameObject position (DO NOT MODIFY)');
  lines.push('    bool EntityAdvanced(GameObject go, Vector3 snapPos)');
  lines.push('    {');
  lines.push('        if (go == null) return false;');
  lines.push('        return Vector3.Distance(go.transform.position, snapPos) > 1.5f;');
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
  lines.push('        // [SKELETON] Pool objects already ship with pre-baked colors');
  // ResetPool / InitMaterialFromScene removed — using pre-colored pool objects
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

  // [SKELETON 2026-04-19] World labels — Chinese names above player-visible targets.
  // Reintroduced after ScriptActivator predicate (2026-04-18) stopped calling
  // GFM_Create.Obj(), which historically auto-attached labels. Label bg uses
  // alpha=0 (fully transparent), so no ugly black bar.
  // Opt-out rule: showLabel === false (player vehicle, currency, UI buttons).
  let _labelsEmitted = 0;
  entityNames.forEach(name => {
    const meta = entityMeta[name];
    if (!meta) return;
    if (meta.showLabel === false) return;
    if (!meta.chineseName) return;
    if (_labelsEmitted === 0) {
      lines.push('        // [SKELETON] World-space Chinese labels on target entities');
    }
    const scale = typeof meta.scale === 'number' ? meta.scale : 1;
    // height offset = ~top of entity bounding box + 0.5m clearance
    const heightOffset = (scale * 0.5 + 0.5).toFixed(2);
    const cnEscaped = meta.chineseName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`        GFM_UI.AddWorldLabel(${name}, "${cnEscaped}", ${heightOffset}f);`);
    _labelsEmitted++;
  });
  if (_labelsEmitted > 0) lines.push('');

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
  lines.push('        uiCanvas = GFM_UI.CreateCanvas(1920, 1080);');
  lines.push('        guideText = GFM_UI.CreateText(uiCanvas, "", new Vector2(0, 450), 52);');
  lines.push('        scoreText = GFM_UI.CreateText(uiCanvas, "Score: 0", new Vector2(680, 480), 40);');
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
  if (hasEconomy) {
    lines.push('        // [SKELETON] Sync AI-filled _resources into GFM_EconomyManager (state owner)');
    lines.push('        _SyncResourcesToManager();');
    lines.push('');
  }
  // [SKELETON] Register AutoPlay targets + OnArrive callback with the Manager.
  // Only the idle-game branch emits `_autoTargets` (non-idle uses timer-based Update path).
  if (autoTargets.length > 0 && isIdleGame) {
    lines.push('        // [SKELETON] Register AutoPlay targets with GFM_AutoPlay (state owner)');
    lines.push('        GFM_AutoPlay.Instance.SetTargets(_autoTargets);');
    lines.push('');
  }
  lines.push('        // [SKELETON] Wire AutoPlay arrival callback — Manager calls OnAutoPlayArrive per target');
  lines.push('        GFM_AutoPlay.Instance.OnArrive = OnAutoPlayArrive;');
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
  lines.push('        // Keep update as a coordinator: delegate state sync helpers instead of inlining logic.');
  lines.push('        SyncAutoPlayState(gameTimer);');
  lines.push('');
  lines.push('        UpdatePhaseTimer(dt);');
  if (isIdleGame) {
  lines.push('        if (_collectCooldown > 0f) _collectCooldown -= Time.deltaTime;');
  }
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
      // [SKELETON 2026-04-20] Phase 0 warmup gate — prevents CUA PRE-CONTAMINATION.
      // Without this, phase 0 fires on Update's first frame (before CUA observer
      // opens its window at ~5-6s), so completedPhases already contains the first
      // spec phase when CUA starts observing → hard fail, fix-loop cannot recover.
      // WarmupReady handles both modes:
      //   - Interactive: false for first 3s (detection window), then true
      //   - AutoPlay: false until detection + 6s warmup, then true
      lines.push(`        if (!ruleTriggered[${ruleIdx}] && GFM_AutoPlay.Instance.WarmupReady)`);
      lines.push('        {');
      lines.push(`            EnterPhase(${ruleIdx}, "${spec.phaseId}", false, false);`);
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

      // [SKELETON 2026-04-20] Snapshot this phase's entities — phase exit condition
      // requires these entities to have moved since this snapshot (DO NOT MODIFY)
      const phase0Gates = phaseGateEntities(spec);
      if (phase0Gates.length > 0) {
        lines.push(`            Snapshot_${spec.phaseId}_GateEntities();`);
        lines.push('');
      }

      lines.push(`            Phase_${spec.phaseId}_Init();`);
      lines.push('');
      lines.push('            CompletePhaseProgress("gameStart");');
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
      // [SKELETON 2026-04-20] Unified phase-exit gate — same condition in autoPlay + interactive.
      // realCondition binds to GameObject state (see EntityAdvanced), so autoPlay CANNOT
      // satisfy by flag assignment alone — AI must move/activate entities in OnAutoPlayArrive.
      // The 12s floor in autoPlay gives CUA observer time to capture each phase clearly.
      lines.push(`        // [SKELETON] Phase-exit gate (DO NOT MODIFY OR REMOVE)`);
      lines.push(`        if (!ruleTriggered[${ruleIdx}]`);
      lines.push(`            && (${realCondition})`);
      lines.push(`            && phaseTimer >= (_autoPlayMode ? 12f : ${prevSpec.duration.min}f))`);
      lines.push('        {');
      lines.push(`            EnterPhase(${ruleIdx}, "${spec.phaseId}", true, true);`);
      lines.push('');

      // [SKELETON 2026-04-20] Snapshot entities gating THIS phase's exit — must happen
      // before AI init code runs, so OnAutoPlayArrive's moves count as "advancement".
      const thisPhaseGates = phaseGateEntities(spec);
      if (thisPhaseGates.length > 0) {
        lines.push(`            Snapshot_${spec.phaseId}_GateEntities();`);
        lines.push('');
      }

      lines.push(`            Phase_${spec.phaseId}_Init();`);
      lines.push('');
      lines.push(`            CompletePhaseProgress("${prevSpec.phaseId}"); // [IMMUTABLE] Must match spec phaseId exactly`);
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
  // [SKELETON 2026-04-20] Unified game-end gate — no autoPlay bypass, no bulk State=2.
  // Last phase's entities must actually advance (move/toggle) during the last phase
  // for gameEnd to trigger.
  lines.push(`        // [SKELETON] Game-end gate (DO NOT MODIFY OR REMOVE)`);
  lines.push(`        if (!ruleTriggered[${specs.length}]`);
  lines.push(`            && (${endRealCondition})`);
  lines.push(`            && phaseTimer >= (_autoPlayMode ? 12f : ${lastSpec.duration.min}f))`);
  lines.push('        {');
  lines.push(`            EnterPhase(${specs.length}, "gameEnd", false, false);`);
  lines.push('');
  lines.push(`            FinishGame("${lastSpec.phaseId}");`);
  lines.push('        }');
  lines.push('');

  // [SKELETON 2026-04-20] Stuck-phase reporter — LOG ONLY, does NOT bypass conditions.
  // If a phase runs past 90s without its realCondition satisfying, emit a FATAL marker
  // that CUA / task supervisor picks up. We do NOT write ruleTriggered[i] here —
  // the old safety net was the L5 bypass; replacing it with a pure observer keeps
  // "conditions must be fully satisfied" the only path to phase advancement.
  lines.push('        // [SKELETON] Stuck-phase reporter — emits __PHASE_STUCK__ when realCondition fails to satisfy (DO NOT MODIFY)');
  lines.push('        if (!gameEnded && phaseTimer >= 90f && TryReportStuckPhase())');
  lines.push('        {');
  lines.push('            return;');
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
  lines.push('            GFM_AutoPlay.Instance.NotifyPhaseProgress(phaseName);');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // [SKELETON] Transform helpers — struct-copy pattern to minimize Vector3 alloc on hot paths');
  lines.push('    void PlaceObj(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var pos = obj.transform.position;');
  lines.push('        pos.x = x; pos.y = y; pos.z = z;');
  lines.push('        obj.transform.position = pos;');
  lines.push('    }');
  lines.push('');
  lines.push('    void HideObj(GameObject obj)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var pos = obj.transform.position;');
  lines.push('        pos.x = 0f; pos.y = -999f; pos.z = 0f;');
  lines.push('        obj.transform.position = pos;');
  lines.push('    }');
  lines.push('');
  lines.push('    void SetScale(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var s = obj.transform.localScale;');
  lines.push('        s.x = x; s.y = y; s.z = z;');
  lines.push('        obj.transform.localScale = s;');
  lines.push('    }');
  lines.push('    void SetScale(GameObject obj, float uniform)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var s = obj.transform.localScale;');
  lines.push('        s.x = uniform; s.y = uniform; s.z = uniform;');
  lines.push('        obj.transform.localScale = s;');
  lines.push('    }');
  lines.push('');

  // [SKELETON] Pre-generated ShowCTA with InstallFullGame
  lines.push('    // [SKELETON] CTA button — pre-generated, do not remove');
  lines.push('    void ShowCTA()');
  lines.push('    {');
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
  lines.push('            + "\\"entityStates\\":{');
  const entityList = Array.from(allEntities);
  entityList.forEach((name, i) => {
    const comma = i < entityList.length - 1 ? ',' : '';
    lines.push(`            + "\\"${name}\\":\\"" + ${name}State + "\\"${comma}"`);
  });
  lines.push('            + "},"');

  // Variables (AI fills)
  lines.push('            + "\\"variables\\":{');
  lines.push('            + "\\"gameTimer\\":" + (int)gameTimer');
  lines.push('            + ",\\"autoPlayMode\\":" + (_autoPlayMode ? "true" : "false")');
  lines.push('            + ",\\"autoPlaySteps\\":" + _autoPlaySteps');
  lines.push('            + ",\\"autoPlayStepsThisPhase\\":" + (_autoPlaySteps - _autoPlayStepsAtPhaseStart)');
  lines.push('            // TODO: AI adds game-specific variables here (gold, wood, ammo, etc.)');
  lines.push('            + "}"');

  // Phase timestamps
  lines.push('            + ",\\"phaseTimestamps\\":{');
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

  // Default-on: 5-partial split (Flow / Input / Resource / UI / Scene).
  // Callers may explicitly disable via `w1bSplit: false` for compatibility.
  if (opts.w1bSplit !== false) {
    const phaseGateMap = {};
    specs.forEach((spec, index) => {
      const pid = (spec.phaseId || 'phase' + index).replace(/[^a-zA-Z0-9]/g, '');
      phaseGateMap[pid] = phaseGateEntities(spec);
    });
    return _split5Partial(lines, specs, allEntities, entityPoolMap, isIdleGame, phaseGateMap);
  }

  // Legacy: 2-file split for large blueprints (>10 phases)
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
 * W1b 5-partial skeleton split.
 * Returns { main, flow, input, resource, ui, scene }.
 * Main keeps all existing skeleton content unchanged; companions add Phase dispatch
 * (Flow) and placeholder partial-class declarations (Input/Resource/UI/Scene).
 * Later W1b iterations will migrate method bodies from main into the 4 placeholders.
 */
function _split5Partial(allLines, specs, allEntities, entityPoolMap, isIdleGame, phaseGateMap = {}) {
  const fullCode = allLines.join('\n');
  const entityList = Array.from(allEntities);
  let mainCode = fullCode;
  mainCode = mainCode.replace(
    /    \/\/ ========== SKELETON HELPERS \(do not modify\) ==========[\s\S]*?    \/\/ === TODO: AI fills — ShowGuide, UI helpers, input handlers ===\n    \/\/ TODO_UI_START\n\n    \/\/ TODO_UI_END\n/,
    '    // NOTE: Phase bookkeeping helpers live in GameFlowManagerMain.Flow.cs\n' +
    '    // NOTE: Scene placement helpers live in GameFlowManagerMain.Scene.cs\n' +
    '    // NOTE: UI / CTA / UpdateGameState helpers live in GameFlowManagerMain.UI.cs\n' +
    '\n' +
    '    // NOTE: Input helpers live in GameFlowManagerMain.Input.cs\n'
  );
  mainCode = mainCode.replace(
    /    \/\/ \[SKELETON 2026-04-20\] OnAutoPlayArrive — MUST produce OBSERVABLE position changes\.[\s\S]*?    }\n\n    \/\/ \[SKELETON\] Phase instrumentation for automated testing\n/,
    '    // NOTE: AutoPlay phase dispatch helpers live in GameFlowManagerMain.Flow.cs\n\n' +
    '    // [SKELETON] Phase instrumentation for automated testing\n'
  );
  const resourceSplit = _extractResourceSections(mainCode);
  const idleSplit = _extractIdleKitSections(resourceSplit.main);
  return {
    main: idleSplit.main,
    flow: _buildFlowPartial(specs, phaseGateMap),
    input: _buildInputPartial(idleSplit.inputSections),
    resource: _buildResourcePartial(resourceSplit.sections.concat(idleSplit.resourceSections)),
    ui: _buildUiPartial(specs, entityList, idleSplit.uiSections),
    scene: _buildScenePartial(),
    split: true,
    mode: 'w1b-5partial',
  };
}

/**
 * Build Flow partial: Phase_OnTap() dispatcher + one Phase_<id>_OnTap() per phase.
 * Replaces the flat `switch(currentPhaseName) { case: ... = true; }` dispatch with
 * per-phase methods that AI (and template engine) can fill via TODO markers.
 * Fields referenced (<id>InteractionDone / <id>PlayerActed) are declared in main
 * and shared across partials.
 */
function _buildFlowPartial(specs, phaseGateMap = {}) {
  const lines = [];
  lines.push('// ========== AUTO-GENERATED FLOW PARTIAL — phase orchestration helpers ==========');
  lines.push('// Owner class: GameFlowManagerMain (partial). Fields in main are shared.');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain');
  lines.push('{');
  lines.push('    // ========== Flow Dispatchers ==========');
  lines.push('');
  lines.push('    // [SKELETON] Interactive-mode tap dispatcher. Update() calls this on player tap');
  lines.push('    // when !_autoPlayMode. Grep phaseId to locate each Phase_<id>_OnTap() below.');
  lines.push('    void Phase_OnTap()');
  lines.push('    {');
  lines.push('        // Dispatch the current phase directly to its dedicated tap handler.');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    lines.push('            case "' + pid + '": Phase_' + pid + '_OnTap(); break;');
  }
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // AutoPlay-mode dispatcher. Keep this coordinator thin and delegate phase logic below.');
  lines.push('    void OnAutoPlayArrive(string targetName)');
  lines.push('    {');
  lines.push('        // Dispatch directly to the active phase-specific autoPlay handler.');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    lines.push('            case "' + pid + '": Phase_' + pid + '_OnAutoPlayArrive(targetName); break;');
  }
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // ========== Shared Flow Helpers ==========');
  lines.push('');
  lines.push('    // Sync the local autoplay mirrors from GFM_AutoPlay so Update() stays lightweight.');
  lines.push('    void SyncAutoPlayState(float now)');
  lines.push('    {');
  lines.push('        // Manager owns activation timing and step counting. Keep main flow code read-only.');
  lines.push('        GFM_AutoPlay.Instance.CheckActivation(now);');
  lines.push('        _autoPlayMode = GFM_AutoPlay.Instance.IsActive;');
  lines.push('        _autoPlaySteps = GFM_AutoPlay.Instance.Steps;');
  lines.push('    }');
  lines.push('');
  lines.push('    // Reset and advance the per-phase timer whenever the active phase changes.');
  lines.push('    void UpdatePhaseTimer(float dt)');
  lines.push('    {');
  lines.push('        if (currentPhaseName != lastPhaseForTimer)');
  lines.push('        {');
  lines.push('            phaseTimer = 0f;');
  lines.push('            lastPhaseForTimer = currentPhaseName;');
  lines.push('        }');
  lines.push('        phaseTimer += dt;');
  lines.push('    }');
  lines.push('');
  lines.push('    // Apply the common state changes that happen whenever flow enters a new phase.');
  lines.push('    void EnterPhase(int ruleIdx, string phaseId, bool resetTimer, bool syncAutoPlayBaseline)');
  lines.push('    {');
  lines.push('        ruleTriggered[ruleIdx] = true;');
  lines.push('        currentPhaseName = phaseId;');
  lines.push('        phaseEnterTimes[ruleIdx] = gameTimer;');
  lines.push('        if (resetTimer) phaseTimer = 0f;');
  lines.push('        if (syncAutoPlayBaseline) _autoPlayStepsAtPhaseStart = _autoPlaySteps;');
  lines.push('        ReportPhase(phaseId);');
  lines.push('    }');
  lines.push('');
  lines.push('    // Apply the immutable end-of-game sequence in one place.');
  lines.push('    void FinishGame(string lastPhaseId)');
  lines.push('    {');
  lines.push('        AddCompletedPhase(lastPhaseId);');
  lines.push('        Luna.Unity.LifeCycle.GameEnded();');
  lines.push('        ShowCTA();');
  lines.push('        gameEnded = true;');
  lines.push('        UpdateGameState();');
  lines.push('    }');
  lines.push('');
  lines.push('    // Apply the common phase-progress bookkeeping after a transition completes.');
  lines.push('    void CompletePhaseProgress(string completedPhaseId)');
  lines.push('    {');
  lines.push('        AddCompletedPhase(completedPhaseId);');
  lines.push('        UpdateGameState();');
  lines.push('    }');
  lines.push('');
  lines.push('    // Emit one stuck-phase marker and throttle repeats so CUA gets a stable fatal signal.');
  lines.push('    bool TryReportStuckPhase()');
  lines.push('    {');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    const ruleIndex = i + 1;
    lines.push('            case "' + pid + '":');
    lines.push('                if (!ruleTriggered[' + ruleIndex + '])');
    lines.push('                {');
    lines.push('                    UnityEngine.Debug.Log("__PHASE_STUCK__:' + pid + ':phaseTimer=" + phaseTimer + ":autoPlay=" + (_autoPlayMode ? "1" : "0"));');
    lines.push('                    phaseTimer = 60f;');
    lines.push('                    return true;');
    lines.push('                }');
    lines.push('                break;');
  }
  lines.push('        }');
  lines.push('        return false;');
  lines.push('    }');
  lines.push('');
  lines.push('    // Record a completed phase in order and notify the autoPlay observer immediately.');
  lines.push('    void AddCompletedPhase(string phaseName)');
  lines.push('    {');
  lines.push('        if (completedPhaseCount < completedPhases.Length)');
  lines.push('        {');
  lines.push('            completedPhases[completedPhaseCount] = phaseName;');
  lines.push('            completedPhaseCount++;');
  lines.push('            GFM_AutoPlay.Instance.NotifyPhaseProgress(phaseName);');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // ========== Phase Init Handlers ==========');
  lines.push('');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    lines.push('    // [SKELETON] Phase "' + pid + '" enter/init helper.');
    lines.push('    // Keep phase-specific placement/guide logic here so CheckEventRules() stays concise.');
    lines.push('    void Phase_' + pid + '_Init()');
    lines.push('    {');
    if (i === 0) {
      lines.push('        // === TODO: AI fills — place additional objects, set colors, show guide ===');
      lines.push('        // TODO_PHASE_' + (i + 1) + '_INIT_START');
      lines.push('');
      lines.push('        // TODO_PHASE_' + (i + 1) + '_INIT_END');
    } else {
      lines.push('        // === TODO: AI fills — activate objects for ' + specs[i].phaseName + ' ===');
      lines.push('        // [REMINDER] This phase will exit when EntityAdvanced(X, _snap_XPos) > 1.5 for every X');
      lines.push('        // listed above. The exit gate reads transform.position ONLY. Flag writes');
      lines.push('        // (xxxDone=true / xxxState=N / xxxPlayerActed=true) DO NOT satisfy the gate.');
      lines.push("        // Ensure the phase's player-triggered interaction body (in Update / handlers /");
      lines.push('        // the matching case in OnAutoPlayArrive) calls PlaceObj(X,...) / HideObj(X) /');
      lines.push('        // X.transform.position = ... at least once per required entity.');
      lines.push('        // TODO_PHASE_' + (i + 1) + '_INIT_START');
      lines.push('');
      lines.push('        // TODO_PHASE_' + (i + 1) + '_INIT_END');
    }
    lines.push('    }');
    lines.push('');
  }
  lines.push('    // ========== Phase Tap Handlers ==========');
  lines.push('');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    lines.push('    // [SKELETON] Phase "' + pid + '" tap handler. AI/template fills TODO region.');
    lines.push('    void Phase_' + pid + '_OnTap()');
    lines.push('    {');
    lines.push('        // TODO_PHASE_' + pid + '_ONTAP_START');
    lines.push('        ' + pid + 'InteractionDone = true;');
    lines.push('        ' + pid + 'PlayerActed = true;');
    lines.push('        // TODO_PHASE_' + pid + '_ONTAP_END');
    lines.push('    }');
    lines.push('');
  }
  lines.push('    // ========== Phase AutoPlay Handlers ==========');
  lines.push('');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    const entities = specs[i].entitiesRequired || [];
    lines.push('    // [SKELETON] Phase "' + pid + '" autoPlay handler.');
    lines.push('    // MUST produce observable position changes so EntityAdvanced(...) can pass.');
    lines.push('    void Phase_' + pid + '_OnAutoPlayArrive(string targetName)');
    lines.push('    {');
    if (entities.length > 0) {
      lines.push('        // REQUIRED: produce observable change for each entity below');
      for (let ei = 0; ei < entities.length; ei++) {
        const eName = entities[ei].name || entities[ei];
        lines.push('        //   - ' + eName + ': PlaceObj(' + eName + ', x, y, z) or HideObj(' + eName + ') or direct transform.position =');
      }
    } else {
      lines.push('        // REQUIRED: call PlaceObj / HideObj / transform.position = ... for the phase-required entity');
    }
    lines.push('        // TODO_PHASE_' + pid + '_ONAUTOARRIVE_START');
    lines.push('        // TODO: AI fills — move/activate entities so EntityAdvanced(...) becomes true');
    lines.push('        // targetName is provided by GFM_AutoPlay for phase-specific routing when needed.');
    lines.push('        // TODO_PHASE_' + pid + '_ONAUTOARRIVE_END');
    lines.push('    }');
    lines.push('');
  }
  lines.push('    // ========== Phase Snapshot Helpers ==========');
  lines.push('');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    const gateEntities = phaseGateMap[pid] || [];
    if (gateEntities.length === 0) continue;
    lines.push('    // Capture the current positions of phase-gating entities for later EntityAdvanced(...) checks.');
    lines.push('    void Snapshot_' + pid + '_GateEntities()');
    lines.push('    {');
    gateEntities.forEach(name => {
      lines.push('        _snap_' + name + 'Pos = (' + name + ' != null) ? ' + name + '.transform.position : _snapHidePos;');
    });
    lines.push('    }');
    lines.push('');
  }
  lines.push('}');
  return lines.join('\n');
}

function _extractResourceSections(code) {
  let mainCode = code;
  const sections = [];

  const extracts = [
    {
      regex: /    struct FormDef \{\n[\s\S]*?    int GetCarryCapacity\(\) \{ return \(_forms != null && _forms\.Length > 0\) \? _forms\[_currentFormIndex\]\.carryCapacity : 10; \}\n\n/,
      note:
        '    // NOTE: Form definitions and form-switch helpers live in GameFlowManagerMain.Resource.cs\n\n',
    },
    {
      regex: /    \/\/ \[SKELETON\] Economy system — delegated to GFM_EconomyManager \(state owner\)\n[\s\S]*?        scoreText\.text = display;\n    }\n\n/,
      note:
        '    // NOTE: Economy/resource helpers live in GameFlowManagerMain.Resource.cs\n\n',
    },
  ];

  extracts.forEach(({ regex, note }) => {
    const match = mainCode.match(regex);
    if (!match) return;
    sections.push(match[0].trimEnd());
    mainCode = mainCode.replace(regex, note);
  });

  return { main: mainCode, sections };
}

function _extractIdleKitSections(code) {
  let mainCode = code;
  const inputSections = [];
  const resourceSections = [];
  const uiSections = [];

  const extracts = [
    {
      target: inputSections,
      regex: /    \/\/ --- Player Movement \(joystick-driven\) ---\n    GFM_Joystick joystick;\n    GameObject player;\n(?:    float moveSpeed \{ get \{ return \(_forms != null && _forms\.Length > 0\) \? _forms\[_currentFormIndex\]\.moveSpeed : 5f; \} \}\n|    float moveSpeed = 5f;\n)/,
      note:
        '    // NOTE: Idle movement state lives in GameFlowManagerMain.Input.cs\n\n',
    },
    {
      target: resourceSections,
      regex: /    int carrying = 0; \/\/ generic resource count on player back\n    string carryingType = \"\"; \/\/ what resource type\n/,
      note:
        '    // NOTE: Idle carry-state lives in GameFlowManagerMain.Resource.cs\n',
    },
    {
      target: inputSections,
      regex: /    \/\/ \[SKELETON\] Tap-to-move target \(fallback for joystick\)\n    Vector3 tapMoveTarget = Vector3\.zero;\n    bool hasTapTarget = false;\n    \/\/ \[SKELETON\] Reusable buffer for per-frame move\/look vectors — avoids alloc\n    Vector3 _moveBuf = Vector3\.zero;\n/,
      note:
        '    // NOTE: Idle tap-move state lives in GameFlowManagerMain.Input.cs\n',
    },
    {
      target: resourceSections,
      regex: /    \/\/ \[SKELETON\] Batch 2 collect cooldown infra — shared across all collect templates\n    float collectCooldownInterval = [^\n]+\n    float _collectCooldown = 0f;\n    string _lastScoreText = \"\";\n\n/,
      note:
        '    // NOTE: Idle collect cooldown state lives in GameFlowManagerMain.Resource.cs\n\n',
    },
    {
      target: uiSections,
      regex: /    int gold = 0;\n\n/,
      note:
        '    // NOTE: Idle score state lives in GameFlowManagerMain.UI.cs\n\n',
    },
    {
      target: inputSections,
      regex: /    \/\/ \[SKELETON\] Move player by joystick \+ tap-to-move fallback — call in Update\(\)\n    void MovePlayer\(\)\n    \{\n[\s\S]*?    }\n\n/,
      note:
        '    // NOTE: Idle movement helpers live in GameFlowManagerMain.Input.cs\n\n',
    },
    {
      target: resourceSections,
      regex: /    \/\/ \[SKELETON\] Check if player is near a target \(proximity trigger\) — XZ sqr distance, no sqrt\/alloc\n    bool IsNear\(GameObject target, float range\)\n    \{\n[\s\S]*?    }\n\n    \/\/ \[SKELETON\] Auto-collect: when player near source, pick up resources\n    \/\/ Returns true if collected this frame\n    bool TryCollect\(GameObject source, string resType, int maxCarry, float range\)\n    \{\n[\s\S]*?    }\n\n    \/\/ \[SKELETON\] Auto-deliver: when player near machine\/sellpoint, drop off resources\n    \/\/ Returns number of items delivered\n    int TryDeliver\(GameObject target, string expectedType, float range\)\n    \{\n[\s\S]*?    }\n\n    \/\/ \[SKELETON\] Show carry stack on player back \(visual feedback\)\n    GameObject\[] carryVisuals;\n    void UpdateCarryVisuals\(\)\n    \{\n[\s\S]*?    }\n\n/,
      note:
        '    // NOTE: Idle collect/deliver helpers live in GameFlowManagerMain.Resource.cs\n\n',
    },
    {
      target: uiSections,
      regex: /    \/\/ \[SKELETON\] Gold UI update helper\n    void AddGold\(int amount\)\n    \{\n[\s\S]*?    }\n\n    \/\/ \[SKELETON\] Show floating text \(\+3 gold\) effect\n    \/\/ \[SKELETON\] Floating text — uses a pooled text element, auto-hides after delay\n    Text floatingText;\n    float floatingTextTimer = 0f;\n    void ShowFloatingText\(Vector3 worldPos, string text, Color color\)\n    \{\n[\s\S]*?    }\n\n/,
      note:
        '    // NOTE: Idle score/floating-text helpers live in GameFlowManagerMain.UI.cs\n\n',
    },
  ];

  extracts.forEach(({ target, regex, note }) => {
    const match = mainCode.match(regex);
    if (!match) return;
    target.push(match[0].trimEnd());
    mainCode = mainCode.replace(regex, note);
  });

  return { main: mainCode, inputSections, resourceSections, uiSections };
}

/**
 * Build minimal partial-class stub (Input / Resource / UI / Scene).
 * Satisfies partial-split-enforce rule; method bodies migrate in later iterations.
 */
function _buildStubPartial(name, description) {
  return [
    '// ========== AUTO-GENERATED ' + name.toUpperCase() + ' PARTIAL — ' + description + ' ==========',
    '// Add only ' + name.toLowerCase() + '-related helpers here. Keep this file focused and well-commented.',
    '',
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    // TODO_' + name.toUpperCase() + '_METHODS_START',
    '    // Reserved for ' + name.toLowerCase() + ' methods.',
    '    // TODO_' + name.toUpperCase() + '_METHODS_END',
    '}',
  ].join('\n');
}

function _buildResourcePartial(sections) {
  const lines = [];
  lines.push('// ========== AUTO-GENERATED RESOURCE PARTIAL — economy / inventory / form helpers ==========');
  lines.push('// Keep resource-facing helpers here so the main file only coordinates phase flow.');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain');
  lines.push('{');
  if (Array.isArray(sections) && sections.length > 0) {
    sections.forEach((section, index) => {
      if (index > 0) lines.push('');
      lines.push(section);
    });
    lines.push('');
  }
  lines.push('    // TODO_RESOURCE_METHODS_START');
  lines.push('    // Reserved for resource, inventory, and form-specific methods.');
  lines.push('    // TODO_RESOURCE_METHODS_END');
  lines.push('}');
  return lines.join('\n');
}

function _buildInputPartial(sections) {
  const lines = [];
  lines.push('// ========== AUTO-GENERATED INPUT PARTIAL — player movement / tap handling helpers ==========');
  lines.push('// Keep input-facing helpers here so the main file stays focused on phase orchestration.');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain');
  lines.push('{');
  if (Array.isArray(sections) && sections.length > 0) {
    sections.forEach((section, index) => {
      if (index > 0) lines.push('');
      lines.push(section);
    });
    lines.push('');
  }
  lines.push('    // TODO_INPUT_METHODS_START');
  lines.push('    // Reserved for input-specific methods.');
  lines.push('    // TODO_INPUT_METHODS_END');
  lines.push('}');
  return lines.join('\n');
}

function _buildScenePartial() {
  return [
    '// ========== AUTO-GENERATED SCENE PARTIAL — entity placement / lifecycle helpers ==========',
    '// Keep scene-facing helpers here so the main file stays focused on flow orchestration.',
    '',
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    // Place a pooled scene object at a concrete world position.',
    '    void PlaceObj(GameObject obj, float x, float y, float z)',
    '    {',
    '        if (obj == null) return;',
    '        var pos = obj.transform.position;',
    '        pos.x = x; pos.y = y; pos.z = z;',
    '        obj.transform.position = pos;',
    '    }',
    '',
    '    // Hide a pooled scene object by moving it below the playable camera range.',
    '    void HideObj(GameObject obj)',
    '    {',
    '        if (obj == null) return;',
    '        var pos = obj.transform.position;',
    '        pos.x = 0f; pos.y = -999f; pos.z = 0f;',
    '        obj.transform.position = pos;',
    '    }',
    '',
    '    // Apply a non-uniform scene scale to a pooled object.',
    '    void SetScale(GameObject obj, float x, float y, float z)',
    '    {',
    '        if (obj == null) return;',
    '        var s = obj.transform.localScale;',
    '        s.x = x; s.y = y; s.z = z;',
    '        obj.transform.localScale = s;',
    '    }',
    '',
    '    // Apply a uniform scene scale to a pooled object.',
    '    void SetScale(GameObject obj, float uniform)',
    '    {',
    '        if (obj == null) return;',
    '        var s = obj.transform.localScale;',
    '        s.x = uniform; s.y = uniform; s.z = uniform;',
    '        obj.transform.localScale = s;',
    '    }',
    '}',
  ].join('\n');
}

function _buildUiPartial(specs, entityList, helperSections = []) {
  const lines = [];
  lines.push('// ========== AUTO-GENERATED UI PARTIAL — CTA / HUD / exported preview state ==========');
  lines.push('// Keep UI-facing helpers here so the main file only orchestrates when they are called.');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('using UnityEngine.UI;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain');
  lines.push('{');
  if (Array.isArray(helperSections) && helperSections.length > 0) {
    helperSections.forEach((section, index) => {
      if (index > 0) lines.push('');
      lines.push(section);
    });
    lines.push('');
  }
  lines.push('    // Trigger the final CTA directly when the game-end gate succeeds.');
  lines.push('    void ShowCTA()');
  lines.push('    {');
  lines.push('        Luna.Unity.Playable.InstallFullGame();');
  lines.push('    }');
  lines.push('');
  lines.push('    // Serialize current runtime state for preview polling / CUA verification.');
  lines.push('    void UpdateGameState()');
  lines.push('    {');
  lines.push('        string completedJson = "[";');
  lines.push('        for (int i = 0; i < completedPhaseCount; i++)');
  lines.push('        {');
  lines.push('            if (i > 0) completedJson += ",";');
  lines.push('            completedJson += "\\"" + completedPhases[i] + "\\"";');
  lines.push('        }');
  lines.push('        completedJson += "]";');
  lines.push('');
  lines.push('        string json = "{"');
  lines.push('            + "\\"currentPhase\\":\\"" + currentPhaseName + "\\","');
  lines.push('            + "\\"completedPhases\\":" + completedJson + ","');
  lines.push('            + "\\"entityStates\\":{');
  entityList.forEach((name, i) => {
    const comma = i < entityList.length - 1 ? ',' : '';
    lines.push(`            + "\\"${name}\\":\\"" + ${name}State + "\\"${comma}"`);
  });
  lines.push('            + "},"');
  lines.push('            + "\\"variables\\":{');
  lines.push('            + "\\"gameTimer\\":" + (int)gameTimer');
  lines.push('            + ",\\"autoPlayMode\\":" + (_autoPlayMode ? "true" : "false")');
  lines.push('            + ",\\"autoPlaySteps\\":" + _autoPlaySteps');
  lines.push('            + ",\\"autoPlayStepsThisPhase\\":" + (_autoPlaySteps - _autoPlayStepsAtPhaseStart)');
  lines.push('            // TODO: AI adds game-specific variables here (gold, wood, ammo, etc.)');
  lines.push('            + "}"');
  lines.push('            + ",\\"phaseTimestamps\\":{');
  specs.forEach((spec, i) => {
    const comma = i < specs.length - 1 ? ',' : '';
    lines.push(`            + "\\"${spec.phaseId}\\":" + (phaseEnterTimes[${i}] > 0 ? (int)phaseEnterTimes[${i}] : 0) + "${comma}"`);
  });
  lines.push('            + "}"');
  lines.push('            + "}";');
  lines.push('');
  lines.push('        gameObject.name = "GFM|" + json;');
  lines.push('    }');
  lines.push('');
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
