# Option C — Source-Faithful Luna Build (Scoping)

**Date**: 2026-05-31  
**Author**: pipeline / fidelity-source-diff incident response  
**Status**: Scoping (NO code changes in this doc — design only)  
**Companion**: `/opt/blueprint-editor/docs/incidents/fidelity-drift-2026-05-31.md` (Option A/B already covered; this doc fleshes out § 4 Option C)  
**Feature flag (proposed)**: `OPTION_C_SOURCE_FAITHFUL_BUILD=true`

---

## 1. Problem statement

After Option B (per-project `fidelityContract` synthesis via `engine/stages/fidelity-contract-synthesize.cjs`) field-level diffs aligned to the correct project, but the **pixel** gate of `engine/stages/fidelity-source-diff.cjs` is still failing all phases at 99%+ for every project that finishes the 12-stage pipeline.

Concrete evidence (one of the 7 in-flight projects):

| Project | Task | report.json | phase1 | phase2 | phase3 | phase4 | `summary.blocking` |
|---|---|---|---|---|---|---|---|
| 太空卖氧气 | `proj_1780204936627_xaqj54` | `/opt/blueprint-editor/server-data/webgl/proj_1780204936627_xaqj54/fidelity-source-diff/report.json` | **99.26%** (line 491) | **99.81%** (line 939) | **99.69%** (line 1359) | **99.37%** (line 1767) | 94 (line 8) |

Threshold is 5% (`engine/stages/fidelity-source-diff.cjs:resolvePixelGateThreshold`). All 4 phases are ~20× over budget.

### What the diff is actually picking up

The pixel diff captures **geometric / chromatic divergence**, not entity-naming. We confirmed in `docs/incidents/fidelity-drift-2026-05-31.md` § 1 that even with correct labels and correct camera background applied by the overlay, the **mesh vocabulary** is wrong:

| Layer | Source (three.js HTML, `server-data/project-sources/<pid>/source.html`) | Target (Luna WebGL build) |
|---|---|---|
| Per-entity geometry | `buildEntity(name)` factory dispatches kind-switch: <br>• `station`: BoxGeometry(3.2,.45,3.2) + CylinderGeometry(.32,.42,2.6,10) + half-Sphere dome + CylinderGeometry antenna + 2× BoxGeometry solar panels + emissive screen <br>• `machine`: BoxGeometry(1.3,1.5,1.3) + CylinderGeometry chimney + emissive screen + 4× leg boxes <br>• `tool`: CylinderGeometry base + CylinderGeometry housing + **ConeGeometry tip** + TorusGeometry ring <br>• `npc`: cylindrical body + sphere head + helmet shell + 2× tilted-cylinder arms <br>• `collectible`/`IcePile`: 6× IcosahedronGeometry shards <br>• `beacon`: cylinder pad + tall cylinder pole + glowing sphere + TorusGeometry ring | Per-entity render is a single primitive selected from the `__Pool_Cube_NN` / `__Pool_Sphere_NN` / `__Pool_Cylinder_NN` / `__Pool_Plane_NN` pool (see `worker/GFM_Create.cs:56–85` `PoolGet` returning `GameObject.CreatePrimitive(type)`), then `worker/linux-bridge-build.js:1010` `applyStoryboardVisualOverlay` *paints* the diffuse colour and attaches a world label, optionally adding a hard-coded `buildStyledComposite` decoration for **only 9 hard-coded `kind` values** at line 1389+ (`astronaut`/`ship`/`station`/`counter`/`pad`/`crystal`/`debris`/`cargo`/`base`/`beacon`/...). |
| Mesh count per entity | 5–8 composite meshes (counted via `grep -c "new THREE.Mesh\|MeshStandardMaterial" source.html` = 50 in `proj_1780204936627_xaqj54`) | 1 pooled primitive (+ a hard-coded composite if the `kind` happens to be in the `buildStyledComposite` switch — but the switch is closed and per-project `kind` strings such as `blueprint`/`collectible` for `OxygenBalloon` fall to the `box` default) |
| Material | `MeshStandardMaterial` w/ `metalness`/`roughness`/`emissive`/`emissiveIntensity` + `transparent`/`opacity` | `pc.StandardMaterial` with only `diffuse`+`emissive` written by overlay; no metalness/roughness preserved from source |
| Camera | PerspectiveCamera(60°, aspect, 0.1, 200), `camera.position.set(0,18,16); camera.lookAt(0,0,0)` (oblique iso) | `AI_Camera` set elsewhere in `linux-bridge-build.js` (default top-down); only `clearColor` is taken from `sceneContract.backgroundColor` (line 1261–1281) — pose/FoV not synchronised |
| Lighting | AmbientLight 0.55 + DirectionalLight 1.2 @ (12,22,10) + PointLight rim 0.5 @ (-10,5,-12) range 65 | Single hard-coded `AI_Light` directional @ (50°, -30°, 0°) intensity 1.0 (line 1001–1008); overlay only re-writes `directionalLight.color/intensity` from sceneContract (line 1282–1285); no rimLight; no ambient match |

Net effect: ~100% pixel divergence, dominated by **mesh geometry mismatch** > **camera FoV/pose mismatch** > **lighting mismatch**. Option B fixed labels and per-project entity names; it did not (and was never designed to) close geometry.

---

## 2. Current architecture (rendering paths)

```
┌───────────────────────────────────── SOURCE HTML PATH (ground truth) ────────────────────────────────────┐
│                                                                                                          │
│  source.html (944 lines, e.g. proj_1780204936627_xaqj54)                                                 │
│    ├─ top-level: PHASES[], ENTITY_STYLE, ENTITY_POSITIONS, SCENE_CONFIG  (L1/L7/L8 contract)             │
│    ├─ top-level: var models = {}                                                                         │
│    └─ function buildEntity(name) {                                  ← L7 kind-switch dispatch            │
│         var kind = ENTITY_STYLE[name].kind;                                                              │
│         if (kind === "station") { /* 7 THREE.Mesh + Cylinder + Sphere + 2× Box + emissive screen */ }    │
│         else if (kind === "machine") { /* 1 Box + 1 Cylinder chimney + 1 emissive + 4 Box legs */ }      │
│         else if (kind === "tool") { /* Cylinder base + Cylinder body + CONE tip + Torus ring */ }        │
│         else if (kind === "npc") { /* Cylinder body + Sphere head + helmet + 2× tilted Cylinder arms */} │
│         ...                                                                                              │
│         g.position.set(pos.x, pos.y||0, pos.z);  scene.add(g);  models[name] = g;                        │
│       }                                                                                                  │
│    → driver: Object.keys(ENTITY_STYLE).forEach(buildEntity)                                              │
│    → render: three.js WebGLRenderer (PerspectiveCamera 60°, ambient/dir/rim lights, fog, ground)         │
│                                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              │  fidelity-source-diff.captureFrame(sourceUrl)
                                              │  → playwright screenshot @ phaseN  (TRUE pixels)
                                              ▼

┌────────────────────────────────────── LUNA WEBGL BUILD PATH ──────────────────────────────────────────────┐
│                                                                                                           │
│  spec.entities[] (from upstream source-ir / storyboard pipeline; each has visual.shape: Cube/Sphere/...)  │
│    │                                                                                                      │
│    ▼                                                                                                      │
│  adapters/skeleton-generator.cjs                                                                          │
│    → emits GFM_Create.Obj(PrimitiveType, pos, scale, "EntityName")                                        │
│      (lines 470–490 of skeleton-generator emit `// 不要调用 GFM_Create.Obj()…` BUT the actual entity      │
│       construction is delegated to GameSceneCtrl/RegisterEntityBindings + GFM_Pool pre-baked pool)        │
│    → no mesh composition, no material metalness, no per-entity scale beyond a single uniform vector      │
│                                                                                                           │
│  worker/GFM_Create.cs:56-85 PoolGet                                                                       │
│    → `GameObject.CreatePrimitive(PrimitiveType.Cube/Sphere/Cylinder/Plane)` from a fixed pool             │
│    → returns ONE primitive object named __Pool_Cube_NN                                                    │
│                                                                                                           │
│  worker/linux-bridge-build.js:1010  applyStoryboardVisualOverlay()                                        │
│    ├─ hideTemplateVisuals(root)            (line 1238)   → hides __Pool_*  / Label_*  / Canvas roots      │
│    ├─ sets cam.clearColor from contract    (line 1261)                                                    │
│    ├─ sets directionalLight color/intensity (line 1282)                                                   │
│    ├─ spawns optional StoryboardGround / Stars / OrbitalRings (line 1286–1324)                            │
│    ├─ buildStyledComposite(kind)            (line 1389–1464)                                              │
│    │    HARD-CODED switch on 9 kinds (`astronaut`/`ship`/`station`/`counter`/`tool`/`machine`/`npc`/      │
│    │    `blueprint`/`beacon`/…). For each kind, calls addStyledPart() 5–7 times,                          │
│    │    each producing one BPS_<name>_<idx> child entity backed by another __Pool_* primitive.            │
│    │    *Per-project entities whose kind is not in the switch fall through to overlay-paint only.*        │
│    └─ paints diffuse on remaining primitives via overlayMaterial()                                        │
│                                                                                                           │
│  Result: scene tree top-level has only `Canvas / LabelBG / Text`                                          │
│  (confirmed by report.json:108 "visibleEntities":["Canvas","LabelBG","Text"])                             │
│  Entities exist nested under __Pool_* or BPS_*_<idx> deep nodes.                                          │
│                                                                                                           │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              │  fidelity-source-diff.captureFrame(targetUrl)
                                              │  → playwright screenshot @ phaseN  (Luna pixels)
                                              ▼
                                  pixel diff (pixelmatch) → ~99% per phase
```

The architectural debt is `linux-bridge-build.js:1010` overlay being a **post-hoc paint job** rather than a primary mesh builder. Option C inverts this: meshes are built source-faithfully at scene-construction time, and the overlay degrades to label-only.

---

## 3. Solution design (4 steps)

### Step 1 — Contract extension (L9 in `engine/storyboard2html-prompt.cjs`)

**Goal**: require source.html to expose a *deterministic, side-effect-free* description of each entity's composite mesh, alongside the existing `buildEntity` factory.

**Why a new field, not "just parse `buildEntity`"**: `buildEntity` is JS with closures, random ranges (`IcePile` uses `Math.random()` for shard positions — `source.html` line 260–262), and material parameters that don't map directly to PlayCanvas. Parsing arbitrary JS would be a non-starter; we want LLM to emit a normalized data shape.

**New surface** (added to `engine/storyboard2html-prompt.cjs` after line 256, before `## 禁止反规则`):

```
## L9 — Mesh-op contract (Luna source-faithful build,Option C 1.1+)
- 顶层 *再* 声明 `var meshOps = {}`(允许 `let` / `const` / `window.meshOps`,*不能* 闭包内):
  - key 集合 = ENTITY_STYLE keys(完全一致;两边都得有)
  - value = 1..N 个 mesh-op 字面对象组成的纯数组;每个 op 描述一个原子 mesh,*无 lambda、无 closure、无 Math.random/Date.now/THREE 引用*。
  - 必含字段:
    - `kind`:  `"box" | "sphere" | "cylinder" | "cone" | "plane" | "torus" | "icosahedron"`(全小写;Luna 端 switch dispatch 用)
    - `position`: `[x,y,z]` 数值字面量(相对 entity 原点)
  - 可选字段:
    - `rotation`: `[x,y,z]` 欧拉角度(degree)
    - `scale`: `[x,y,z]`(默认 1,1,1)
    - `size`: 不同 kind 含义不同; box → `[w,h,d]`, cylinder/cone → `[rTop,rBottom,h]`, sphere/icosahedron → `[r]`, plane → `[w,h]`, torus → `[radius,tube]`
    - `color`: `0xRRGGBB`(默认继承 ENTITY_STYLE[name].color)
    - `emissive`: `0xRRGGBB`(默认 `0x000000`)
    - `emissiveIntensity`: 0~1(默认 0)
    - `metalness`: 0~1(默认 0)
    - `roughness`: 0~1(默认 1)
    - `opacity`: 0~1(默认 1;<1 时 PlayCanvas 自动 enable blendType)
- 源 HTML 渲染仍按现有 `buildEntity` 装配 three.js Mesh — meshOps *不是替代* buildEntity,是 *并行声明事实*。允许使用 helper:
  `function emitMeshOp(name, op) { meshOps[name] = meshOps[name] || []; meshOps[name].push(op); }`
  然后 `buildEntity` 内部每 `new THREE.Mesh(...)` 后立刻 `emitMeshOp(name, {kind:"box", position:[0,1.15,0], size:[0.82,1.12,0.48], color: base})`。
- `meshOps` 内所有数值必须为字面量(Number / Array of Number / 0xRRGGBB),*不能* 引用 `ENTITY_STYLE[X].color` 等运行时表达式 — extractor 是 *静态 JSON 解析* 不跑 JS。
- 禁止把 `meshOps` 写在 IIFE / scene 闭包 / function 内部。必须 *顶层* var,在 `Object.keys(ENTITY_STYLE).forEach(buildEntity)` driver 跑过后 *也* 同步可读(extractor 顺路兼容两种填法:静态字面 + runtime-populated)。
- 兜底:`meshOps[name]` 缺失或空数组时,Luna 端 fall back 到现有 spec.entities[].visual.shape pooled-primitive 路径(等价老行为)。
```

**Touch**: `engine/storyboard2html-prompt.cjs` — insert ~50 lines after L8.5 block, before `## 禁止反规则` at line 219.

**Owner**: prompt engineer.  
**Effort**: 1 day (write prompt + run 7 in-flight project regen + diff outputs to confirm `meshOps` populated).

### Step 2 — Source mesh extraction stage

**Goal**: at pipeline time, run source.html headless and capture `window.meshOps` as JSON, attach to `ctx.blueprint.sourceMeshOps`.

**New file**: `engine/stages/source-mesh-extract.cjs` (~180 LOC).

**Shape** (sketch only):

```js
'use strict';
// Runs AFTER fidelity-contract-synthesize, BEFORE codegen.
// Headless-renders source.html (playwright chromium, reuses fidelity-source-diff.serveSingleFile),
// waits for window.__fidelityReady===true (L8.5 contract guarantees this fires after one render tick),
// reads window.meshOps via page.evaluate, validates shape, writes to ctx.

module.exports = {
  name: 'source-mesh-extract',
  canSkip: function(ctx) {
    if (process.env.OPTION_C_SOURCE_FAITHFUL_BUILD !== 'true') return true;  // flag-gated
    if (!ctx.sourceHtmlPath) return true;                                    // soft-mode upstream
    return false;
  },
  run: async function(ctx) {
    var playwright = require('/opt/blueprint-editor/node_modules/playwright');
    var browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
    try {
      var server = await serveSingleFile(ctx.sourceHtmlPath);   // reuse helper
      var page = await browser.newPage();
      await page.goto(server.url, { waitUntil: 'load' });
      await page.waitForFunction('window.__fidelityReady === true', { timeout: 8000 });
      var meshOps = await page.evaluate(function() {
        return JSON.parse(JSON.stringify(window.meshOps || {}));  // strip closures, deep-clone
      });
      var report = validateMeshOps(meshOps, ctx.blueprint && ctx.blueprint.fidelityContract);
      if (!report.valid) {
        ctx.addLog('source-mesh-extract', 'invalid meshOps: ' + report.reason + ' — falling back to overlay');
        return;
      }
      ctx.blueprint = ctx.blueprint || {};
      ctx.blueprint.sourceMeshOps = meshOps;
      ctx.blueprint.sourceMeshOpsReport = {
        entityCount: Object.keys(meshOps).length,
        totalOps: Object.keys(meshOps).reduce(function(s,k){return s + meshOps[k].length;}, 0),
        producerVersion: 'source-mesh-extract@0.1'
      };
      ctx.addLog('source-mesh-extract', 'extracted ' + report.entityCount + ' entities, ' + report.totalOps + ' ops');
    } finally { await browser.close(); }
  }
};

// validateMeshOps: every entity in ctx.fidelityContract.entities has ≥1 op;
// every op has valid `kind` ∈ {box,sphere,cylinder,cone,plane,torus,icosahedron};
// every numeric field is finite; no array length > 32 per entity (sanity); no string field > 64 chars.
```

**Position in pipeline** (`engine/pipeline.cjs:478–495`):

```
sourceHtmlBindStage                       (existing, line 478)
fidelityContractSynthesizeStage           (existing Option B, line 479)
sourceMeshExtractStage                    ← NEW (insert between 479 and 480)
cloneStage                                (existing, line 480)
... rest unchanged ...
```

**Touch**: `engine/pipeline.cjs` line 480 area (single insert).  
**Owner**: pipeline integrator.  
**Effort**: 2 days (stage + tests + fallback wiring).  
**Blocker for**: Step 3 (skeleton needs `ctx.blueprint.sourceMeshOps`).

### Step 3 — Skeleton C# emission for source-faithful meshes

**Goal**: emit C# that reads `ctx.blueprint.sourceMeshOps` and builds composite GameObjects with matching primitives, replacing the per-entity single-pool-primitive path.

**Touch**:
- `adapters/skeleton-generator.cjs` — extend the entity registration block (around the comments at lines 477–479 "不要调用 GFM_Create.Obj() / 对象池绑定统一走 GameSceneCtrl/RegisterEntityBindings()") to instead emit a `BuildSourceFaithfulMeshes()` method that walks `sourceMeshOps` per entity.
- `worker/GFM_Create.cs` — add a new helper `Composite(string entityName, MeshOpSpec[] ops)` next to `Obj(...)` at line 98. The helper instantiates one root `GameObject` per entity + N child `GameObject.CreatePrimitive(...)` per op, sets local position / Euler / scale, swaps in a `Material` with diffuse + emissive + (later) metallic/smoothness mapped from PBR. The hot-path rule `update-new-vector-in-hot-path` (`engine/static-check.cjs:1073`) only fires inside `Update/MovePlayer/CheckEventRules/AutoPlayUpdate` — `Composite()` runs at `Start()` / phase-enter, so `new Vector3(...)` is legal there. We must NOT generate Composite-call sites inside the hot 4 functions.

**Sample data → C# mapping**:

Source meshOp JSON for `DrillUpgradeStation` (kind `tool`):
```json
[
  {"kind":"cylinder", "position":[0, 0.20, 0], "size":[0.90, 1.10, 0.40], "color":0x888888, "metalness":0.7, "roughness":0.3},
  {"kind":"cylinder", "position":[0, 0.95, 0], "size":[0.55, 0.75, 1.10], "color":0xff6644, "metalness":0.6, "roughness":0.4},
  {"kind":"cone",     "position":[0, 1.95, 0], "size":[0.28, 0,    0.90], "color":0xffdd22, "emissive":0x886600, "emissiveIntensity":0.3, "metalness":0.9},
  {"kind":"torus",    "position":[0, 0.06, 0], "rotation":[90,0,0], "size":[0.90, 0.09], "color":0x666688, "metalness":0.8}
]
```

Generated C# (one helper called once at scene init):
```csharp
// SOURCE-FAITHFUL MESH BUILDER (Option C, generated by adapters/skeleton-generator.cjs)
private void BuildEntity_DrillUpgradeStation()
{
    GameObject root = new GameObject("DrillUpgradeStation");
    root.transform.position = new Vector3(-7f, 0f, -6f);  // ENTITY_POSITIONS["DrillUpgradeStation"]

    GFM_Create.AddCompositePart(root, PrimitiveType.Cylinder,
        new Vector3(0f, 0.20f, 0f), new Vector3(0f,0f,0f),
        new Vector3(0.90f, 1.10f, 0.40f),
        new Color(0.53f, 0.53f, 0.53f), Color.black, 0f, 0.7f, 0.3f, 1f);

    GFM_Create.AddCompositePart(root, PrimitiveType.Cylinder,
        new Vector3(0f, 0.95f, 0f), new Vector3(0f,0f,0f),
        new Vector3(0.55f, 0.75f, 1.10f),
        new Color(1.00f, 0.40f, 0.27f), Color.black, 0f, 0.6f, 0.4f, 1f);

    // cone → CreatePrimitive(Cylinder) with size.r2=0 trick (Luna lacks ConeGeometry)
    GFM_Create.AddCompositePart(root, PrimitiveType.Cylinder,
        new Vector3(0f, 1.95f, 0f), new Vector3(0f,0f,0f),
        new Vector3(0.28f, 0.001f, 0.90f),
        new Color(1.00f, 0.87f, 0.13f), new Color(0.53f, 0.40f, 0f), 0.3f, 0.9f, 1f, 1f);

    // torus → primitive Torus unavailable in Luna; emit ring-of-cubes fallback (12-segment)
    GFM_Create.AddTorusRing(root, /*center*/ new Vector3(0f,0.06f,0f),
        /*rotation*/ new Vector3(90f,0f,0f), /*radius*/0.90f, /*tube*/0.09f,
        /*segments*/12, new Color(0.40f, 0.40f, 0.53f), 0.8f);

    GameSceneCtrl.RegisterEntityBinding("DrillUpgradeStation", root);
}
```

(Note `ConeGeometry` and `TorusGeometry` have no direct Unity primitive — see § 5 risk.)

**Owner**: skeleton-generator engineer.  
**Effort**: 4–5 days (`adapters/skeleton-generator.cjs` 2d + `worker/GFM_Create.cs:Composite` 1d + 7 sample-project regression 2d).  
**Blocker for**: pixel diff < 30%.

### Step 4 — `SCENE_CONFIG` → Luna camera / lighting / fog

**Goal**: piping `SCENE_CONFIG` (already extracted into `ctx.blueprint.fidelityContract.scene` by Option B's synthesizer at `engine/stages/fidelity-contract-synthesize.cjs:331`) all the way into runtime camera pose, ambient + directional + rim lights, and fog.

**Touch**:
- `worker/GFM_CameraController.cs` — extend `Init()` to read `window.__BLUEPRINT_VISUAL_ASSETS__.fidelityContract.scene.camera`(perspective FoV, near/far) and `.position` (the iso (0,18,16) pose). Today camera is hard-coded.
- `worker/linux-bridge-build.js:1001–1008` — the `AI_Light` block hard-codes directional intensity 1.0 and angles 50,-30,0. Replace with reads of `sceneContract.directionalLight.position` (convert to Euler) and `.intensity`.
- New `AI_AmbientLight` + `AI_RimLight` entities sourced from `sceneContract.ambientLight` and `sceneContract.rimLight`.
- Fog: PlayCanvas has `pcApp.scene.fog = 'linear'` + `fogStart` + `fogEnd` + `fogColor`. Map from `sceneContract.fog.{color,near,far}`.
- Ground: today `worker/linux-bridge-build.js:1288–1298` already spawns `StoryboardGround` from `sceneContract.ground`. Keep, just verify the new mesh-op path doesn't double-spawn.

**Owner**: same as Step 3 (sequenced after).  
**Effort**: 2 days.  
**Blocker for**: pixel diff < 5%.

---

## 4. Effort + ownership matrix

| Step | Files touched | Net LOC | Owner role | Effort | Blocks | Can parallel with |
|---|---|---|---|---|---|---|
| 1. L9 contract | `engine/storyboard2html-prompt.cjs` (+50 line at line 256) | +50 | prompt engineer | 1d | Step 2 | (none, must land first) |
| 2. mesh extract stage | NEW `engine/stages/source-mesh-extract.cjs` (~180) + `engine/pipeline.cjs:480` (1 line) + test `test/source-mesh-extract.test.cjs` (~120) | +300 | pipeline integrator | 2d | Step 3 | Step 1 (after L9 lands in prompt) |
| 3. skeleton C# composite | `adapters/skeleton-generator.cjs` (~+150 around lines 470–490) + `worker/GFM_Create.cs` (+1 method `Composite` ~80 LOC after line 110; +1 helper `AddTorusRing` ~30) | +260 | skeleton-generator engineer | 4–5d | Step 4 | none — *blocked by Step 2* |
| 4. SCENE_CONFIG → camera / lighting | `worker/GFM_CameraController.cs` (+30) + `worker/linux-bridge-build.js:1001–1008` (rewrite ~20 lines) + `worker/linux-bridge-build.js:1282–1285` (extend) + ambient/rim/fog blocks (~60 LOC inserted near 1286) | +120 | scene engineer | 2d | (closes pixel-diff to <5%) | Step 3 (parallel-OK; touches different files) |

**Critical path**: Step 1 (1d) → Step 2 (2d) → Step 3 (5d) → Step 4 (2d, parallel-OK with end of 3). **Total wall-clock**: ~8 working days, **10 days with buffer for 7-project regression smoke** = ~2 weeks. Matches the original § 4 estimate.

---

## 5. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **L9 breaks 7 existing source.html** (no `meshOps` declared → extractor returns `{}` → Step 2 falls back to old overlay path) | High (certain) | Low (bypass is engineered: fallback to old path is the design intent) | Already accounted for via fallback in `source-mesh-extract.cjs:canSkip` and `meshOps[name]` empty-check in skeleton emission |
| R2 | **LLM (claude-opus-4-8 / gpt-5.5) unable to emit `meshOps` stably**. Each `buildEntity` branch already emits 5–8 `new THREE.Mesh(...)`; LLM has to mirror each into a literal op block. | Medium (regen-eval needed) | High (Option C dead in water if regen rate < 90%) | (a) Prompt design uses `emitMeshOp(name, {...})` helper *right next to* each `new THREE.Mesh`, reducing skip risk; (b) extractor `validateMeshOps` returns `valid:false` on missing entities so Option C silently degrades; (c) optional fallback: at extract time, parse `buildEntity` AST with `acorn` and *synthesize* meshOps from `new THREE.X(...)` calls — this is a tier-2 fallback worth scoping if R2 fires. Recommended LLM eval: regen 3 sample source.htmls × 5 runs each = 15 trials; require ≥ 14/15 produce coverage ≥ 90% of ENTITY_STYLE keys |
| R3 | **`worker/linux-bridge-build.js:1010` overlay co-existence** during phased rollout. If Step 3 emits BPF_<name> root entities AND overlay still runs `buildStyledComposite`, we get double meshes | Medium | Medium | Add env flag check in `applyStoryboardVisualOverlay`: when `OPTION_C_SOURCE_FAITHFUL_BUILD === 'true'` AND `manifest.sourceMeshOps` non-empty, skip `buildStyledComposite` block (line 1389–1464) but KEEP label / camera / lighting block. Phase out gradually: per-project flag bake into manifest |
| R4 | **`new Vector3` hot-path rule** (`engine/static-check.cjs:1073` `update-new-vector-in-hot-path`) blocks Step 3 emit | Low (we know hot fns) | High (blocking review gate) | Verified at L1074: rule scope = `Update`, `MovePlayer`, `CheckEventRules`, `AutoPlayUpdate` ONLY. `BuildEntity_X()` / `BuildSourceFaithfulMeshes()` run at `Start()` / phase-enter — not in scope. No new whitelist needed. Static-check unit test must confirm with a generated sample. |
| R5 | **ConeGeometry / TorusGeometry have no Unity primitive**. Cone is `Cylinder` w/ top-radius 0; Torus is procedural | Medium | Low | (a) Cone: emit `PrimitiveType.Cylinder` with `size[1]=0.001f` (tip radius zero) — visually acceptable; (b) Torus: emit "ring-of-N-cubes" or "ring-of-N-cylinders" approximation in `GFM_Create.AddTorusRing(N=12)` helper. Both have visible visual cost vs three.js, but on screenshot resolution (likely ~360px) acceptable |
| R6 | **IcosahedronGeometry** (used by `IcePile`, 6 shards) has no Unity primitive | Low | Low | Emit 6× `PrimitiveType.Sphere` with rotation jitter. Visually close enough; alternatively emit a Sphere with `Renderer.material.shader = "Crystal"` shader (cosmetic-only) |
| R7 | **Material PBR mismatch**: three.js `MeshStandardMaterial.metalness/roughness/emissive` vs PlayCanvas/Unity `Material`. Pure `_Color`/`_BaseColor` setParameter (line 1059–1063) ignores PBR | Medium | Medium-High (residual pixel diff after Step 3) | Step 3 emits `r.material = new Material(_baseMat)` and sets diffuse + emissive + emissiveIntensity. Skip metalness/roughness in v0.1 (the `_baseMat` already covers ambient). Re-evaluate after first pixel-diff measurement; metallic/smoothness shader properties exist in Unity Standard shader (`_Metallic`, `_Glossiness`) and can be set via `r.material.SetFloat("_Metallic", op.metalness)` |
| R8 | **Camera FoV / pose change in Step 4 may break visible labels and joystick UI** (HUD canvas anchored against old camera matrix) | Medium | Medium | HUD `Canvas` should be in `Screen Space - Overlay` mode (camera-independent). Verify in `worker/GFM_UIManager.cs`. If `Screen Space - Camera`, switch mode in same PR |
| R9 | **Pixel diff still > 5% post-Step-4** because of font / antialias / DPR differences between three.js renderer and Luna WebGL | Low-Medium | Low (lower acceptable threshold) | Adjust `FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT` to 15% as practical target. Source vs target both run in playwright chromium at same viewport so this should be small |
| R10 | **`adapters/skeleton-generator.cjs` is "the most fragile path"** (CLAUDE.md `project_cleaner_blast_radius`) — every Unity export hits it | High | High | Behind feature flag `OPTION_C_SOURCE_FAITHFUL_BUILD=true` env. Old path is untouched when flag=false. Roll out one project at a time |

**Overall risk grade**: **Medium**. The hardest items are R2 (LLM emit stability) and R7 (material PBR fidelity); both have viable fallbacks. R10 is the structural risk and is fully mitigated by the feature flag.

---

## 6. Verification strategy

### 6.1 Smoke (in-loop, after each step)

1. **After Step 1**: regen source.html for 3 known projects via `node scripts/storyboard2html-smoke.cjs` (the existing Playwright-driven smoke runner). Assert `window.meshOps` non-empty for every ENTITY_STYLE key. Acceptance: ≥ 90% coverage on first run, ≥ 95% after one prompt iteration.
2. **After Step 2**: run pipeline through `source-mesh-extract` on the 3 projects. Assert `ctx.blueprint.sourceMeshOps` shape valid. No downstream impact yet (skeleton ignores until Step 3).
3. **After Step 3**: full pipeline for 1 project (`proj_1780204936627_xaqj54`); expect:
   - `report.json`'s `target.visibleEntities` now lists `Player / SpaceBase / IcePile / …` (NOT just `Canvas / LabelBG / Text` as today on line 108)
   - Pixel diff drops from 99% to roughly 30–60% (geometry close, camera + lighting still default)
   - `summary.blocking` decreases significantly
4. **After Step 4**: same project; expect pixel diff < 15% (target 5%); all 4 phases under threshold; `summary.blocking == 0`.

### 6.2 Regression

- Run all 7 in-flight projects (`proj_1776391516726_urbib0` ... `proj_1777128165822_6acnqx` + the 2 new incident projects) end-to-end. None should fail any stage that previously passed. Pixel-gate failure is the OK signal pre-step-4.

### 6.3 Smoke runner integration

Extend `scripts/storyboard2html-smoke.cjs` to additionally dump `meshOps` shape with counts per entity. Useful for prompt iteration loops.

### 6.4 Existing tests to extend

- `test/fidelity-contract-produce.test.cjs` — add: when `ctx.blueprint.sourceMeshOps` present, contract should carry `entities[].meshOpsRef` pointing to its bucket.
- NEW `test/source-mesh-extract.test.cjs` — happy path + 3 failure modes (no html, no meshOps, malformed meshOps).
- NEW `test/skeleton-generator-source-faithful.test.cjs` — fixture sourceMeshOps → expected C# snippet.

---

## 7. Rollout phases (feature-flagged)

```
FLAG OFF (default)          → existing pipeline behavior (Option B is the floor)
FLAG ON  + 1 pilot project  → after Step 3, run flag=true on `proj_1780204936627_xaqj54`
                              compare pixel diff, sign off
FLAG ON  + all incident-pair projects (2)  → after Step 4
FLAG ON  + 7 in-flight + 2 incident (9 projects)   → all-projects rollout
FLAG ON  + default (flag dropped)   → after 1 week of green pipelines, remove the env check
                                       and the overlay `buildStyledComposite` switch
```

Env-flag location: read in `source-mesh-extract.cjs:canSkip` (Step 2), `adapters/skeleton-generator.cjs` entity-block emission (Step 3), and `worker/linux-bridge-build.js:applyStoryboardVisualOverlay` overlay degradation (Step 3 side-effect). Single env var, three read sites.

---

## 8. Out of scope (explicitly NOT in Option C v1)

- **Animation**: source.html runs per-phase tween animations (e.g. `models.OxygenBalloon.position.y` bobble at `source.html:796`). Luna already has `GFM_SmoothMover` (see CLAUDE.md `feedback_observable_movement_via_smoothmover`). Animation parity is a separate workstream.
- **Shadows**: source.html sets `PCFSoftShadowMap`; Luna disables shadows by default for perf. Out of scope.
- **Particle effects** beyond ambient stars (which the overlay already produces): out of scope.
- **Audio sync**: not in scope of pixel diff.
- **Dynamic geometry** (e.g. drill activating, drill rod extending): out of scope; only the *static initial pose* of each entity is matched.

---

## 9. Open questions

1. Should `meshOps` be parsed by static AST (acorn) of source.html *instead of* `page.evaluate(() => window.meshOps)`? Trade-off: AST avoids Playwright cost (~5s/project) but cannot fold runtime initializers. **Tentative: stick with Playwright `page.evaluate` for v1; AST is a v2 perf optimization.**
2. Should `_baseMat` in `GFM_Create.cs:42` switch from `Shader.Find("Standard")` to a custom shader supporting per-instance emissive intensity? Affects R7. **Tentative: defer to a Step-3 sub-task if pixel diff > 30% after Step 4.**
3. Should we also extract `models[name].position` runtime overrides from source HTML (some entities position themselves slightly off `ENTITY_POSITIONS` — e.g. `OxygenBalloon` y=1.3)? **Tentative: yes, sample `models[name].position` in the same `page.evaluate` and merge with `ENTITY_POSITIONS`.**

---

## 10. Summary

Option C is feasible and decomposes into 4 sequential steps (Step 1–2 prep, Step 3 the heavy lift, Step 4 the polish) over ~2 weeks. The biggest risks are LLM emit stability (R2) and material PBR fidelity (R7), both mitigated. The entire deliverable is gated behind `OPTION_C_SOURCE_FAITHFUL_BUILD=true` so default pipeline (running Option B today) is not perturbed. Expect pixel-diff convergence: 99% → 30–60% after Step 3 → <15% after Step 4 (5% achievable with material tuning, R7).

**Risk grade**: **MEDIUM**.
