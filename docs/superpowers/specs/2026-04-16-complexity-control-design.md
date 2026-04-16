# Complexity Control: Storyboard Guidelines + Skeleton Expansion + Pipeline Gates

**Date**: 2026-04-16
**Status**: Approved
**Scope**: End-to-end complexity control for blueprint pipeline

## Problem

Pipeline success rate is critically low: codegen 60%, compile 46%, CUA-verify 7.7%.
52% of failures are pipeline bugs (fixable separately), but 32% are code generation quality issues caused by excessive complexity.

Key finding: phase count alone is NOT the discriminator. All projects (success and failure) have ~11 phases. The real failure drivers are:

- **Form/vehicle switching** requiring multiple control mode implementations (AI omits methods)
- **Deep economic chains** increasing state management code
- **Partial class split** triggered at >10 phases, doubling method-omission risk
- **Similar-but-different repeated phases** (3 vehicle upgrades) causing copy-paste errors

Data from 7 projects (1 success, 6 failures):

| Metric | Safe Threshold | Successful Project | Failed Project |
|---|---|---|---|
| Total C# lines | < 1300 | 1185 | 1453 |
| Done flags | >= phase count | 11 | 5 |
| Update() method calls | < 20 | 14 | 21 |
| OnAutoPlayArrive() lines | < 30 | 23 | 43 |

## Solution: Three-Layer Defense

### Layer 1: Storyboard Writing Guidelines

#### Core Concept: Visual Frame != Code Phase

- **Visual Frame**: Each shot/camera angle in the storyboard document. Unlimited count.
- **Code Phase**: Actual stage in skeleton-generated code. **Max 10**.
- **Mapping**: Multiple visual frames can map to the same code phase (sequential shots within one gameplay stage).

#### Complexity Budget Table

Every storyboard must include a filled budget table:

| Dimension | Budget Cap | Weight | Notes |
|---|---|---|---|
| Code Phase count | soft <=10 | x10 | >10 triggers partial class split |
| Control modes | soft <=2 | x40 | Walking=1, Vehicle=1, click-to-build is NOT a separate mode |
| Economic layers | no hard cap | x20 | Count resource conversion steps: A->B->C = 2 layers |
| Stateful entities | soft <=8 | x5 | Entities with state 0->1->2 progression |
| Form switches | soft <=3 | x15 | Character appearance/vehicle changes |

Formula: `total = (phases*10) + (controlModes*40) + (econLayers*20) + (entities*5) + (formSwitches*15)`

| Score | Action |
|---|---|
| <= 200 | Safe zone, proceed |
| 201-250 | Warning zone, proceed with log |
| > 250 | Auto-simplification by LLM, then re-score |

#### Four Hard Rules

1. **One control mode runs the whole game** — Form switches only change visuals and stats, never the control scheme. Always drag-to-move.
2. **Merge similar entities** — Drill/CrusherCar/HydraulicCar with identical control = 1 entity with 3-level state, not 3 separate entities.
3. **Draw economic chain diagram** — Before writing storyboard, draw `ResourceA -> ResourceB -> ... -> Consumption`. Layer count feeds into budget formula.
4. **Tag every frame with phaseId** — Explicitly mark which frames share the same code phase.

#### Storyboard Template Format

```markdown
## Project Budget
| Dimension | Value | Detail |
|---|---|---|
| Code Phases | 8 | (list 8 phaseIds) |
| Control Modes | 1 | Drag-to-move |
| Economic Layers | 2 | Ore -> Gold -> Buildings |
| Stateful Entities | 6 | (list) |
| Form Switches | 2 | Walking -> MiningCart -> Spaceship |
| **Total Score** | **185** | **Safe zone** |

## Frame-to-Phase Mapping
| Visual Frame | Code Phase | Notes |
|---|---|---|
| Frame 1: Tutorial drag | phase_1_tutorial | - |
| Frame 2: First collect | phase_1_tutorial | Same phase, second camera shot |
| Frame 3: Sell at base | phase_2_sell | - |
| ... | ... | ... |
```

---

### Layer 2: Skeleton Form-Switch & Economy Kit

#### Form Switch System

Skeleton pre-builds a data-driven form system. AI only fills a value table.

**Pre-built by skeleton (immutable):**

```csharp
struct FormDef {
    public string formId;
    public string poolObjectName;
    public float moveSpeed;
    public float collectRange;
    public float collectPower;
    public int carryCapacity;
    public float scale;
}

FormDef[] _forms;
int _currentFormIndex = 0;

void SwitchForm(int formIndex) {
    // Hide old model, show new model, update index
    // MovePlayer/TryCollect automatically read current form stats
}

// Existing methods updated to read from current form:
void MovePlayer()    { float speed = _forms[_currentFormIndex].moveSpeed; ... }
float GetCollectPower() => _forms[_currentFormIndex].collectPower;
float GetCollectRange() => _forms[_currentFormIndex].collectRange;
int GetCarryCapacity()  => _forms[_currentFormIndex].carryCapacity;
```

**AI fills (TODO section):**

```csharp
_forms = new FormDef[] {
    new FormDef { formId="astronaut", poolObjectName="__Pool_Sphere_White_01",
                  moveSpeed=3.5f, collectRange=1.5f, collectPower=1f, carryCapacity=10, scale=1.5f },
    new FormDef { formId="crusherCar", poolObjectName="__Pool_Cube_Gray_01",
                  moveSpeed=5f, collectRange=3f, collectPower=5f, carryCapacity=50, scale=2.5f },
};

// In CheckEventRules phase transition:
SwitchForm(1); // Switch to crusher car
```

**Impact**: 3 form switches go from ~200 lines AI-written to ~15 lines (struct values only).

**Trigger**: Skeleton generator detects `formSwitch` in specs or multiple entities marked `isPlayerForm: true`.

#### Economy System

Same data-driven approach for resource chains:

```csharp
struct ResourceDef {
    public string resourceId;
    public string displayName;
    public string convertFrom;
    public int convertRatio;
}

ResourceDef[] _resources;
Dictionary<string, int> _inventory;

void AddResource(string id, int amount);       // skeleton pre-built
bool TryConvert(string fromId, string toId);   // skeleton pre-built
bool TrySpend(string id, int amount);          // skeleton pre-built
void UpdateResourceUI();                        // skeleton pre-built
```

AI fills the resource definition table. 2-layer or 3-layer economy = same code volume.

---

### Layer 3: Pipeline Static Gates

#### Gate 1: Complexity Score (after spec-validate, before codegen)

**Location**: New stage between `spec-validate` and `codegen`.

```javascript
function complexityScore(specs, entities, blueprint) {
  const codePhases = specs.length;
  const controlModes = countControlModes(specs);
  const econLayers = countEconLayers(specs);
  const statefulEntities = entities.filter(e => e.terminalState > 0).length;
  const formSwitches = countFormSwitches(specs);

  return {
    breakdown: { codePhases, controlModes, econLayers, statefulEntities, formSwitches },
    total: (codePhases * 10) + (controlModes * 40) + (econLayers * 20)
         + (statefulEntities * 5) + (formSwitches * 15)
  };
}
```

**Disposition**:
- <= 200: pass
- 201-250: warn + continue
- > 250: invoke LLM auto-simplification, re-score, pass if <= 250, fail if still > 250

**Auto-simplification LLM strategy**:

Input to LLM:
- Current specs + breakdown showing which dimensions are over budget
- Ordered simplification strategies:
  1. Merge "upgrade X -> use X to collect" into single phase
  2. Merge economic intermediate layers
  3. Merge same-type entities into multi-level single entity
- Hard constraints: cannot delete CTA phase, cannot delete tutorial phase, preserve visual frame descriptions
- Target: <= 230 (20-point margin)

Output: simplified specs in same format -> re-score -> continue or fail.

Task history records `auto_simplified` + delta for auditability.

#### Gate 2: Method Completeness Check (after codegen, before compile)

**Location**: After codegen produces C# code, before sending to compile.

```javascript
function checkMethodCompleteness(csCode) {
  const defined = extractMethodDefinitions(csCode);
  const called = extractMethodCalls(csCode, ['Update', 'CheckEventRules']);
  const safeList = [...SKELETON_METHODS, ...UNITY_BUILTINS];
  const missing = called.filter(m => !defined.has(m) && !safeList.includes(m));
  return missing;
}
```

**Disposition**: Does NOT block. Injects missing method names into codegen fix-loop feedback:

```json
{
  "source": "method-completeness-check",
  "severity": "critical",
  "message": "Methods called but not defined: HandleInteractiveClicks, UpdateUI",
  "fix_hint": "Implement these methods or remove the calls"
}
```

This ensures the fix-loop targets the root cause (missing methods) on the very first retry, rather than chasing symptoms (visual_freeze) through 5+ CUA rounds.

---

## Architecture: Defense Flow

```
Storyboard Writing (Layer 1: Guidelines + Budget Table)
  |
  v
storyboard-parse -> spec-extract -> spec-validate
  |
  v
[Gate 1: Complexity Score] -- >250 --> [LLM Auto-Simplify] -- still >250 --> FAIL
  |  <=250                                    | <=250
  v                                           v
codegen (AI generates C#)  <------------------+
  |
  v
[Gate 2: Method Completeness] -- missing --> inject feedback, retry codegen
  |  complete
  v
compile -> visual-check -> cua-verify -> upload
```

## Files to Modify

| File | Change |
|---|---|
| `adapters/skeleton-generator.cjs` | Add FormDef system + SwitchForm() + ResourceDef system |
| `engine/stages/complexity-gate.cjs` | **NEW** — complexity scoring + auto-simplification |
| `engine/stages/method-check.cjs` | **NEW** — method completeness scanning |
| `engine/pipeline.cjs` | Insert complexity-gate after spec-validate, method-check after codegen |
| `worker/prompt-v5-basetemplate.js` | Update AI instructions to reference new skeleton methods |
| `adapters/spec-extractor.cjs` | Add formSwitch / isPlayerForm extraction |

## Success Criteria

- Complexity score correctly blocks "Space Garbage v2 original" (score 380 > 250)
- Method completeness check catches the 4 missing methods from q21d0i on first codegen round
- Form switch kit reduces 3-form game code from ~200 lines to ~15 lines
- Pipeline codegen pass rate improves from 60% to 80%+ (measured over next 20 projects)
