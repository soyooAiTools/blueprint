# Deterministic Pre-Repair Lib Scoping — 2026-05-31

Scoping doc for extracting the deterministic pre-repair pipeline currently embedded inside `engine/stages/review.cjs` into a shared library with a single source of truth for static-rule API whitelists. **No code changes in this doc** — diagnosis + migration plan only.

---

## 1. Problem statement

### 1.1 Symptoms today

Every new "block at static-check → write a deterministic pre-repair" turn-around (e.g. `sanitizeNonAsciiResourceApiKeys` added 2026-05-31, `stripExcessCameraBackgroundAssignments` added 2026-05-12, `rewriteCameraMainToMainCam` added 2026-05-12) requires the contributor to:

1. Add a function inside `engine/stages/review.cjs` (currently 18 pre-repair functions live around lines 80–2026).
2. Wire it into the **main code** branch of `repairKnownStructuralDamage` (`engine/stages/review.cjs:2081`), ~7 lines of `var fix = …; if (fix.changed) { … fixes.push(…); }` boilerplate.
3. Wire it into the **partial files** branch of the same function (`engine/stages/review.cjs:2209` for the first per-file forEach), another ~7 lines of near-identical boilerplate.
4. Independently maintain the API-whitelist / hot-path-method-list / regex-blacklist inside both the static rule (`engine/static-check.cjs`) and the pre-repair function.

### 1.2 Quantified duplication

Verified by `awk` count on `engine/stages/review.cjs` (2026-05-31 commit):

| Apply point | Range | `.changed` checks | Pre-repair fns invoked |
|---|---|---|---|
| Main file (`repairKnownStructuralDamage`) | L2081–L2210 | 20 | 18 distinct (one called twice for post-pass) |
| Partial files (`Object.keys(nextExtras).forEach`) | L2211–L2315 | 17 | 16 distinct (`declareMissingInteractionFlags` / `ensurePlayerFieldAssignment` / `repairPlayerAliasMemberAccess` are main-only because they take `extraFiles` argument) |
| Post-pass main + partials (`normalize…Post` / `rename…Post` / `addMissing…Comments`) | L2316–L2420 | 17 | 7 fns invoked again |

**16 of 18 pre-repair functions are mirrored across two near-identical loops.** Net duplication ≈ **2 × ~100 lines = ~200 lines** of pure boilerplate (`var xRes = fn(extras[name]); if (xRes.changed) { extras[name] = xRes.code; fixes.push(name + ':Tag x' + xRes.fixes); }`).

### 1.3 White-list drift risk (concrete)

`sanitizeNonAsciiResourceApiKeys` (`review.cjs:444`) has the API list inlined as a local `apis` array:

```js
var apis = [
  'AddResource', 'TrySpend', 'GetResource', 'TryConvert',
  'GFM_ResourceIds\\.Normalize', 'GFM_ResourceIds\\.Resolve',
  'GameObject\\.Find', 'CompletePhaseProgress', 'EnterPhase',
  'RecordPhaseEvidenceFlag', 'NotifyPhaseProgress',
];
```

The matching static rule `non-ascii-resource-key` (`static-check.cjs:965-999`) has its **own** copy of the same list:

```js
var apis = [
  'AddResource', 'TrySpend', 'GetResource', 'TryConvert',
  'GFM_ResourceIds.Normalize', 'GFM_ResourceIds.Resolve',
  'GameObject.Find', 'CompletePhaseProgress', 'EnterPhase',
  'RecordPhaseEvidenceFlag', 'NotifyPhaseProgress'
];
```

These two lists are currently in sync **by accident**. Add `AddInventory` to the static rule (legitimate next API to police) and forget the pre-repair, and the fix-loop spins on every blueprint that produces `AddInventory("金币")`.

A second confirmed drift surface: `update-new-vector-in-hot-path` rule (`static-check.cjs:1073`) has `hotFns = ['Update', 'MovePlayer', 'CheckEventRules', 'AutoPlayUpdate']`. The matching `rewriteHotPathVectorAllocations` pre-repair (`review.cjs:486`) does NOT scope its rewrites by method (it pattern-rewrites globally), so the static rule's narrowing is invisible to the repair. If the rule is later widened to include `LateUpdate`, no one is signaled to revisit the repair.

### 1.4 Why it matters now

- Every new pre-repair burns 20–30 min of "remember which two places, copy-paste, hope you got `mainCode = res.code` not `extras[name] = res.code` right". `sanitizeNonAsciiResourceApiKeys` (added today, 2026-05-31) is the **third** pre-repair added in May with the same pattern.
- `review.cjs` is now 3,029 lines (file:line counts in §2). It is on the same fragility tier as `programmer-delivery-cleaner.cjs` (per `project_cleaner_blast_radius.md`): every codegen output flows through it, every project's fix-loop convergence depends on it.
- `engine/static-check.cjs` is 2,474 lines with 90+ rule entries. The pre-repair / rule pairs that share whitelists today are 2 (§3 below); they will grow as we keep adding determinism layers to replace LLM rounds (per `project_blueprint_llm_reduction_2026-05-13.md`, the explicit strategy is "more deterministic, fewer LLM rounds").

---

## 2. Diagnosis — current state

### 2.1 Pre-repair function inventory (`engine/stages/review.cjs`)

All 18 deterministic pre-repair functions, signature `fn(code[, blueprint|extraFiles]) → { code, changed, fixes }` unless noted:

| # | Function | file:line | One-line purpose |
|---|---|---|---|
| 1 | `repairUpdateGameStateBridge` | review.cjs:80 | Patches malformed JSON-string concatenation in `UpdateGameState()` (skeleton bridge). |
| 2 | `stripInitMaterialFromScene` | review.cjs:101 | Removes forbidden `GFM_Create.InitMaterialFromScene(` calls (pairs with rule `forbidden-init-material-from-scene` static-check:216). |
| 3 | `stripEarlyShowCTA` | review.cjs:118 | Strips `ShowCTA();` calls outside `ShowCTA`/`FinishGame` (pairs with rule `showcta-early-call-forbidden` static-check:408). |
| 4 | `normalizeFinishGameTerminalFlow` | review.cjs:149 | Enforces `Luna.Unity.LifeCycle.GameEnded() ; ShowCTA();` order in `FinishGame()` and drops `AddCompletedPhase("gameEnd")` (pairs with rules `gameended-before-showcta` :443 and `showcta-must-not-call-gameended` :380). |
| 5 | `normalizeRuntimePhaseContract` | review.cjs:200 | Aligns `RULE_COUNT` constant with expected phase count and rewrites terminal `EnterPhase(N, "gameEnd", false, false)` to `currentPhaseName = "gameEnd"`. |
| 6 | `ensureAssemblySlotRunnerCalls` | review.cjs:232 | Inserts missing `AssemblyRunFlowSlots()` / `…InputSlots()` / etc. into `Update()` (pairs with assembly-plan-contracts gate). |
| 7 | `ensureAssemblySlotRunnerCallsAcrossPartials` | review.cjs:308 | Same as #6 but verifies across partial files (declared in one partial, called in another). |
| 8 | `rewriteCameraMainToMainCam` | review.cjs:347 | Rewrites bare `Camera.main` → `mainCam` when file declares `Camera mainCam` (pairs with rule `camera-main` static-check:130). |
| 9 | `stripExcessCameraBackgroundAssignments` | review.cjs:404 | Keeps only the first `Camera.backgroundColor =` / `mainCam.backgroundColor =` per file (pairs with rule `camera-background-override` static-check:1332). |
| 10 | `sanitizeNonAsciiResourceApiKeys` ★ | review.cjs:444 | Sanitizes CJK/punct/whitespace in string literal args of resource APIs (pairs with rule `non-ascii-resource-key` static-check:965). **Added 2026-05-31.** |
| 11 | `rewriteHotPathVectorAllocations` | review.cjs:486 | Rewrites `obj.transform.position = obj.transform.position + new Vector3(…)` to struct-copy form (pairs with rule `update-new-vector-in-hot-path` static-check:1073). |
| 12 | `normalizeSetScaleCalls` | review.cjs:558 | Collapses `SetScale(obj, u, u, u)` → `SetScale(obj, u)`, trims trailing 0/1 to 4-arg form (pairs with rule `setscale-wrong-params` static-check:1019). |
| 13 | `stripInteractionFlagShortcutsFromPhaseGates` | review.cjs:579 | Strips `ruleTriggered[N]` shortcuts from phase-gate OR-chains (pairs with rule `phase-gate-shortcircuits-with-interaction-flags` static-check:534). |
| 14 | `repairPhaseGateRuntimeMoves` | review.cjs:678 | Injects missing per-phase `Bobble`/`MoveTo` calls into phase OnEnter handlers (pairs with `phase-entity-init-only` :827). |
| 15 | `repairPhaseGateRuntimeMovesAcrossPartials` | review.cjs:1009 | Cross-file variant of #14. |
| 16 | `normalizePhaseGateConditionalDeclarations` | review.cjs:1362 | Wraps `__gateMovePos` declarations inside `{}` blocks when they follow a single-line `if`. |
| 17 | `renameDuplicatePhaseGateMoveVars` | review.cjs:1385 | Renames duplicate `__gateMovePosN` declarations in same scope. |
| 18 | `ensurePlayerFieldAssignment` | review.cjs:1409 | Ensures `player = GameObject.Find("Player")` assignment exists (pairs with `uninit-player-field` :1440). |
| 19 | `repairPlayerAliasMemberAccess` | review.cjs:1450 | Rewrites `Player.foo` → `player.foo` token-by-token (pairs with `player-alias-drift` :1406). |
| 20 | `rewriteLongIfChainsAsSwitches` | review.cjs:1586 | Rewrites `if (x == "a") {} else if (x == "b") {} …` as `switch (x) { case "a": … }` (pairs with `long-if-chain` :1837). |
| 21 | `collapseLegacyCheckEventRulesStub` | review.cjs:1765 | Empties the body of `CheckEventRules_OLD_UNUSED_STUB()`. |
| 22 | `removePostTapPhaseResetBlocks` | review.cjs:1790 | Strips post-`Phase_OnTap()` reset-only `switch (currentPhaseName)` blocks. |
| 23 | `addMissingComplexBranchComments` | review.cjs:1893 | Inserts `// Branch gate:` comment before un-documented complex `if (...)` conditions (pairs with `require-branch-comment` :2063, non-blocking). |
| 24 | `addMissingSkeletonMemberComments` | review.cjs:1929 | Inserts xml-doc for un-documented skeleton members (pairs with `require-member-doc` :1950, non-blocking). |
| 25 | `declareMissingInteractionFlags` | review.cjs:2026 | Declares missing `bool flag_X` for referenced interaction flags. |

Total: **25 functions** that conform to the `{ code, changed, fixes }` (or `{ code, extraFiles, changed, fixes }`) shape. Only **3** are currently exported from `module.exports` (lines 2501–2524, namely `normalizeSetScaleCalls`, `repairPhaseGateRuntimeMoves`, `removePostTapPhaseResetBlocks`, plus a few helpers that aren't in the bundle). The remaining 22 are file-local.

### 2.2 Apply-point mirror — main vs partials

`repairKnownStructuralDamage(mainCode, extraFiles, blueprint)` (`review.cjs:2081–2427`) executes the same 16-function bundle twice:

- **Pass A (lines 2105–2208)**: applied to `mainCode`, 20 `.changed` checks (a few extra structural / cross-file fns).
- **Pass B (lines 2209–2315)**: applied per-file inside `Object.keys(nextExtras).forEach`, 17 `.changed` checks.
- **Pass C "post" (lines 2316–2420)**: re-runs 7 fns on `mainCode` and partials again, because some earlier pre-repair (e.g. `repairPhaseGateRuntimeMovesAcrossPartials`) feeds new content into the same hot-path methods.

The boilerplate per function is ≈7 lines (declare result, branch on `.changed`, assign back, push to `fixes` log). 16 × 7 × 2 ≈ **224 lines of mirror boilerplate.**

Visual signature: every function call in pass A has a near-identical twin in pass B with `mainCode` → `nextExtras[name]` and tag-prefix `main:` → `name + ':'`.

### 2.3 Static rules with shared whitelists / blacklists

Rules in `engine/static-check.cjs` that maintain a config list and have a matching pre-repair (`engine/stages/review.cjs`):

| Rule | static-check.cjs:line | Config in rule | Pre-repair | review.cjs:line | Config in pre-repair (must stay in sync) |
|---|---|---|---|---|---|
| `non-ascii-resource-key` | 965 | `apis` array of 11 API names + `nonAsciiRe` charset | `sanitizeNonAsciiResourceApiKeys` | 444 | Same 11-name `apis` array + same charset |
| `update-new-vector-in-hot-path` | 1073 | `hotFns = ['Update', 'MovePlayer', 'CheckEventRules', 'AutoPlayUpdate']` | `rewriteHotPathVectorAllocations` | 486 | (currently unscoped — rewrites everywhere; drift in the other direction) |
| `camera-background-override` | 1332 | `(?:Camera|mainCam)\.backgroundColor =` regex + "keep first hit" semantics | `stripExcessCameraBackgroundAssignments` | 404 | Same regex, same "strip all but first" semantics |
| `camera-main` | 130 | Plain regex `/Camera\.main(?!…)/` + "ok"/"正常" comment escape hatch | `rewriteCameraMainToMainCam` | 347 | Substring match `'Camera.main'` + custom comment/string mask. Does NOT honor the escape hatch — minor drift risk if the rule's escape syntax is updated. |
| `showcta-early-call-forbidden` | 408 | "ShowCTA() outside ShowCTA/FinishGame" semantics | `stripEarlyShowCTA` | 118 | Same method-allowlist `['ShowCTA', 'FinishGame']` |
| `phase-gate-shortcircuits-with-interaction-flags` | 534 | `ruleTriggered[N]` shortcut detection + spec-count gate | `stripInteractionFlagShortcutsFromPhaseGates` | 579 | Same shortcut detection, same `specCount <= 1` short-circuit |
| `setscale-wrong-params` | 1019 | Acceptable arg counts `[2, 4]` | `normalizeSetScaleCalls` | 558 | Same arg-count contract (collapses 4→2 when components equal, trims 5→4 when trailing 0/1) |
| `long-if-chain` | 1837 | "long if chain" semantics | `rewriteLongIfChainsAsSwitches` | 1586 | Same semantics |
| `player-alias-drift` | 1406 | `/\bPlayer\b\s*\./` + `GameObject player;` precondition | `repairPlayerAliasMemberAccess` | 1450 | Same precondition + same token-boundary rules |
| `uninit-player-field` | 1440 | `player = GameObject.Find("Player")` precondition | `ensurePlayerFieldAssignment` | 1409 | Same |

**10 rule/pre-repair pairs** with non-trivial shared config today. All ten currently maintained as two independent copies.

### 2.4 What `review.cjs` exports

`engine/stages/review.cjs:2501–2524` exports a partial subset of pre-repair functions (used by `worker/code-reviewer.js` for manual invocation in fallback paths):

```
normalizeSetScaleCalls
repairPhaseGateRuntimeMoves
repairPhaseGateRuntimeMovesAcrossPartials
removePostTapPhaseResetBlocks
normalizePhaseGateConditionalDeclarations
renameDuplicatePhaseGateMoveVars
stripInteractionFlagShortcutsFromPhaseGates
rewriteLongIfChainsAsSwitches
normalizeRuntimePhaseContract
ensureAssemblySlotRunnerCalls
ensureAssemblySlotRunnerCallsAcrossPartials
declareMissingInteractionFlags
repairPlayerAliasMemberAccess
ensurePlayerFieldAssignment
addMissingComplexBranchComments
addMissingSkeletonMemberComments
repairKnownStructuralDamage
```

= 17 of 25 pre-repair functions exported. The other 8 (`repairUpdateGameStateBridge`, `stripInitMaterialFromScene`, `stripEarlyShowCTA`, `normalizeFinishGameTerminalFlow`, `rewriteCameraMainToMainCam`, `stripExcessCameraBackgroundAssignments`, `sanitizeNonAsciiResourceApiKeys`, `rewriteHotPathVectorAllocations`, `normalizeSetScaleCalls` (this one IS exported), `collapseLegacyCheckEventRulesStub`, `findMethodBodyRange`) are file-private. `engine/static-check.cjs` already exports `RULES` (the full rule array) so the registry direction is open from that side already.

---

## 3. Proposed lib shape

### 3.1 New files

```
engine/lib/
├── static-rule-registry.cjs        # NEW: shared config (API whitelists, hot-path methods, charsets)
└── static-rule-prerepair.cjs       # NEW: bundle of pre-repair fns + runAllPreRepairs()
```

`engine/lib/` does not exist yet (verified). `engine/stages/lib/` exists with `anchor-extractor.cjs` and `field-diff.cjs` (precedent for stage-scoped libs), but the new lib is consumed by **both** `engine/static-check.cjs` and `engine/stages/review.cjs`, so it belongs one level up at `engine/lib/`.

### 3.2 `engine/lib/static-rule-registry.cjs` — shared config

Pure data, zero runtime behavior. Consumed by both `static-check.cjs` (rule `custom:` functions) and `static-rule-prerepair.cjs`.

```js
// Pure-data registry: API whitelists, hot-path method lists, charset definitions
// that must stay in sync between static-check rules and pre-repair functions.
//
// Do NOT add runtime logic here. Adding a new entry here is the single signal that
// "this list is consumed by two places."

module.exports = {
  // Resource-API key sanitizer (rule non-ascii-resource-key + pre-repair
  // sanitizeNonAsciiResourceApiKeys)
  RESOURCE_API_KEY_APIS: [
    'AddResource', 'TrySpend', 'GetResource', 'TryConvert',
    'GFM_ResourceIds.Normalize', 'GFM_ResourceIds.Resolve',
    'GameObject.Find', 'CompletePhaseProgress', 'EnterPhase',
    'RecordPhaseEvidenceFlag', 'NotifyPhaseProgress',
  ],
  RESOURCE_API_KEY_NON_ASCII_RE: /[\u4e00-\u9fff，。：；！？、,.:;!?\s]/,

  // Hot-path Vector allocation (rule update-new-vector-in-hot-path + pre-repair
  // rewriteHotPathVectorAllocations)
  HOT_PATH_METHODS: ['Update', 'MovePlayer', 'CheckEventRules', 'AutoPlayUpdate'],
  // Note: if HOT_PATH_METHODS gains LateUpdate, both sides pick it up automatically.

  // Camera background override (rule camera-background-override + pre-repair
  // stripExcessCameraBackgroundAssignments)
  CAMERA_BG_TARGET_RE: /(?:Camera|mainCam)\s*\.\s*backgroundColor\s*=/g,

  // Camera.main → mainCam rewrite (rule camera-main + pre-repair
  // rewriteCameraMainToMainCam)
  MAINCAM_FIELD_RE: /\b(?:private|protected|internal|public|static)?\s*Camera\s+mainCam\s*[;=]/,
  CAMERA_MAIN_ESCAPE_RE: /Camera\.main\s*;?\s*\/\/\s*(?:(?:说明：)?ok|正常)/,

  // ShowCTA early-call (rule showcta-early-call-forbidden + pre-repair stripEarlyShowCTA)
  SHOWCTA_ALLOWED_METHODS: ['ShowCTA', 'FinishGame'],

  // SetScale arity (rule setscale-wrong-params + pre-repair normalizeSetScaleCalls)
  SETSCALE_VALID_ARITIES: [2, 4],

  // Player alias (rule player-alias-drift + pre-repair repairPlayerAliasMemberAccess)
  PLAYER_LOWERCASE_DECL_RE: /\bGameObject\s+player\s*[;=]/,
};
```

### 3.3 `engine/lib/static-rule-prerepair.cjs` — pre-repair bundle

Re-exports the 25 pre-repair fns (currently inside `review.cjs`) and provides a single ordered runner. Two consumption modes:

```js
var registry = require('./static-rule-registry.cjs');

// Each pre-repair: function (code, ctx) → { code, changed, fixes }
// ctx = { blueprint, extraFiles, fileName, scope }
//   scope = 'main' | 'partial' (some fns only run on main, e.g. ensurePlayerFieldAssignment)

var sanitizeNonAsciiResourceApiKeys = require('./prerepairs/non-ascii-resource-key.cjs')(registry);
var rewriteHotPathVectorAllocations = require('./prerepairs/hot-path-vector.cjs')(registry);
// … 23 more

// Ordered bundle — order matters (see §6 risks). Each entry declares:
//   - name: short tag for fix-log
//   - run(code, ctx): the pre-repair fn
//   - scope: which loop pass (main / partial / both / cross-file)
var PREREPAIR_BUNDLE = [
  { name: 'MissingInteractionFlags',     run: declareMissingInteractionFlags,            scope: 'main-extras' },
  { name: 'PlayerAliasMemberAccess',     run: repairPlayerAliasMemberAccess,             scope: 'main-extras' },
  { name: 'PlayerFieldAssignment',       run: ensurePlayerFieldAssignment,               scope: 'main-extras' },
  { name: 'LegacyCheckEventRulesStub',   run: collapseLegacyCheckEventRulesStub,         scope: 'both' },
  { name: 'UpdateGameState',             run: repairUpdateGameStateBridge,               scope: 'both' },
  { name: 'RuntimePhaseContract',        run: normalizeRuntimePhaseContract,             scope: 'both' },
  { name: 'AssemblySlotRunnerTick',      run: ensureAssemblySlotRunnerCalls,             scope: 'both' },
  { name: 'InitMaterialFromScene',       run: stripInitMaterialFromScene,                scope: 'both' },
  { name: 'EarlyShowCTA',                run: stripEarlyShowCTA,                         scope: 'both' },
  { name: 'FinishGameFlow',              run: normalizeFinishGameTerminalFlow,           scope: 'both' },
  { name: 'HotVectorAlloc',              run: rewriteHotPathVectorAllocations,           scope: 'both' },
  { name: 'NonAsciiKey',                 run: sanitizeNonAsciiResourceApiKeys,           scope: 'both' },
  { name: 'CameraBackgroundOverride',    run: stripExcessCameraBackgroundAssignments,    scope: 'both' },
  { name: 'CameraMainRewrite',           run: rewriteCameraMainToMainCam,                scope: 'both' },
  { name: 'SetScaleNormalize',           run: normalizeSetScaleCalls,                    scope: 'both' },
  { name: 'PhaseGateRuntimeMove',        run: repairPhaseGateRuntimeMoves,               scope: 'both' },
  { name: 'PhaseGateConditionalNormalize', run: normalizePhaseGateConditionalDeclarations, scope: 'both' },
  { name: 'PhaseGateMoveVarRename',      run: renameDuplicatePhaseGateMoveVars,          scope: 'both' },
  { name: 'PhaseGateShortcutStrip',      run: stripInteractionFlagShortcutsFromPhaseGates, scope: 'both' },
  { name: 'LongIfChainSwitch',           run: rewriteLongIfChainsAsSwitches,             scope: 'both' },
];

var CROSS_FILE_BUNDLE = [
  { name: 'PhaseGateRuntimeMoveCross',   run: repairPhaseGateRuntimeMovesAcrossPartials },
  { name: 'AssemblySlotRunnerTickCross', run: ensureAssemblySlotRunnerCallsAcrossPartials },
  { name: 'PlayerAliasMemberAccessPost', run: repairPlayerAliasMemberAccess },
];

var POST_BUNDLE = [
  { name: 'RuntimePhaseContractPost',           run: normalizeRuntimePhaseContract,             scope: 'both' },
  { name: 'AssemblySlotRunnerTickPost',         run: ensureAssemblySlotRunnerCalls,             scope: 'main' },
  { name: 'PhaseGateConditionalNormalizePost',  run: normalizePhaseGateConditionalDeclarations, scope: 'both' },
  { name: 'PhaseGateMoveVarRenamePost',         run: renameDuplicatePhaseGateMoveVars,          scope: 'both' },
  { name: 'LongIfChainSwitchPostPhaseGate',     run: rewriteLongIfChainsAsSwitches,             scope: 'both' },
  { name: 'PostTapPhaseResetStrip',             run: removePostTapPhaseResetBlocks,             scope: 'main' },
  { name: 'ComplexBranchComments',              run: addMissingComplexBranchComments,           scope: 'both-gfm' },
  { name: 'SkeletonMemberComments',             run: addMissingSkeletonMemberComments,          scope: 'both-gfm' },
];

function runAllPreRepairs(mainCode, extraFiles, blueprint) {
  // Three passes wired to mirror current repairKnownStructuralDamage:
  //   Pass A: apply PREREPAIR_BUNDLE (filter 'main' / 'main-extras' / 'both') to mainCode.
  //   Pass B: apply PREREPAIR_BUNDLE (filter 'both') to each partial file.
  //   Pass C: apply CROSS_FILE_BUNDLE and POST_BUNDLE.
  //
  // Each pass loops the bundle declaratively. Zero copy-paste between main/partial.
  // Returns { code, extraFiles, changed, fixes }.
}

module.exports = {
  runAllPreRepairs,
  PREREPAIR_BUNDLE,
  CROSS_FILE_BUNDLE,
  POST_BUNDLE,
  // Plus individual pre-repair exports for tests / fallback paths that
  // currently consume them directly via review.cjs module.exports.
};
```

### 3.4 Shared-registry consumption in `static-check.cjs`

```js
// engine/static-check.cjs (after step 1 of migration)
var registry = require('./lib/static-rule-registry.cjs');

// rule non-ascii-resource-key
{
  id: 'non-ascii-resource-key', pattern: null, blocking: true,
  message: '…',
  custom: function(code) {
    var issues = [];
    var apis = registry.RESOURCE_API_KEY_APIS;
    var nonAsciiRe = registry.RESOURCE_API_KEY_NON_ASCII_RE;
    // … existing logic unchanged
  },
},
```

Same diff for `update-new-vector-in-hot-path`, `camera-background-override`, `setscale-wrong-params`, etc.

---

## 4. Migration path — 3 independent PRs

### 4.1 Step 1 — Introduce registry, migrate `non-ascii-resource-key` only

**Scope:** Create `engine/lib/static-rule-registry.cjs` with **only** `RESOURCE_API_KEY_APIS` + `RESOURCE_API_KEY_NON_ASCII_RE`. Wire both `engine/static-check.cjs:965` (rule body) and `engine/stages/review.cjs:444` (`sanitizeNonAsciiResourceApiKeys`) to read from the registry. No structural changes to either file beyond the inlined-list → `registry.X` swap.

**Why first:** Smallest blast radius — only one rule/pre-repair pair touched, the pair was added 2026-05-31 so already-collected runs validate behavior, and it proves the registry pattern works without re-architecting the apply loop.

**Files changed:** 3 (1 new + 2 edited). Touched line count: ≈30.

**Test surface:** Existing unit test for `sanitizeNonAsciiResourceApiKeys` (if absent, add one — see §7). Run a full project through `npm test` to verify static-check rule still flags the same lines.

**Risk:** Trivial. Pure config extraction.

### 4.2 Step 2 — Extract `static-rule-prerepair.cjs`, refactor main pass

**Scope:**
1. Create `engine/lib/static-rule-prerepair.cjs` with all 25 pre-repair fns moved (or re-exported via `require('../stages/review.cjs')` thin shim — see migration tactic note below).
2. Add `runAllPreRepairs(mainCode, extraFiles, blueprint)` that mirrors the current main-pass logic of `repairKnownStructuralDamage`.
3. Rewrite `repairKnownStructuralDamage` in `review.cjs` to:
   ```js
   function repairKnownStructuralDamage(mainCode, extraFiles, blueprint) {
     return require('../lib/static-rule-prerepair.cjs')
              .runAllPreRepairs(mainCode, extraFiles, blueprint);
   }
   ```
4. Keep all 17 currently-exported pre-repair names in `review.cjs` `module.exports` as re-exports from the lib (zero downstream consumer churn).

**Migration tactic (recommended):** Do **not** copy function bodies in step 2. Instead, make `static-rule-prerepair.cjs` `require('../stages/review.cjs')` to pull in fns initially, then `runAllPreRepairs` is the only new code path. This decouples behavior change (zero) from file motion (deferred to step 3). Removes "did I miss a regex escape on the move?" class of bugs.

**Files changed:** 2 (1 new + review.cjs trimmed by ~200 lines of mirror logic). 

**Test surface:** Run `npm test` baseline (`project_test_runner_unification.md` — 89 files / 279 cases, 0 failures). Diff `fixes` array from `repairKnownStructuralDamage` against pre-refactor for 3+ canonical projects: same tags in same order, same counts. This is the most important validation gate — code is supposed to be equivalent.

**Risk:** Medium. The main vs partial loops have subtle differences (post-pass branches at lines 2316–2420 are not strict mirrors). If `runAllPreRepairs` doesn't faithfully replicate the three passes' ordering, fix-loop convergence regresses silently. **Mitigation:** snapshot the `fixes` array on a corpus of past projects, run new code against same inputs, assert byte-equal output. 

### 4.3 Step 3 — Move function bodies, delete mirror code from `review.cjs`

**Scope:**
1. Physically move all 25 pre-repair function bodies from `review.cjs` into `engine/lib/static-rule-prerepair.cjs` (or sub-modules under `engine/lib/prerepairs/` if file size warrants).
2. Update `static-rule-prerepair.cjs` so it no longer `require`s `review.cjs` (breaks the temporary shim).
3. `review.cjs` `module.exports` continues to re-export the 17 currently-exported names from the lib (BC for `worker/code-reviewer.js`).
4. Migrate remaining 8 rule whitelists to registry (one commit per rule/pre-repair pair to keep blast radius small):
   - `update-new-vector-in-hot-path` ↔ `rewriteHotPathVectorAllocations`
   - `camera-background-override` ↔ `stripExcessCameraBackgroundAssignments`
   - `camera-main` ↔ `rewriteCameraMainToMainCam`
   - `showcta-early-call-forbidden` ↔ `stripEarlyShowCTA`
   - `setscale-wrong-params` ↔ `normalizeSetScaleCalls`
   - `phase-gate-shortcircuits-with-interaction-flags` ↔ `stripInteractionFlagShortcutsFromPhaseGates`
   - `player-alias-drift` ↔ `repairPlayerAliasMemberAccess`
   - `uninit-player-field` ↔ `ensurePlayerFieldAssignment`

**Files changed:** Many (lib gains code, review.cjs loses code, static-check.cjs gets ~8 `registry.X` swaps).

**Test surface:** Same as step 2 — `npm test` + fixes-array snapshot diffs. Also: cross-file pre-repair functions (`*AcrossPartials`) need careful re-validation because they take `mainCode, extraFiles` and mutate `extraFiles` in-place.

**Risk:** Medium-high. Function motion across files is the biggest source of bugs in this kind of refactor (missing `require`, missing helper fn that was file-local, regex backslash escaping breakage when moved through a clipboard). **Mitigation:** Do the motion mechanically (a single commit per fn group, never combine motion with logic change). Verify with `diff` of bundled output that the moved fn is byte-equal to original.

---

## 5. Out of scope (explicit)

- **NOT** changing any individual pre-repair function's behavior or regex. Code-equivalent refactor only.
- **NOT** changing static rule triggering conditions, severity (blocking vs non-blocking), or messages.
- **NOT** touching the review LLM prompt or any reviewer module (`worker/code-reviewer.js`, `worker/codex-reviewer.js`).
- **NOT** introducing a generic "rule + pre-repair pair" abstraction (`makePreRepairForRule(rule)` from the task spec) — registry is config-data only; pre-repair fns stay hand-written. Auto-generating pre-repair from a rule is feasible only for the simplest rules (literal-strip), and the registry approach captures the highest-value drift surface (shared whitelists) without paying for a code-generator we'd debug forever.
- **NOT** changing the fix-log tag format (`fixes.push(name + ':Tag x' + count)`). External tools may grep these tags.
- **NOT** reordering the 3-pass structure (main → partials → cross + post). Order is load-bearing (§6).

---

## 6. Risks

### 6.1 `review.cjs` is high-blast-radius

Per `project_cleaner_blast_radius.md`, the only stage flagged as comparable fragility is `programmer-delivery-cleaner.cjs`. `review.cjs` is the **second** such surface — every codegen output flows through `repairKnownStructuralDamage` before reaching the LLM reviewer (or the deterministic fallback). A silent behavioral change here costs an entire fix-loop round per affected project. Mitigations:

- Step 1 ships behind no flag (it's a pure config extraction); step 2 ships with `runAllPreRepairs` selected via a temporary `USE_PRE_REPAIR_LIB` env-flag default-on, fallback to inline path for 1 week before deleting the inline path in step 3.
- Add a per-pre-repair unit test before moving (currently only some are tested — verify by running `npm test` and inspecting coverage of `review.cjs:80-2026`).

### 6.2 `static-check.cjs` rule registry-ization must not change triggering

Step 1 (and the per-rule passes in step 3) replace inline config with `registry.X` but **must not** change the rule's `custom:` function logic — e.g. line-number computation, escape-hatch regexes, fileName/`ctx.filename` guards. Validation: run static-check on the same 10+ project corpus before/after, expect identical issue arrays.

### 6.3 Pre-repair ordering is load-bearing

Several pre-repairs depend on the output of an earlier one. Verified examples:

- `rewriteCameraMainToMainCam` must run **before** `stripExcessCameraBackgroundAssignments`, because the latter's regex matches both `Camera.backgroundColor =` and `mainCam.backgroundColor =`. If rewrite runs after strip, a `Camera.backgroundColor` that should have been counted as a duplicate becomes `mainCam.backgroundColor` after the strip already chose a different "first hit," and the strip's "keep first hit" semantics produce different output.
- `repairPhaseGateRuntimeMoves` (main) must run **before** `repairPhaseGateRuntimeMovesAcrossPartials` (cross). The cross fn inspects whether moves exist anywhere, so single-file moves must be in place first.
- `normalizePhaseGateConditionalDeclarations` must run **before** `renameDuplicatePhaseGateMoveVars`. The normalizer changes brace structure, the rename relies on the post-normalize textual shape.
- Post-pass `normalizeRuntimePhaseContract` runs **after** cross-partial moves because the cross-partial fix can insert new `EnterPhase` calls that need re-normalization.

The `PREREPAIR_BUNDLE` / `POST_BUNDLE` arrays in `static-rule-prerepair.cjs` MUST preserve this insertion order. The current `repairKnownStructuralDamage` does this implicitly via source-code order at lines 2105–2208 / 2316–2420.

### 6.4 `extraFiles` mutation semantics

Several pre-repairs (`declareMissingInteractionFlags`, `repairPlayerAliasMemberAccess`, `ensurePlayerFieldAssignment`, `repairPhaseGateRuntimeMovesAcrossPartials`, `ensureAssemblySlotRunnerCallsAcrossPartials`) take `(mainCode, extraFiles)` and return `{ code, extraFiles, changed, fixes }`. The caller swaps `extraFiles = result.extraFiles` (review.cjs:2087 etc.). The new `runAllPreRepairs` MUST preserve this swap semantics — losing it silently drops cross-file repairs.

### 6.5 17 currently-exported pre-repairs have downstream consumers

`engine/stages/review.cjs:2504–2519` exports 17 fns. At minimum `worker/code-reviewer.js` and `worker/codex-reviewer.js` consume some (per CLAUDE.md context references). Step 3's "delete from review.cjs" must keep those 17 names re-exported (via `require('../lib/static-rule-prerepair.cjs')`). Grep `require.*stages/review` confirms downstream surface before deleting bodies.

---

## 7. Effort estimate

| Step | Hours | Notes |
|---|---|---|
| Step 1 — registry + `non-ascii-resource-key` migration | 1.5 | Includes adding a missing unit test for `sanitizeNonAsciiResourceApiKeys` if absent. |
| Step 2 — `runAllPreRepairs` thin shim + snapshot validation | 4 | Includes building the `fixes` snapshot test against 5+ canonical project archive runs. |
| Step 3a — function motion (25 fns) into lib | 3 | Mechanical, one commit per logical group of 3–5 fns. |
| Step 3b — migrate remaining 8 rule whitelists to registry | 2 | One small commit per pair. |
| Step 3c — delete inline mirror in `repairKnownStructuralDamage` | 1 | Verify zero downstream regressions, ship. |
| Buffer for snapshot-test failure diagnosis | 2 | Each failure is ~30 min to locate (order? regex escape? helper fn motion?). |
| **Total** | **~13.5 h** | **Mid-effort: 1.5–2 working days.** |

This is a deliberately conservative estimate — the function-motion step is the wild-card. If snapshot tests fail on the first attempt for step 2 (high likelihood given the 3-pass ordering subtlety), expect +4h to diff and re-align.

---

## 8. Validation plan

1. **Snapshot tests for `fixes` array**: Pick 5 canonical recent project task archives (e.g. from `server-data/task-logs/`), capture pre-refactor `repairKnownStructuralDamage` `fixes` output (the array of `'main:Tag xN'` and `'name:Tag xN'` strings). Post-refactor: assert byte-equal.
2. **`npm test` baseline preserved**: 89 files / 279 cases / 0 failures per `project_test_runner_unification.md`.
3. **Per-pre-repair unit tests** added for at least the 10 pairs with registry-shared config. Each test: a tiny snippet that triggers the rule, run pre-repair, assert (a) output passes the rule and (b) `fixes` count is as expected.
4. **End-to-end fix-loop regression**: rerun 3 recent "fix-loop converged in N rounds" projects through the pipeline; assert N stays the same. Reduce-loop projects per `project_blueprint_llm_reduction_2026-05-13.md` are sensitive baselines — protect those.
5. **Drift signal**: a future commit that adds an API to `RESOURCE_API_KEY_APIS` should be the **only** change required for both rule and pre-repair to pick it up — verify by writing such a change as a forward test (e.g. add `AddInventory`, write tiny C# triggering it, assert both static-check and pre-repair fire without any further edit).

---

## 9. Decision: is this worth doing?

**Yes, mid-effort (1.5–2 days), high payoff.** The 200-line mirror is a recurring tax on every new pre-repair (3 added in May alone — `stripExcessCameraBackgroundAssignments` 2026-05-12, `rewriteCameraMainToMainCam` 2026-05-12, `sanitizeNonAsciiResourceApiKeys` 2026-05-31). The whitelist-drift surface is silent — when it bites, it costs an LLM round (~$1-2 + 8 min) per affected project until someone notices the asymmetry. Both costs grow linearly with the determinism-push strategy from `project_blueprint_llm_reduction_2026-05-13.md`, so paying down now is cheaper than paying down later.

Step 1 alone (just the registry for the freshest pair) is a 1.5h move with near-zero risk and would already prevent the most likely near-term drift. Recommend shipping step 1 standalone if step 2/3 cannot be scheduled together.
