# Complexity Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a three-layer defense system that prevents overly complex storyboards from overwhelming the AI codegen, by: (1) writing guidelines doc, (2) expanding the skeleton with form-switch & economy kits, (3) adding two pipeline gates (complexity scoring + method completeness check).

**Architecture:** Layer 1 is a documentation artifact (storyboard writing guide). Layer 2 modifies the skeleton generator to pre-build form-switching and resource-economy code so AI fills value tables instead of writing logic. Layer 3 inserts two new pipeline stages: a complexity gate between spec-validate and codegen, and a method-completeness check after codegen that injects feedback into the fix loop.

**Tech Stack:** Node.js (CommonJS modules, `require()`), C# code generation (string concatenation in skeleton-generator.cjs), SQLite (task_history), Doubao LLM (spec simplification).

**Spec:** `/opt/blueprint-editor/docs/superpowers/specs/2026-04-16-complexity-control-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/storyboard-writing-guide.md` | CREATE | Layer 1: Writing guidelines + budget table template |
| `engine/stages/complexity-gate.cjs` | CREATE | Layer 3 Gate 1: Complexity scoring + LLM auto-simplification |
| `engine/stages/method-check.cjs` | CREATE | Layer 3 Gate 2: Method completeness scanning |
| `adapters/skeleton-generator.cjs` | MODIFY | Layer 2: Add FormDef + SwitchForm + ResourceDef + economy kit |
| `engine/pipeline.cjs` | MODIFY | Wire new stages into pipeline |
| `adapters/spec-extractor.cjs` | MODIFY | Extract formSwitch/isPlayerForm from storyboard |
| `worker/prompt-v5-basetemplate.js` | MODIFY | Document new skeleton methods for AI |
| `test/stage-regression.cjs` | MODIFY | Add test runner support for new stages |
| `fixtures/complexity-gate/` | CREATE | Test fixtures for complexity scoring |
| `fixtures/method-check/` | CREATE | Test fixtures for method completeness |

---

### Task 1: Storyboard Writing Guide (Layer 1)

**Files:**
- Create: `docs/storyboard-writing-guide.md`

- [ ] **Step 1: Write the storyboard writing guide**

Create `/opt/blueprint-editor/docs/storyboard-writing-guide.md` with:

```markdown
# Storyboard Writing Guide

## Core Concept: Visual Frame != Code Phase

- **Visual Frame**: Each shot/camera angle in the storyboard. Unlimited count.
- **Code Phase**: Actual stage in generated code. **Max 10**.
- Multiple visual frames can map to one code phase (sequential shots within one stage).

## Complexity Budget Table (Required)

Every storyboard MUST include this table:

| Dimension | Budget | Weight | Your Value |
|---|---|---|---|
| Code Phases | soft <=10 | x10 | |
| Control Modes | soft <=2 | x40 | |
| Economic Layers | no hard cap | x20 | |
| Stateful Entities | soft <=8 | x5 | |
| Form Switches | soft <=3 | x15 | |
| **Total** | **<=200 safe / <=250 warn / >250 blocked** | | |

Formula: `(phases*10) + (modes*40) + (econ*20) + (entities*5) + (forms*15)`

## Four Hard Rules

1. **One control mode runs the whole game** — Form switches change visuals and stats only, not control scheme
2. **Merge similar entities** — Drill/CrusherCar/HydraulicCar = 1 entity with 3-level state
3. **Draw economic chain diagram** — ResourceA -> ResourceB -> Consumption. Layer count feeds budget
4. **Tag every frame with phaseId** — Mark which frames share the same code phase

## Frame-to-Phase Mapping Template

| Visual Frame | Code Phase | Notes |
|---|---|---|
| Frame 1: Tutorial | phase_1_tutorial | - |
| Frame 2: First collect | phase_1_tutorial | Same phase, second shot |
| Frame 3: Sell at base | phase_2_sell | New phase |

## What Counts as a Control Mode

- Drag-to-move (joystick/tap): 1 mode
- Click-to-build/upgrade: NOT a separate mode (point interaction)
- Vehicle driving: NOT separate IF using form-switch (same drag-to-move, different stats)
- Tower defense placement: 1 mode (drag-and-drop)
- Swipe/gesture: 1 mode

## Economic Layer Examples

- 1 layer: Mine -> Gold -> Buy buildings
- 2 layers: Chop trees -> Planks -> Gold -> Buy buildings
- 3 layers: Mine ore -> Smelt ingots -> Sell ingots -> Gold -> Buy buildings
```

- [ ] **Step 2: Commit**

```bash
cd /opt/blueprint-editor
git add docs/storyboard-writing-guide.md
git commit -m "docs: add storyboard writing guide with complexity budget table"
```

---

### Task 2: Complexity Gate Stage (Layer 3, Gate 1)

**Files:**
- Create: `engine/stages/complexity-gate.cjs`
- Create: `fixtures/complexity-gate/over-budget.json`
- Create: `fixtures/complexity-gate/safe.json`
- Modify: `test/stage-regression.cjs`

- [ ] **Step 1: Write test fixtures**

Create `/opt/blueprint-editor/fixtures/complexity-gate/over-budget.json`:

```json
{
  "description": "11 phases, 3 control modes, 3 econ layers, 12 entities, 2 form switches = 380 (>250, should trigger simplification)",
  "input": {
    "specs": [
      {"phaseId":"p1","requiredInteractions":["move_to:garbage","collect:scrap"],"entitiesRequired":[{"name":"Player","terminalState":0},{"name":"SpaceGarbage","terminalState":2}]},
      {"phaseId":"p2","requiredInteractions":["move_to:station","deliver:scrap"],"entitiesRequired":[{"name":"SpaceStation","terminalState":0}]},
      {"phaseId":"p3","requiredInteractions":["click:forge","spend:gold:100","build:forge"],"entitiesRequired":[{"name":"ForgeWorkshop","terminalState":2}]},
      {"phaseId":"p4","requiredInteractions":["click:drill","spend:gold:50","upgrade:drill"],"entitiesRequired":[{"name":"TripleDrill","terminalState":2}]},
      {"phaseId":"p5","requiredInteractions":["move_to:garbage","collect:scrap"],"entitiesRequired":[]},
      {"phaseId":"p6","requiredInteractions":["click:crusher","spend:gold:300","upgrade:crusher"],"entitiesRequired":[{"name":"CrusherCar","terminalState":2}],"formSwitch":"crusherCar"},
      {"phaseId":"p7","requiredInteractions":["drive:crusher","collect:scrap"],"entitiesRequired":[]},
      {"phaseId":"p8","requiredInteractions":["click:hydraulic","spend:gold:500","upgrade:hydraulic"],"entitiesRequired":[{"name":"HydraulicCar","terminalState":2}],"formSwitch":"hydraulicCar"},
      {"phaseId":"p9","requiredInteractions":["drive:hydraulic","collect:scrap"],"entitiesRequired":[]},
      {"phaseId":"p10","requiredInteractions":["click:cabin","spend:gold:300","build:cabin"],"entitiesRequired":[{"name":"CabinModule","terminalState":2}]},
      {"phaseId":"p11","requiredInteractions":["click:cta"],"entitiesRequired":[{"name":"CTAButton","terminalState":1}]}
    ],
    "entities": [
      {"name":"Player"},{"name":"SpaceGarbage","terminalState":2},
      {"name":"SpaceStation"},{"name":"ForgeWorkshop","terminalState":2},
      {"name":"TripleDrill","terminalState":2},{"name":"CrusherCar","terminalState":2},
      {"name":"HydraulicCar","terminalState":2},{"name":"CabinModule","terminalState":2},
      {"name":"CTAButton","terminalState":1},{"name":"MetalShard"},
      {"name":"GoldUI"},{"name":"GuideUI"}
    ]
  },
  "expectedResult": {
    "action": "simplify",
    "scoreMustExceed": 250
  }
}
```

Create `/opt/blueprint-editor/fixtures/complexity-gate/safe.json`:

```json
{
  "description": "8 phases, 1 control mode, 1 econ layer, 6 entities, 1 form switch = 155 (<=200, safe)",
  "input": {
    "specs": [
      {"phaseId":"p1","requiredInteractions":["move_to:tree","collect:wood"],"entitiesRequired":[{"name":"Player","terminalState":0},{"name":"Tree","terminalState":2}]},
      {"phaseId":"p2","requiredInteractions":["move_to:sawmill","deliver:wood"],"entitiesRequired":[{"name":"Sawmill","terminalState":0}]},
      {"phaseId":"p3","requiredInteractions":["click:house","spend:gold:50","build:house"],"entitiesRequired":[{"name":"House","terminalState":2}]},
      {"phaseId":"p4","requiredInteractions":["click:axe","spend:gold:30","upgrade:axe"],"entitiesRequired":[{"name":"Axe","terminalState":2}]},
      {"phaseId":"p5","requiredInteractions":["move_to:tree","collect:wood"],"entitiesRequired":[]},
      {"phaseId":"p6","requiredInteractions":["click:barn","spend:gold:100","build:barn"],"entitiesRequired":[{"name":"Barn","terminalState":2}],"formSwitch":"cart"},
      {"phaseId":"p7","requiredInteractions":["move_to:tree","collect:wood"],"entitiesRequired":[]},
      {"phaseId":"p8","requiredInteractions":["click:cta"],"entitiesRequired":[]}
    ],
    "entities": [
      {"name":"Player"},{"name":"Tree","terminalState":2},
      {"name":"Sawmill"},{"name":"House","terminalState":2},
      {"name":"Axe","terminalState":2},{"name":"Barn","terminalState":2}
    ]
  },
  "expectedResult": {
    "action": "pass",
    "scoreMustNotExceed": 200
  }
}
```

- [ ] **Step 2: Implement complexity-gate.cjs**

Create `/opt/blueprint-editor/engine/stages/complexity-gate.cjs`:

```javascript
// Source: engine/stages/complexity-gate.cjs
/**
 * Stage: complexity-gate — Score spec complexity before codegen
 *
 * Scores based on: phases, control modes, econ layers, entities, form switches.
 * <= 200: pass. 201-250: warn. > 250: auto-simplify via LLM, then re-score.
 *
 * Reads: ctx.blueprint.specs, ctx.blueprint.entities
 * Writes: ctx.blueprint.complexityScore, ctx.blueprint.specs (if simplified)
 */

var THRESHOLDS = { SAFE: 200, WARN: 250 };
var WEIGHTS = { phase: 10, controlMode: 40, econLayer: 20, entity: 5, formSwitch: 15 };

// --- Dimension counters ---

function countControlModes(specs) {
  var hasMoveTo = false;
  var hasDrive = false;
  for (var i = 0; i < specs.length; i++) {
    var interactions = specs[i].requiredInteractions || [];
    for (var j = 0; j < interactions.length; j++) {
      var verb = String(interactions[j]).split(':')[0];
      if (verb === 'move_to' || verb === 'drag') hasMoveTo = true;
      if (verb === 'drive' || verb === 'steer') hasDrive = true;
    }
  }
  var count = 0;
  if (hasMoveTo) count++;
  if (hasDrive) count++;
  // click/build/upgrade/spend are point interactions, not separate control modes
  return Math.max(count, 1); // at least 1
}

function countEconLayers(specs) {
  // Build resource flow graph from interactions: collect:X, deliver:X, convert:X:Y, spend:X
  var sources = new Set();   // collected resources
  var sinks = new Set();     // spent resources
  var conversions = 0;
  for (var i = 0; i < specs.length; i++) {
    var interactions = specs[i].requiredInteractions || [];
    for (var j = 0; j < interactions.length; j++) {
      var parts = String(interactions[j]).split(':');
      var verb = parts[0];
      if (verb === 'collect') sources.add(parts[1] || 'resource');
      if (verb === 'spend') sinks.add(parts[1] || 'gold');
      if (verb === 'deliver' || verb === 'convert') conversions++;
    }
  }
  // layers = number of conversion steps between source and sink
  // Heuristic: if collect + deliver + spend all appear, that's at least 2 layers
  if (sources.size > 0 && conversions > 0 && sinks.size > 0) {
    return Math.min(conversions, 4); // cap at 4
  }
  if (sources.size > 0 && sinks.size > 0) return 1;
  return 0;
}

function countFormSwitches(specs) {
  var count = 0;
  for (var i = 0; i < specs.length; i++) {
    if (specs[i].formSwitch) count++;
  }
  return count;
}

function countStatefulEntities(entities) {
  var count = 0;
  for (var i = 0; i < (entities || []).length; i++) {
    if (entities[i].terminalState && entities[i].terminalState > 0) count++;
  }
  return count;
}

// --- Scoring ---

function computeScore(specs, entities) {
  var breakdown = {
    codePhases: specs.length,
    controlModes: countControlModes(specs),
    econLayers: countEconLayers(specs),
    statefulEntities: countStatefulEntities(entities),
    formSwitches: countFormSwitches(specs),
  };
  var total =
    breakdown.codePhases * WEIGHTS.phase +
    breakdown.controlModes * WEIGHTS.controlMode +
    breakdown.econLayers * WEIGHTS.econLayer +
    breakdown.statefulEntities * WEIGHTS.entity +
    breakdown.formSwitches * WEIGHTS.formSwitch;
  return { breakdown: breakdown, total: total };
}

// --- Auto-simplification ---

function buildSimplifyPrompt(specs, breakdown, total) {
  var lines = [];
  lines.push('你是试玩广告规格优化器。当前 specs 复杂度评分 ' + total + '，超出上限 ' + THRESHOLDS.WARN + '。');
  lines.push('');
  lines.push('超标维度:');
  lines.push('- codePhases: ' + breakdown.codePhases + ' (贡献 ' + (breakdown.codePhases * WEIGHTS.phase) + ' 分)');
  lines.push('- controlModes: ' + breakdown.controlModes + ' (贡献 ' + (breakdown.controlModes * WEIGHTS.controlMode) + ' 分)');
  lines.push('- econLayers: ' + breakdown.econLayers + ' (贡献 ' + (breakdown.econLayers * WEIGHTS.econLayer) + ' 分)');
  lines.push('- statefulEntities: ' + breakdown.statefulEntities + ' (贡献 ' + (breakdown.statefulEntities * WEIGHTS.entity) + ' 分)');
  lines.push('- formSwitches: ' + breakdown.formSwitches + ' (贡献 ' + (breakdown.formSwitches * WEIGHTS.formSwitch) + ' 分)');
  lines.push('');
  lines.push('可用简化策略（按优先级）:');
  lines.push('1. 合并"升级X → 用X采集"为单 phase（保留升级视觉 + 采集演示）');
  lines.push('2. 将 drive/steer 动词改为 move_to（统一操控模式）');
  lines.push('3. 合并同类实体为多级单实体（如3种车 → 1个车 + 3级state）');
  lines.push('');
  lines.push('约束:');
  lines.push('- 不得删除最后一个 phase（CTA）');
  lines.push('- 不得删除第一个 phase（教学）');
  lines.push('- 保留所有 phaseId 的语义（可合并但不丢弃叙事）');
  lines.push('- 目标: 总分 <= 230（留 20 分余量）');
  lines.push('');
  lines.push('输出: 简化后的 specs JSON 数组，格式与输入完全一致。只输出 JSON，不要解释。');
  lines.push('');
  lines.push('输入 specs:');
  lines.push(JSON.stringify(specs, null, 2));
  return lines.join('\n');
}

// --- Stage export ---

module.exports = {
  name: 'complexity-gate',
  canRetry: false,
  canSkip: function(ctx) {
    return !ctx.blueprint.specs || ctx.blueprint.specs.length === 0;
  },

  // Exported for testing
  computeScore: computeScore,
  countControlModes: countControlModes,
  countEconLayers: countEconLayers,
  countFormSwitches: countFormSwitches,
  countStatefulEntities: countStatefulEntities,
  THRESHOLDS: THRESHOLDS,
  WEIGHTS: WEIGHTS,

  execute: function(ctx) {
    ctx.addLog('complexity-gate', 'Scoring spec complexity...');
    var specs = ctx.blueprint.specs;
    var entities = ctx.blueprint.entities || [];
    var result = computeScore(specs, entities);
    ctx.blueprint.complexityScore = result;

    ctx.addLog('complexity-gate', 'Score: ' + result.total + ' (phases=' + result.breakdown.codePhases +
      ', modes=' + result.breakdown.controlModes + ', econ=' + result.breakdown.econLayers +
      ', entities=' + result.breakdown.statefulEntities + ', forms=' + result.breakdown.formSwitches + ')');

    if (result.total <= THRESHOLDS.SAFE) {
      ctx.addLog('complexity-gate', 'PASS — safe zone (' + result.total + ' <= ' + THRESHOLDS.SAFE + ')');
      return Promise.resolve();
    }

    if (result.total <= THRESHOLDS.WARN) {
      ctx.addLog('complexity-gate', 'WARN — warning zone (' + result.total + ' <= ' + THRESHOLDS.WARN + ')');
      return Promise.resolve();
    }

    // > 250: auto-simplify
    ctx.addLog('complexity-gate', 'OVER BUDGET (' + result.total + ' > ' + THRESHOLDS.WARN + ') — invoking LLM auto-simplification...');
    ctx.reportStatus('processing', { message: 'Spec complexity over budget (' + result.total + '), auto-simplifying...' });

    var prompt = buildSimplifyPrompt(specs, result.breakdown, result.total);

    // Use the same LLM provider as spec-extractor (Doubao)
    var callLLM = ctx.callLLM || ctx.blueprint._callLLM;
    if (!callLLM) {
      throw new Error('complexity-gate: No LLM provider available for auto-simplification. Score ' + result.total + ' exceeds threshold ' + THRESHOLDS.WARN + '.');
    }

    return callLLM({ role: 'user', content: prompt }, { model: 'spec' }).then(function(response) {
      var text = (response && response.content) || (response && response.text) || '';
      // Extract JSON from response
      var jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('complexity-gate: LLM simplification returned no valid JSON. Manual simplification required. Score: ' + result.total);
      }
      var simplified;
      try { simplified = JSON.parse(jsonMatch[0]); } catch(e) {
        throw new Error('complexity-gate: LLM simplification returned invalid JSON: ' + e.message);
      }

      // Re-score
      var newResult = computeScore(simplified, entities);
      ctx.addLog('complexity-gate', 'Simplified score: ' + newResult.total + ' (was ' + result.total + ')');

      if (newResult.total > THRESHOLDS.WARN) {
        throw new Error('complexity-gate: Auto-simplification insufficient. Score ' + newResult.total + ' still exceeds ' + THRESHOLDS.WARN + '. Manual simplification required.');
      }

      // Apply simplified specs
      ctx.blueprint.specs = simplified;
      ctx.blueprint.complexityScore = newResult;
      ctx.blueprint.autoSimplified = {
        originalScore: result.total,
        newScore: newResult.total,
        originalPhaseCount: specs.length,
        newPhaseCount: simplified.length,
      };
      ctx.addLog('complexity-gate', 'Auto-simplified: ' + specs.length + ' phases -> ' + simplified.length + ' phases');
    });
  },
};
```

- [ ] **Step 3: Run test to verify scoring logic**

```bash
cd /opt/blueprint-editor
node -e "
var cg = require('./engine/stages/complexity-gate.cjs');
var fix = require('./fixtures/complexity-gate/over-budget.json');
var r = cg.computeScore(fix.input.specs, fix.input.entities);
console.log('Over-budget score:', r.total, '(expect >250):', r.total > 250 ? 'PASS' : 'FAIL');
var fix2 = require('./fixtures/complexity-gate/safe.json');
var r2 = cg.computeScore(fix2.input.specs, fix2.input.entities);
console.log('Safe score:', r2.total, '(expect <=200):', r2.total <= 200 ? 'PASS' : 'FAIL');
"
```

Expected: Both PASS.

- [ ] **Step 4: Commit**

```bash
cd /opt/blueprint-editor
git add engine/stages/complexity-gate.cjs fixtures/complexity-gate/
git commit -m "feat: add complexity-gate stage with scoring and auto-simplification"
```

---

### Task 3: Method Completeness Check (Layer 3, Gate 2)

**Files:**
- Create: `engine/stages/method-check.cjs`
- Create: `fixtures/method-check/missing-methods.json`
- Create: `fixtures/method-check/complete.json`

- [ ] **Step 1: Write test fixtures**

Create `/opt/blueprint-editor/fixtures/method-check/missing-methods.json`:

```json
{
  "description": "Code calls HandleInteractiveClicks and UpdateUI in Update but never defines them",
  "input": {
    "csCode": "void Update() {\n  MovePlayer();\n  HandleInteractiveClicks();\n  UpdateShardVisual();\n  UpdateUI();\n  CheckEventRules();\n}\nvoid Start() {}\nvoid MovePlayer() {}\nvoid CheckEventRules() {}"
  },
  "expectedResult": {
    "missing": ["HandleInteractiveClicks", "UpdateShardVisual", "UpdateUI"]
  }
}
```

Create `/opt/blueprint-editor/fixtures/method-check/complete.json`:

```json
{
  "description": "All methods called in Update are defined or in safe list",
  "input": {
    "csCode": "void Update() {\n  MovePlayer();\n  TryCollect();\n  CheckEventRules();\n  float d = Vector3.Distance(a,b);\n  GameObject.Find(\"x\");\n}\nvoid Start() {}\nvoid MovePlayer() {}\nvoid TryCollect() {}\nvoid CheckEventRules() {}"
  },
  "expectedResult": {
    "missing": []
  }
}
```

- [ ] **Step 2: Implement method-check.cjs**

Create `/opt/blueprint-editor/engine/stages/method-check.cjs`:

```javascript
// Source: engine/stages/method-check.cjs
/**
 * Stage: method-check — Verify all methods called in Update/CheckEventRules are defined
 *
 * Does NOT block pipeline. Injects missing method names as feedback for codegen fix-loop.
 *
 * Reads: ctx.csCode
 * Writes: ctx.blueprint.feedbackHistory (appends if missing methods found)
 */

// Skeleton-provided methods that AI can call without defining
var SKELETON_SAFE = [
  'MovePlayer', 'TryCollect', 'TryDeliver', 'UpdateCarryVisuals',
  'SwitchForm', 'GetCollectPower', 'GetCollectRange', 'GetCarryCapacity',
  'AddResource', 'TryConvert', 'TrySpend', 'UpdateResourceUI',
  'PlaceObj', 'HideObj', 'SetScale', 'ShowCTA', 'AddCompletedPhase',
  'ReportPhase', 'UpdateGameState', 'ShowFloatingText', 'AddGold',
  'IsNear', 'AutoPlayUpdate', 'OnAutoPlayArrive',
];

// Unity/C# built-in method patterns (called as static or instance methods)
var UNITY_PREFIXES = [
  'Vector3', 'Vector2', 'Quaternion', 'Mathf', 'Input', 'Debug',
  'Camera', 'Physics', 'GameObject', 'Transform', 'Color', 'Time',
  'Random', 'String', 'Math', 'Convert', 'GFM_Create', 'GFM_UI', 'GFM_Luna',
];

function extractMethodDefinitions(csCode) {
  var defs = new Set();
  // Match: void/int/float/bool/string/IEnumerator MethodName(
  // Also match: Type[] MethodName(, Type<T> MethodName(
  var re = /(?:void|int|float|bool|string|double|long|char|IEnumerator|FormDef|ResourceDef|\w+[\[\]<>]*)\s+([A-Z_]\w*)\s*\(/g;
  var m;
  while ((m = re.exec(csCode)) !== null) {
    defs.add(m[1]);
  }
  return defs;
}

function extractMethodCalls(csCode, scopeMethods) {
  var calls = new Set();
  // Find the body of each scope method
  for (var s = 0; s < scopeMethods.length; s++) {
    var methodName = scopeMethods[s];
    var startPattern = new RegExp('void\\s+' + methodName + '\\s*\\([^)]*\\)\\s*\\{');
    var startMatch = startPattern.exec(csCode);
    if (!startMatch) continue;

    // Find matching closing brace
    var depth = 1;
    var pos = startMatch.index + startMatch[0].length;
    while (pos < csCode.length && depth > 0) {
      if (csCode[pos] === '{') depth++;
      if (csCode[pos] === '}') depth--;
      pos++;
    }
    var body = csCode.substring(startMatch.index + startMatch[0].length, pos - 1);

    // Extract method calls: word followed by (
    var callRe = /\b([A-Z_]\w*)\s*\(/g;
    var cm;
    while ((cm = callRe.exec(body)) !== null) {
      // Skip C# keywords and control flow
      var name = cm[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'typeof', 'sizeof', 'new', 'return'].indexOf(name) === -1) {
        calls.add(name);
      }
    }
  }
  return calls;
}

function checkCompleteness(csCode) {
  var defined = extractMethodDefinitions(csCode);
  var called = extractMethodCalls(csCode, ['Update', 'CheckEventRules']);

  var safeSet = new Set(SKELETON_SAFE);

  var missing = [];
  called.forEach(function(name) {
    if (defined.has(name)) return;
    if (safeSet.has(name)) return;
    // Check unity prefixes (e.g., Vector3 in Vector3.Distance)
    for (var i = 0; i < UNITY_PREFIXES.length; i++) {
      if (name === UNITY_PREFIXES[i] || name.indexOf(UNITY_PREFIXES[i]) === 0) return;
    }
    missing.push(name);
  });

  return missing;
}

module.exports = {
  name: 'method-check',
  canRetry: false,

  // Exported for testing
  checkCompleteness: checkCompleteness,
  extractMethodDefinitions: extractMethodDefinitions,
  extractMethodCalls: extractMethodCalls,
  SKELETON_SAFE: SKELETON_SAFE,

  execute: function(ctx) {
    if (!ctx.csCode) return Promise.resolve();

    ctx.addLog('method-check', 'Checking method completeness...');
    var missing = checkCompleteness(ctx.csCode);

    if (missing.length === 0) {
      ctx.addLog('method-check', 'PASS — all methods defined or in safe list');
      return Promise.resolve();
    }

    ctx.addLog('method-check', 'MISSING METHODS: ' + missing.join(', '));

    // Inject feedback for codegen fix-loop (do NOT throw — this is advisory)
    if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
    ctx.blueprint.feedbackHistory.push({
      data: {
        text: 'METHOD COMPLETENESS CHECK FAILED\n\n' +
          'The following methods are called in Update() or CheckEventRules() but have no definition:\n' +
          missing.map(function(m) { return '  - ' + m + '()'; }).join('\n') + '\n\n' +
          'You MUST either:\n' +
          '1. Implement these methods with full logic, OR\n' +
          '2. Remove the calls if the methods are not needed.\n\n' +
          'Do NOT leave method calls without definitions — this causes runtime errors and visual freeze.',
      },
      source: 'method-completeness-check',
      status: 'pending',
      timestamp: Date.now(),
    });

    return Promise.resolve();
  },
};
```

- [ ] **Step 3: Run test to verify method detection**

```bash
cd /opt/blueprint-editor
node -e "
var mc = require('./engine/stages/method-check.cjs');
var fix = require('./fixtures/method-check/missing-methods.json');
var missing = mc.checkCompleteness(fix.input.csCode);
console.log('Missing:', missing);
var expected = fix.expectedResult.missing;
var pass = missing.length === expected.length && missing.every(function(m) { return expected.indexOf(m) >= 0; });
console.log('Test:', pass ? 'PASS' : 'FAIL');

var fix2 = require('./fixtures/method-check/complete.json');
var missing2 = mc.checkCompleteness(fix2.input.csCode);
console.log('Complete missing:', missing2, '(expect []):', missing2.length === 0 ? 'PASS' : 'FAIL');
"
```

Expected: Both PASS.

- [ ] **Step 4: Commit**

```bash
cd /opt/blueprint-editor
git add engine/stages/method-check.cjs fixtures/method-check/
git commit -m "feat: add method-completeness check stage for codegen feedback injection"
```

---

### Task 4: Wire New Stages into Pipeline

**Files:**
- Modify: `engine/pipeline.cjs` (lines 358-379)

- [ ] **Step 1: Add imports and stage registration**

In `/opt/blueprint-editor/engine/pipeline.cjs`, add the two new stage imports after line 365:

```javascript
// After line 365 (var uploadStage = require('./stages/upload.cjs');)
var complexityGateStage = require('./stages/complexity-gate.cjs');
var methodCheckStage = require('./stages/method-check.cjs');
```

Update the `createLunaPipeline` stages array (lines 370-379):

```javascript
function createLunaPipeline(options) {
  return new Pipeline([
    cloneStage,
    specValidateStage,
    complexityGateStage,    // NEW: after spec-validate, before codegen
    codegenStage,
    methodCheckStage,       // NEW: after codegen, before review
    reviewStage,
    compileStage,
    visualCheckStage,
    cuaVerifyStage,
    uploadStage,
  ], options);
}
```

Update the `stages` export (lines 398-407):

```javascript
stages: {
  clone: cloneStage,
  specValidate: specValidateStage,
  complexityGate: complexityGateStage,   // NEW
  codegen: codegenStage,
  methodCheck: methodCheckStage,         // NEW
  review: reviewStage,
  compile: compileStage,
  visualCheck: visualCheckStage,
  cuaVerify: cuaVerifyStage,
  upload: uploadStage,
},
```

- [ ] **Step 2: Verify pipeline loads without errors**

```bash
cd /opt/blueprint-editor
node -e "var p = require('./engine/pipeline.cjs'); console.log('Stages:', Object.keys(p.stages)); console.log('Luna pipeline stages:', p.createLunaPipeline({}).stages.map(function(s){return s.name}));"
```

Expected output includes `complexity-gate` between `spec-validate` and `codegen`, and `method-check` between `codegen` and `review`.

- [ ] **Step 3: Commit**

```bash
cd /opt/blueprint-editor
git add engine/pipeline.cjs
git commit -m "feat: wire complexity-gate and method-check stages into pipeline"
```

---

### Task 5: Skeleton Form-Switch Kit (Layer 2)

**Files:**
- Modify: `adapters/skeleton-generator.cjs` (lines 139-150 entity states, 198-292 idle kit)

This is the most complex task. The skeleton generator builds C# code via string concatenation. We need to inject the FormDef struct and SwitchForm method into the idle game kit section.

- [ ] **Step 1: Read current skeleton code for exact insertion points**

```bash
cd /opt/blueprint-editor
node -e "
var fs = require('fs');
var code = fs.readFileSync('adapters/skeleton-generator.cjs', 'utf8');
var lines = code.split('\n');
// Find idle game kit boundaries
for (var i = 0; i < lines.length; i++) {
  if (lines[i].indexOf('MovePlayer') >= 0 || lines[i].indexOf('isIdleGame') >= 0 ||
      lines[i].indexOf('TryCollect') >= 0 || lines[i].indexOf('TODO_VARIABLES') >= 0) {
    console.log((i+1) + ': ' + lines[i].substring(0, 120));
  }
}
"
```

This confirms exact line numbers before editing.

- [ ] **Step 2: Add form-switch detection logic**

After the `isIdleGame` detection (around line 201), add form-switch detection:

```javascript
// Detect form switches in specs
var hasFormSwitch = specs.some(function(s) { return !!s.formSwitch; });
var formSwitchCount = specs.filter(function(s) { return !!s.formSwitch; }).length;
```

- [ ] **Step 3: Add FormDef struct and SwitchForm to skeleton output**

In the entity state variable section (around line 139-150), after the entity state declarations, add the FormDef system when `hasFormSwitch` is true:

```javascript
if (hasFormSwitch) {
  lines.push('');
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
  lines.push('            newObj.transform.position = playerObj != null ? playerObj.transform.position : Vector3.zero;');
  lines.push('            newObj.transform.localScale = Vector3.one * _forms[_currentFormIndex].scale;');
  lines.push('        }');
  lines.push('    }');
}
```

- [ ] **Step 4: Update MovePlayer to read from current form**

In the existing `MovePlayer()` method (around line 220-262), wrap the speed reference:

Where the skeleton currently has a hardcoded `moveSpeed` (e.g., `float speed = 3.5f;`), change to:

```javascript
// If form-switch is active, use form stats; otherwise use hardcoded default
if (hasFormSwitch) {
  lines.push('        float speed = (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].moveSpeed : 3.5f;');
} else {
  lines.push('        float speed = 3.5f;');
}
```

Apply same pattern for `TryCollect` (collectRange, collectPower) and `TryDeliver`.

- [ ] **Step 5: Verify skeleton generates valid C# with form-switch**

```bash
cd /opt/blueprint-editor
node -e "
var gen = require('./adapters/skeleton-generator.cjs');
var specs = [
  {phaseId:'p1', requiredInteractions:['move_to:tree','collect:wood'], entitiesRequired:[{name:'Tree',terminalState:2}]},
  {phaseId:'p2', requiredInteractions:['click:sawmill','build:sawmill'], entitiesRequired:[{name:'Sawmill',terminalState:2}], formSwitch:'cart'},
  {phaseId:'p3', requiredInteractions:['click:cta'], entitiesRequired:[]},
];
var entities = [{name:'Tree',terminalState:2},{name:'Sawmill',terminalState:2}];
var result = gen.generate({specs:specs, entities:entities, globalSettings:{gameType:'idle'}});
var code = typeof result === 'string' ? result : result.main;
console.log('Has FormDef:', code.indexOf('FormDef') >= 0);
console.log('Has SwitchForm:', code.indexOf('SwitchForm') >= 0);
console.log('Line count:', code.split('\n').length);
"
```

Expected: `Has FormDef: true`, `Has SwitchForm: true`.

- [ ] **Step 6: Commit**

```bash
cd /opt/blueprint-editor
git add adapters/skeleton-generator.cjs
git commit -m "feat: add form-switch kit to skeleton generator (data-driven form switching)"
```

---

### Task 6: Skeleton Economy Kit (Layer 2)

**Files:**
- Modify: `adapters/skeleton-generator.cjs`

- [ ] **Step 1: Add economy detection logic**

After the form-switch detection, add:

```javascript
var hasEconomy = specs.some(function(s) {
  return (s.requiredInteractions || []).some(function(i) {
    var verb = String(i).split(':')[0];
    return verb === 'collect' || verb === 'deliver' || verb === 'spend' || verb === 'convert';
  });
});
```

- [ ] **Step 2: Add ResourceDef struct and economy methods**

After the FormDef section (or after entity states if no form-switch), add:

```javascript
if (hasEconomy) {
  lines.push('');
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
}
```

- [ ] **Step 3: Verify economy kit generates valid C#**

```bash
cd /opt/blueprint-editor
node -e "
var gen = require('./adapters/skeleton-generator.cjs');
var specs = [
  {phaseId:'p1', requiredInteractions:['move_to:tree','collect:wood'], entitiesRequired:[{name:'Tree',terminalState:2}]},
  {phaseId:'p2', requiredInteractions:['move_to:sawmill','deliver:wood','spend:gold:50'], entitiesRequired:[{name:'Sawmill',terminalState:2}]},
  {phaseId:'p3', requiredInteractions:['click:cta'], entitiesRequired:[]},
];
var entities = [{name:'Tree',terminalState:2},{name:'Sawmill',terminalState:2}];
var result = gen.generate({specs:specs, entities:entities, globalSettings:{gameType:'idle'}});
var code = typeof result === 'string' ? result : result.main;
console.log('Has ResourceDef:', code.indexOf('ResourceDef') >= 0);
console.log('Has TrySpend:', code.indexOf('TrySpend') >= 0);
console.log('Has TryConvert:', code.indexOf('TryConvert') >= 0);
console.log('Has AddResource:', code.indexOf('AddResource') >= 0);
"
```

Expected: All `true`.

- [ ] **Step 4: Commit**

```bash
cd /opt/blueprint-editor
git add adapters/skeleton-generator.cjs
git commit -m "feat: add economy kit to skeleton generator (data-driven resource system)"
```

---

### Task 7: Update Spec Extractor for Form Switch Fields

**Files:**
- Modify: `adapters/spec-extractor.cjs` (lines 44-77 schema, 218-236 mapping)

- [ ] **Step 1: Read current spec extractor for exact edit points**

Read `/opt/blueprint-editor/adapters/spec-extractor.cjs` lines 40-80 (schema) and 215-240 (mapping).

- [ ] **Step 2: Add formSwitch field to SYSTEM_PROMPT output schema**

In the SYSTEM_PROMPT JSON schema section (around line 76, after `autoAllowed`), add:

```
    "formSwitch": "string | null — 如果本阶段解锁了新的玩家形态/载具，填写形态ID（如 'crusherCar'）；否则为 null"
```

- [ ] **Step 3: Add formSwitch to spec mapping**

In the spec mapping section (around line 234, after `autoAllowed`), add:

```javascript
formSwitch: spec.formSwitch || null,
```

- [ ] **Step 4: Commit**

```bash
cd /opt/blueprint-editor
git add adapters/spec-extractor.cjs
git commit -m "feat: extract formSwitch field from storyboard specs"
```

---

### Task 8: Update Prompt Template for New Skeleton Methods

**Files:**
- Modify: `worker/prompt-v5-basetemplate.js`

- [ ] **Step 1: Read current prompt template for insertion point**

Read `/opt/blueprint-editor/worker/prompt-v5-basetemplate.js` lines 200-240 (core rules section).

- [ ] **Step 2: Add form-switch and economy kit documentation**

After the idle game kit description (around line 229), add a new section:

```javascript
if (hasFormSwitch) {
  promptParts.push('\n## Form-Switch Kit (Skeleton Pre-Built)\n');
  promptParts.push('骨架已预建形态切换系统。你只需填 _forms 数组：\n');
  promptParts.push('```csharp\n');
  promptParts.push('_forms = new FormDef[] {\n');
  promptParts.push('    new FormDef { formId="形态1", poolObjectName="__Pool_...", moveSpeed=3.5f, collectRange=1.5f, collectPower=1f, carryCapacity=10, scale=1.5f },\n');
  promptParts.push('    new FormDef { formId="形态2", poolObjectName="__Pool_...", moveSpeed=5f, collectRange=3f, collectPower=5f, carryCapacity=50, scale=2.5f },\n');
  promptParts.push('};\n');
  promptParts.push('```\n');
  promptParts.push('切换形态：`SwitchForm(1);` — 在 CheckEventRules 的 phase 切换里调用\n');
  promptParts.push('MovePlayer/TryCollect 自动读取当前形态数值，你不需要写额外移动代码。\n');
  promptParts.push('**禁止** 为不同形态写独立的移动/采集方法。\n');
}

if (hasEconomy) {
  promptParts.push('\n## Economy Kit (Skeleton Pre-Built)\n');
  promptParts.push('骨架已预建资源经济系统。你只需填 _resources 数组：\n');
  promptParts.push('```csharp\n');
  promptParts.push('_resources = new ResourceDef[] {\n');
  promptParts.push('    new ResourceDef { resourceId="wood", displayName="木材", convertFrom="", convertRatio=0 },\n');
  promptParts.push('    new ResourceDef { resourceId="plank", displayName="木板", convertFrom="wood", convertRatio=2 },\n');
  promptParts.push('    new ResourceDef { resourceId="gold", displayName="金币", convertFrom="plank", convertRatio=3 },\n');
  promptParts.push('};\n');
  promptParts.push('```\n');
  promptParts.push('可用方法：AddResource(id, amount), TrySpend(id, amount), TryConvert(fromId, toId), GetResource(id)\n');
  promptParts.push('UI 自动更新（UpdateResourceUI 已预建）。\n');
  promptParts.push('**禁止** 手写 gold/wood/resource 变量和加减逻辑 — 统一用 _inventory 字典。\n');
}
```

- [ ] **Step 3: Add form-switch/economy flags to prompt context**

Where the prompt template builds the blueprint context (look for where `isIdleGame` is used), add:

```javascript
var hasFormSwitch = (ctx.blueprint.specs || []).some(function(s) { return !!s.formSwitch; });
var hasEconomy = (ctx.blueprint.specs || []).some(function(s) {
  return (s.requiredInteractions || []).some(function(i) {
    var verb = String(i).split(':')[0];
    return verb === 'collect' || verb === 'deliver' || verb === 'spend';
  });
});
```

- [ ] **Step 4: Commit**

```bash
cd /opt/blueprint-editor
git add worker/prompt-v5-basetemplate.js
git commit -m "feat: document form-switch and economy kits in AI codegen prompt"
```

---

### Task 9: Update Method-Check Safe List & Integration Test

**Files:**
- Modify: `engine/stages/method-check.cjs` (SKELETON_SAFE list)
- Modify: `test/stage-regression.cjs`

- [ ] **Step 1: Ensure SKELETON_SAFE includes all new economy/form methods**

Verify the SKELETON_SAFE array in `method-check.cjs` includes:
`SwitchForm`, `GetCollectPower`, `GetCollectRange`, `GetCarryCapacity`,
`AddResource`, `TryConvert`, `TrySpend`, `UpdateResourceUI`, `GetResource`

(Already included in Task 3, but verify no methods were missed after Task 5-6.)

- [ ] **Step 2: Add complexity-gate and method-check to test runner**

In `/opt/blueprint-editor/test/stage-regression.cjs`, add test runner functions for the new stages. Follow the existing `runStaticCheckTests()` pattern:

```javascript
function runComplexityGateTests() {
  var cg;
  try { cg = require('../engine/stages/complexity-gate.cjs'); } catch(e) {
    console.error('  Cannot load complexity-gate.cjs: ' + e.message);
    return { passed: 0, failed: 0, errors: 1 };
  }
  var testDir = path.join(fixturesDir, 'complexity-gate');
  if (!fs.existsSync(testDir)) return { passed: 0, failed: 0, errors: 0 };

  var files = fs.readdirSync(testDir).filter(function(f) { return f.endsWith('.json'); });
  var passed = 0, failed = 0;
  files.forEach(function(f) {
    var fixture = JSON.parse(fs.readFileSync(path.join(testDir, f), 'utf8'));
    var result = cg.computeScore(fixture.input.specs, fixture.input.entities);
    var ok = true;
    if (fixture.expectedResult.scoreMustExceed && result.total <= fixture.expectedResult.scoreMustExceed) ok = false;
    if (fixture.expectedResult.scoreMustNotExceed && result.total > fixture.expectedResult.scoreMustNotExceed) ok = false;
    if (ok) { passed++; console.log('  PASS: ' + f + ' (score=' + result.total + ')'); }
    else { failed++; console.log('  FAIL: ' + f + ' (score=' + result.total + ', expected ' + JSON.stringify(fixture.expectedResult) + ')'); }
  });
  return { passed: passed, failed: failed, errors: 0 };
}

function runMethodCheckTests() {
  var mc;
  try { mc = require('../engine/stages/method-check.cjs'); } catch(e) {
    console.error('  Cannot load method-check.cjs: ' + e.message);
    return { passed: 0, failed: 0, errors: 1 };
  }
  var testDir = path.join(fixturesDir, 'method-check');
  if (!fs.existsSync(testDir)) return { passed: 0, failed: 0, errors: 0 };

  var files = fs.readdirSync(testDir).filter(function(f) { return f.endsWith('.json'); });
  var passed = 0, failed = 0;
  files.forEach(function(f) {
    var fixture = JSON.parse(fs.readFileSync(path.join(testDir, f), 'utf8'));
    var missing = mc.checkCompleteness(fixture.input.csCode);
    var expected = fixture.expectedResult.missing;
    var ok = missing.length === expected.length && missing.every(function(m) { return expected.indexOf(m) >= 0; });
    if (ok) { passed++; console.log('  PASS: ' + f); }
    else { failed++; console.log('  FAIL: ' + f + ' (got ' + JSON.stringify(missing) + ', expected ' + JSON.stringify(expected) + ')'); }
  });
  return { passed: passed, failed: failed, errors: 0 };
}
```

Wire these into the main runner's stage dispatch.

- [ ] **Step 3: Run full regression test suite**

```bash
cd /opt/blueprint-editor
node test/stage-regression.cjs
```

Expected: All new tests PASS alongside existing tests.

- [ ] **Step 4: Commit**

```bash
cd /opt/blueprint-editor
git add engine/stages/method-check.cjs test/stage-regression.cjs
git commit -m "test: add regression tests for complexity-gate and method-check stages"
```

---

### Task 10: End-to-End Validation

**Files:** None (verification only)

- [ ] **Step 1: Validate against Space Garbage v2 data**

Use the actual failed project to verify both gates would have caught the issues:

```bash
cd /opt/blueprint-editor
node -e "
// Gate 1: Complexity score for the failed project
var cg = require('./engine/stages/complexity-gate.cjs');
var proj = require('./server-data/projects/proj_1776322907717_q21d0i.json');
var specs = proj.specs || [];
var entities = (proj.nodes || []).filter(function(n) { return n.type === 'entity'; });
var mapped = entities.map(function(e) { return {name: e.data && e.data.name || e.text, terminalState: e.data && e.data.terminalState || 0}; });
if (specs.length > 0) {
  var r = cg.computeScore(specs, mapped);
  console.log('Gate 1 — Space Garbage v2 score:', r.total);
  console.log('Would block:', r.total > 250 ? 'YES (correct!)' : 'NO');
  console.log('Breakdown:', JSON.stringify(r.breakdown));
}
"
```

Expected: Score > 250, would be blocked.

- [ ] **Step 2: Validate method-check against actual failed code**

```bash
cd /opt/blueprint-editor
node -e "
var mc = require('./engine/stages/method-check.cjs');
var fs = require('fs');
// Load the checkpoint code from the failed project
var cpPath = 'server-data/checkpoints/proj_1776322907717_q21d0i/checkpoint.json';
if (fs.existsSync(cpPath)) {
  var cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
  var code = cp.csCode || cp.code || '';
  if (code) {
    var missing = mc.checkCompleteness(code);
    console.log('Gate 2 — Missing methods in failed project:', missing);
    console.log('Would inject feedback:', missing.length > 0 ? 'YES (correct!)' : 'NO');
  } else { console.log('No csCode in checkpoint'); }
} else { console.log('No checkpoint file found'); }
"
```

Expected: Detects missing methods (HandleInteractiveClicks, UpdateShardVisual, UpdateUI, AutoPlayInteract).

- [ ] **Step 3: Verify pipeline loads cleanly with all changes**

```bash
cd /opt/blueprint-editor
node -e "
var p = require('./engine/pipeline.cjs');
var stages = p.createLunaPipeline({}).stages.map(function(s){return s.name});
console.log('Pipeline stages:', stages);
var expected = ['clone','spec-validate','complexity-gate','codegen','method-check','review','compile','visual-check','cua-verify','upload'];
var match = JSON.stringify(stages) === JSON.stringify(expected);
console.log('Stage order correct:', match ? 'YES' : 'NO — got ' + JSON.stringify(stages));
"
```

Expected: Stage order matches exactly.

- [ ] **Step 4: Final commit with all verification passing**

```bash
cd /opt/blueprint-editor
git log --oneline -8
```

Verify 8 commits from this plan (1 docs + 2 new stages + 1 pipeline wiring + 2 skeleton kits + 1 spec extractor + 1 prompt + 1 tests). No additional commit needed if all pass.
