# Fidelity Drift Incident — 2026-05-31

## 1. Problem statement

Two projects through the storyboard → Luna WebGL pipeline are failing `fidelity-source-diff` with `99%+` per-phase pixel divergence and `17–18` blocking field-level diffs. The gate is hard-blocking pipeline completion (`pipeline-end: success=false, failedAtStage=fidelity-source-diff`).

| Project | Task ID | Source HTML (project-specific) | Pixel diff (max) | Blocking field diffs | Phases over 5% threshold |
|---|---|---|---|---|---|
| 太空卖氧气 | `proj_1780204936627_xaqj54` | `太空基地 / 冰堆 / 玩家 / 钻头升级台 / …` | **99.48%** (phase3) | 17 (phase1 alone) | 4/4 (99.22 / 99.4 / 99.48 / 99) |
| 太空捡垃圾分镜 | `proj_1780223872392_tnnnjx` | `SpaceGarbage / GarbageSpawner / MetalFragment / AbandonedStation / …` | **99.98%** | 18 (phase1) + 92 total | 5/5 |

Evidence files:
- `/opt/blueprint-editor/server-data/webgl/proj_1780204936627_xaqj54/fidelity-source-diff/report.json` (71 KB)
- `/opt/blueprint-editor/server-data/webgl/proj_1780204936627_xaqj54/fidelity-source-diff/source-phase{1-4}.png`
- `/opt/blueprint-editor/server-data/webgl/proj_1780204936627_xaqj54/fidelity-source-diff/target-phase{1-4}.png`
- `/opt/blueprint-editor/server-data/webgl/proj_1780223872392_tnnnjx/fidelity-source-diff/report.json` (91 KB)
- Pipeline log: `/opt/blueprint-editor/server-data/task-logs/proj_1780204936627_xaqj54/pipeline.jsonl` (1043 lines)

### What the screenshots actually show

| Layer | Source (three.js HTML, ground truth) | Target (Luna WebGL build) |
|---|---|---|
| Camera | Isometric 60° FoV, dark deep-blue bg (`0x080818`) | Top-down ortho, full-screen orange/red plane occupies center |
| Entities | astronaut sprite + base cylinder + drill cone + 4 tinted machines + crater decals | a few PlayCanvas primitives (blue cube/U-shape/sphere) on a grey ground |
| HUD | `💰 金币: 0 / Phase 1/4 / 🫧 氧气: 0` + bottom guideText | `Ice: 0 Oxygen: 0 Gold: 0` + `[1/4] 点击飞船降落，启动控制台，拖拽采矿臂对准冰矿` |
| World labels | `玩家 / 太空基地 / 冰堆 / 熔炼炉 / 电解制氧机 / 钻头升级台 / 氧气气球 / 售卖点 …` | `玩家 / 电解制氧机 / 熔炼炉 / 钻头升级台 / 售卖点 / 氧气气球 / 冰堆 / 自动挖冰小人 / 新舱室蓝图` (✅ correct labels, but ATTACHED to the wrong primitives) |
| Title overlay | `拖拽摇杆移动角色，走向太空基地` (from `PHASES[0].guideText` in source HTML) | `[1/4] 点击飞船降落，启动控制台，拖拽采矿臂对准冰矿` (NOT in this project's source HTML at all) |

The title overlay text on the target is **literally lifted from the default reference contract** (see §3, evidence #2).

## 2. Current architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ INPUT                                                                    │
│  server-data/project-sources/<pid>/source.html                           │
│  (944-line three.js HTML; PHASES[]/ENTITY_STYLE/ENTITY_POSITIONS/        │
│   SCENE_CONFIG/buildEntity/models[name]/targetRing/trailLine/laserLine   │
│   at top level — produced by storyboard2html-prompt.cjs L1–L8.5)         │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: source-html-bind                                                │
│  engine/stages/source-html-bind.cjs                                      │
│  → ctx.sourceHtmlPath = "<…>/source.html"  (path bound, content not read)│
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STAGES 2–6: clone → spec-validate → complexity-gate → assembly-plan      │
│              → assembly-complexity-gate → codegen → method-check → review│
│  (produces ctx.blueprint.entities/phases/specs from… upstream source-ir  │
│   or storyboard pipeline — NOT from source.html re-read)                 │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STAGE 7: fidelity-contract-produce  ← SILENTLY SKIPPED                   │
│  engine/stages/fidelity-contract-produce.cjs                             │
│  Logged:                                                                 │
│   "no base contract resolvable from ctx.blueprint.fidelityContract /     │
│    fidelityContractPath — skip"                                          │
│  Reason: there is NO upstream stage that writes                          │
│  ctx.blueprint.fidelityContract for production tasks. See §3 evidence #1.│
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STAGE 8: compile (Luna build)                                            │
│  engine/helpers.cjs::buildVisualAssetsForRequest()                       │
│  Reads ctx.blueprint.visualAssets, augments with `fidelityContract`.     │
│  Resolution order (helpers.cjs:43–52):                                   │
│   (1) ctx.fidelityFieldDiffTemplate.contract                — null       │
│   (2) ctx.blueprint.fidelityContract                        — null       │
│   (3) ctx.fidelityContractPath (file)                       — null       │
│   (4) DEFAULT_FIDELITY_CONTRACT_PATH_FOR_BUILD              — ← USED     │
│       = work/task25-sam-delivery-verify/unpacked/                        │
│         space-ranger-v0.5-fidelity-delivery/unity-project/               │
│         Assets/Fidelity/fidelityContract.json                            │
│  → window.__BLUEPRINT_VISUAL_ASSETS__ = {                                │
│       fidelityContract: <space-ranger reference>,                        │
│       sourceEntityContract: <…>,                                         │
│       entityBindings: <…>, sourceSceneContract: <…>                      │
│     }                                                                    │
│  Then worker/linux-bridge-build.js:1010 applyStoryboardVisualOverlay()   │
│  walks pc.app.root, looks up bindings[name], paints diffuse colors and   │
│  world labels — but the SCENE TREE itself was built from the spec/       │
│  blueprint, NOT from source.html's `models[name]` factories.             │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STAGE 9: fidelity-source-diff (this gate is failing)                     │
│  engine/stages/fidelity-source-diff.cjs                                  │
│  Three things compared, EACH using a different source-of-truth:          │
│   • SOURCE side  ← Puppeteer renders source.html (correct)               │
│   • TARGET side  ← Puppeteer renders compiled HTML, walks pc.app.root    │
│   • CONTRACT     ← resolveFieldDiffTemplate() (line 326–342) picks:      │
│       (1) ctx.blueprint.fidelityContract (>= v1.2)        — null        │
│       (2) ctx.fidelityContractPath                        — null        │
│       (3) DEFAULT_CONTRACT_PATH                           — ← USED      │
│       = same space-ranger reference as helpers.cjs above                 │
│  → The field-diff "expected" entity list (OxygenShop / SellCounter /     │
│    ShipUnlock / SpaceShip / …) comes from this FIXED REFERENCE, not from │
│    the project's own source HTML.                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key code locations (file:line)

| Path | Role |
|---|---|
| `engine/stages/source-html-bind.cjs` | Binds `ctx.sourceHtmlPath`; never writes a contract |
| `engine/stages/fidelity-contract-produce.cjs:13–17` | Comment: "NOT a from-scratch producer" — only enriches an existing base contract |
| `engine/stages/fidelity-contract-produce.cjs:118–123` | `canSkip()` returns true when `loadBaseContract(ctx)` is null |
| `engine/stages/fidelity-contract-produce.cjs:60–78` | `loadBaseContract` only reads `ctx.blueprint.fidelityContract` / `ctx.fidelityContractPath` |
| `engine/helpers.cjs:15–17` | `DEFAULT_FIDELITY_CONTRACT_PATH_FOR_BUILD` = `space-ranger-v0.5` fixture |
| `engine/helpers.cjs:37–67` | `buildVisualAssetsForRequest` — uses default contract when in-memory missing |
| `engine/stages/fidelity-source-diff.cjs:326–342` | `resolveFieldDiffTemplate` — same default fallback |
| `engine/stages/lib/field-diff.cjs:788–870` | `WEBGL_PAGE_EXTRACTOR` — walks `pc.app.root` for top-level CamelCase entities |
| `worker/linux-bridge-build.js:1010–…` | `applyStoryboardVisualOverlay` — paints diffuse + world labels onto the existing scene tree using `manifest.entityBindings` |
| `engine/storyboard2html-prompt.cjs` | (609 lines) emits the canonical source HTML contract |

## 3. Root-cause diagnosis — 3 pieces of empirical evidence

### Evidence #1 — `fidelity-contract-produce` always skips in production

`pipeline.jsonl` (3 separate runs of `proj_1780204936627_xaqj54`):
```
{"stage":"fidelity-contract-produce","event":"log",
 "message":"no base contract resolvable from ctx.blueprint.fidelityContract / fidelityContractPath — skip"}
{"stage":"fidelity-contract-produce","event":"skip","reason":"condition"}
```
Grep across the whole repo for **production code paths** that ever assign `ctx.blueprint.fidelityContract`:
```
$ grep -rn 'blueprint\.fidelityContract\s*=' /opt/blueprint-editor
# matches ONLY in test/*.test.cjs and inside fidelity-contract-produce.cjs itself
# (which reads it from canSkip and only ever READS in production)
```
Conclusion: **no upstream stage writes the contract**. The producer's job is to *enrich*, not *synthesize*. Every production task hits `canSkip → true` and the v1.2 anchor data never lands on the contract.

### Evidence #2 — both projects get the same `space-ranger` reference contract baked into the build

Target HTML `phase1` field of the diff report (line 113–116):
```json
"target": {
  "fields": {
    "phaseSpec": { "guideText": "[1/4] 点击飞船降落，启动控制台，拖拽采矿臂对准冰矿" }
  }
}
```
This text does NOT appear in `proj_1780204936627_xaqj54/source.html` (verified: `grep "点击飞船降落"` over `source.html` → 0 matches; the project's actual phase1 guideText is `拖拽摇杆移动角色，走向太空基地`).

It DOES appear as a field-diff "expected" baseline in the default reference fixture:
```
$ grep '"guideText"' /opt/blueprint-editor/work/task25-sam-delivery-verify/unpacked/\
space-ranger-v0.5-fidelity-delivery/unity-project/Assets/Fidelity/fidelityContract.json
"guideText": "在任意位置拖动摇杆，先到氧气购买台，再去售卖台，最后到解锁台买飞船",
"guideText": "靠近小冰块三次采冰，背包装满后把冰放入飞船货舱",
"guideText": "采集大冰块，沿着航标飞向第一个空间基地",
"guideText": "把冰送进制氧装置，收集氧气售卖，然后升级钻头并离开基地",
"guideText": "用钻头快速凿冰，再钻开舱体残骸，把铁块装进飞船",
…
```
That set of texts is hard-coded into `helpers.cjs:15–17` as `DEFAULT_FIDELITY_CONTRACT_PATH_FOR_BUILD` — both the build's runtime overlay AND the field-diff template fall back to it whenever no per-project contract is in `ctx.blueprint`. The fieldDiffs entity list (`OxygenShop / SellCounter / ShipUnlock / SpaceShip / …` — see `report.json:159–207`) similarly comes from this fixture; **none of those names exist** in the 太空捡垃圾 source HTML, whose actual entities are `SpaceGarbage / GarbageSpawner / MetalFragment / AbandonedStation`.

### Evidence #3 — the Luna scene tree only contains `Canvas/LabelBG/Text` at the root

`fidelity-source-diff` report.json:108–112 (target.visibleEntities, phase1):
```json
"visibleEntities": ["Canvas", "LabelBG", "Text"]
```
This is what `WEBGL_PAGE_EXTRACTOR` (field-diff.cjs:827–860) sees when it walks `pc.app.root` for top-level `/^[A-Z][A-Za-z0-9]*$/` named children with `node.enabled !== false`. So the actual Luna build is NOT spawning per-spec entities (Player/SpaceBase/IcePile/…) as top-level scene nodes. Yet **the world labels in the rendered screenshot are correct** (`玩家 / 电解制氧机 / 熔炼炉 / 钻头升级台`) — which means `applyStoryboardVisualOverlay` at `linux-bridge-build.js:1010` is finding entities **somewhere deeper** (under `__Pool_*` and similar) and tagging them — but with **wrong primitives, wrong layout, wrong camera angle, and no source-faithful geometry**. The visual overlay does its best with whatever generic primitives the spec produced, but it can't reproduce three.js custom `models[name]` factories (e.g. the cone-tipped drill, station with antennae, etc.) — those don't exist in `entityBindings`.

### Root cause summary

> **The `sourceSceneContract` carry-over chain is broken in two places.**
>
> 1. **There is no producer for a per-project `fidelityContract`.** The producer stage only enriches an existing one; nothing in `source-html-bind`, `spec-validate`, `assembly-plan`, `codegen`, or `compile` writes one from the project's own `source.html`. Production always falls through to `DEFAULT_FIDELITY_CONTRACT_PATH_FOR_BUILD` (the `space-ranger-v0.5` fixture).
> 2. **Even if a contract did carry over, the Luna build path materializes the scene from the spec's generic `entities[].visual.shape` (Cube/Cylinder/Sphere) — not from `models[name]` factories in the source HTML.** `applyStoryboardVisualOverlay` only paints diffuse + labels onto whatever primitives already exist. The three.js geometric vocabulary (cone-tipped drill, segmented station, decorated ground, particle stars) never makes it across.
>
> Consequence: `fidelity-source-diff` is comparing (correctly-extracted) source entities vs (a different project's) reference contract entities vs (generic-primitive) target entities — a 3-way mismatch where any single mismatch alone produces ~100% pixel divergence.

## 4. Fix options

### Option A — Short-term: bypass the gate, log advisory only (≈1 h)

**Touch**: `engine/stages/fidelity-source-diff.cjs` (env override already exists)
- Set `FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT=0` in worker env to bypass pixel gate.
- Add a `FIDELITY_FIELD_DIFF_ADVISORY_ONLY=true` env that turns blocking field-diffs into advisory.
- Pipeline continues, build ships, gate logs everything but does NOT fail.

**Files**:
- `engine/stages/fidelity-source-diff.cjs:47–54` (already has env override pattern)
- `worker/ecosystem.linux.config.cjs` or similar PM2 config

**Estimated effort**: 1 h. **Risk**: hides regressions; downstream consumers (CUA, visual-check) keep running on visibly-wrong builds. **Recommend ONLY as emergency unblock.**

### Option B — Mid-term: synthesize per-project fidelityContract from source.html (≈1–2 days) ★ RECOMMENDED

**Touch**:
1. New stage `engine/stages/fidelity-contract-synthesize.cjs` — runs AFTER `source-html-bind`, BEFORE `fidelity-contract-produce`. Parses `source.html`'s top-level `PHASES[]`, `ENTITY_STYLE`, `ENTITY_POSITIONS`, `SCENE_CONFIG` (the L1–L8.5 contract guaranteed by `storyboard2html-prompt.cjs`) and produces a v1.0 `fidelityContract` skeleton, writing it to `ctx.blueprint.fidelityContract`.
2. `fidelity-contract-produce` then enriches v1.0 → v1.2 → v1.3 as it already does (no changes there).
3. `helpers.buildVisualAssetsForRequest` keeps the same precedence — but the in-memory path now wins because (1) populates it.
4. `fidelity-source-diff.resolveFieldDiffTemplate` likewise picks up the in-memory contract.

**Files**:
- NEW: `engine/stages/fidelity-contract-synthesize.cjs` (~200 LOC; AST parse of source.html with `acorn` or regex extraction; emits canonical fidelity contract shape per `engine/fidelity-contract.cjs::validateFidelityContract`)
- `engine/pipeline.cjs` (insert stage into ordered list)
- Tests: `test/fidelity-contract-synthesize.test.cjs`

**Estimated effort**: 1–2 days (1 day implementation + 0.5 day tests + 0.5 day pipeline wiring + smoke verification).

**Verification gain**: Field-diff `expected` side becomes per-project. Two-way mismatch (source vs target only). Pixel gate threshold becomes realistic — e.g. 30–60% representing cross-engine spread, not 99% representing fixture mismatch.

### Option C — Long-term: source-faithful Luna build (≈1–2 weeks)

**Touch**: Major. Goal = render Luna output that matches the three.js source geometrically and chromatically within 5% pixel diff.

1. Extend `storyboard2html-prompt.cjs` L1–L8.5 contract to require `models[name]` factories to also emit a JSON model spec consumable by Luna (e.g. `meshOps: [{kind:"cone", h:1.2, r:0.6, color:"#ff8833"}, {kind:"cylinder", …}]`).
2. New stage `engine/stages/source-mesh-extract.cjs` — runs source.html in JSDOM/headless Three.js, calls each `models[name]()` factory, serializes the resulting three.js `Object3D` tree to mesh-op JSON.
3. Skeleton generator (`adapters/skeleton-generator.cjs` / `lib/skeleton-generator.cjs`) consumes mesh-op JSON to emit C# `GFM_Create.cs` that constructs equivalent PlayCanvas meshes (`pc.Mesh` primitives + custom geometry via `pc.calculateNormals`).
4. `applyStoryboardVisualOverlay` becomes a no-op — meshes are already correct at scene build time.
5. Camera/lighting/fog: `SCENE_CONFIG` propagates into `GFM_CameraController.cs` + ambient/directional/rim light components.

**Files**:
- `engine/storyboard2html-prompt.cjs` (L9 contract addition)
- NEW: `engine/stages/source-mesh-extract.cjs`
- `adapters/skeleton-generator.cjs`, `lib/skeleton-generator.cjs`
- `worker/GFM_Create.cs`, `worker/GFM_CameraController.cs`, `worker/empty-scene-template.unity`
- `worker/linux-bridge-build.js:1010+` (rip out overlay code or reduce to label-only)

**Estimated effort**: 1–2 weeks. Touches cleaner.cjs blast radius (see CLAUDE.md global memo `project_cleaner_blast_radius`). Recommend behind a feature flag and rolled out per project family.

### Recommendation

**Adopt Option B as the immediate next deliverable.** It is the smallest change that converts the gate from "permanently false-positive" to "directionally correct". Option C is the eventual destination but should wait until Option B is in place so the gate gives real signal during the C rollout.

## 5. Verification strategy (after fix)

1. Run `node scripts/storyboard2html-smoke.cjs` on both incident projects.
   - Expected pre-fix baseline: 99%+ pixel diff, 17+ blocking field-diffs.
   - Post-Option-B target: blocking field-diffs → 0 (entity names align). Pixel diff stays high (30–80% — that's geometry mismatch, which Option B does not fix).
   - Post-Option-C target: pixel diff < 5% per phase, all gates green.
2. Add per-project assertion to `test/fidelity-contract-produce.test.cjs`:
   ```js
   // After Option B: synthesize-then-produce should land projectName-derived entities
   expect(ctx.blueprint.fidelityContract.entities.map(e=>e.name))
     .toEqual(expect.arrayContaining(['Player','SpaceBase','IcePile']));
   expect(ctx.blueprint.fidelityContract.phases[0].guideText)
     .toBe('拖拽摇杆移动角色，走向太空基地');  // NOT the space-ranger default
   ```
3. Re-run pipeline for `proj_1780204936627_xaqj54`; confirm `pipeline-end: success=true` AND that `fidelity-source-diff/report.json` shows the project's OWN entity names on the `expected` side of every fieldDiff (not OxygenShop/SellCounter/ShipUnlock from the reference fixture).
4. Convergence target after full Option B + C: `summary.pixelGate.failurePhases.length === 0` and `summary.blocking === 0`.

## 6. Out-of-scope notes

- **Do NOT change `DEFAULT_FIDELITY_CONTRACT_PATH_FOR_BUILD`** as a quick fix. It exists as a backstop for legacy tasks that lack the L1–L8.5 source HTML contract; removing it without Option B in place would harden the gate against tasks that currently pass.
- **Do NOT lower `DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT` below 5** as a quick fix. It would only mask the symptom; the underlying contract mismatch surfaces equally as field-diffs.
- The `fidelity-source-diff` stage itself is correctly implemented — its inputs are bad.
