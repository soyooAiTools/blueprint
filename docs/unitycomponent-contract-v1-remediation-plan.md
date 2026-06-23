# UnityComponent Contract v1 Remediation Plan

Date: 2026-06-23

Scope: Unity programmer delivery / Unity export only.

This plan does not change storyboard2html prompts, source HTML contracts, SourceIR/GameSchema/PlayableSceneIR schemas, WebGL/Luna runtime, parity hashes, or verification hooks. UnityComponent v1 is a downstream Unity delivery profile that consumes accepted source artifacts and projects them into a Unity handoff.

## Decision

- Freeze the current GMP/GFM programmer delivery path as `gmp-v14` legacy.
- Add a clean `unitycomponent-v1` profile instead of continuing to patch the large legacy cleaner into a half-GMP, half-UnityComponent shape.
- Implement Blueprint-owned projector, emitter, and gates behind an explicit profile flag first.
- N=10 synthetic export corpus is unit/file-level coverage only; it is not cutover evidence. Default programmer-delivery export still remains `gmp-v14` until a separate explicit cutover decision, accepted artifact corpus proof, Unity import/compile smoke, and Editor hydration certification path are complete.

## Non-Negotiable Boundary

Correct downstream chain:

```text
storyboard2html source HTML
  -> SourceIR / GameSchema / PlayableSceneIR / AssetManifest / UnityAssetPlan
  -> UnityDeliverySpec
  -> unitycomponent-v1 Unity export
```

Rules:

- `UnityDeliverySpec` is a downstream projection, not an upstream source of truth.
- Unity runtime must not read `UnityDeliverySpec`; generated Unity data, prefab refs, scene refs, and serialized assets are the runtime inputs.
- The projector may add Unity binding ids, prefab paths, layer classification, component evidence, and diagnostics.
- The projector must not rewrite phase order, guide text, target order, entity semantics, resource semantics, or gate semantics.
- Prompt cutover means programmer-delivery / Unity export prompts only, never storyboard2html prompts.

## SLGFrameWork Contract

After direct inspection of `/nickTemp/UnityComponent(3).rar`, `unitycomponent-v1`
must follow the reference project's `SLGFrameWork` layout, not the earlier
abstract Base/Data/Tool/Game layout:

```text
Assets/SLGFrameWork/Scripts/Base       # BaseComponent / Entity / GameEntry
Assets/SLGFrameWork/Scripts/Component  # [Serializable] BaseComponent capabilities
Assets/SLGFrameWork/Scripts/Entity     # Entity subclasses and project composition
Assets/SLGFrameWork/Scripts/Manager    # EntityManager / EventManager / BlueprintDelivery runtime
Assets/SLGFrameWork/Scripts/Prefab     # GameEntry.prefab composition root
```

SLG physical layout is not a replacement for the logical contract. The logical
Base/Data/Tool/Game boundaries still apply inside the SLG layout:

- Base: `Entity`, `BaseComponent`, `GameEntry`, lifecycle substrate.
- Data: baked spec-derived records and generated data only.
- Tool: reusable managers, services, and generic capability components.
- Game: concrete project entities, phase composition, guide copy, and project
  semantics.

### Base

Base defines the UnityComponent(3) substrate:

- `Entity`
- `BaseComponent`
- `GameEntry`
- native entity/component lifecycle bridge

`EntityManager` lives under `Manager/` in the reference package. Framework core
files are template-owned and must not be rewritten by the AI generator.

### Component

Component contains pure capability classes:

- `[Serializable] public class XxxComponent : BaseComponent`
- `MoveComponent`, `PickUpComponent`, `StackComponent`, `ObjectPoolComponent`,
  `HpComponent`, and feature-evidence-selected generated components

Capability components do not inherit `MonoBehaviour`. They own state/tuning plus
a semantic API or lifecycle work; empty shells are hardgate failures.

### Entity

Entity contains project-specific scene objects and composition:

- generated `UnityClass : Entity`
- public component fields
- `public override void OnAwake()` with explicit `AddEcsComponent(...)`

### Manager

Manager contains global services and the Blueprint delivery bridge:

- `EntityManager`
- `EventManager`
- `BlueprintPlayableManager`
- baked `GeneratedDeliveryData`
- simple manager stubs or real project managers when hydrated in Editor

Generated runtime code must use baked data and serialized/prefab refs, not read
`UnityDeliverySpec.json` at runtime.

`Manager/BlueprintDelivery/GeneratedDeliveryData.cs` is the logical Data layer
even though it physically lives under `Manager/`. It must contain baked records
only: no `Update`, `Awake`, `GameEntry`, `EntityManager`, `GetComponent`,
`GameObject`, or behavior branches. Reusable Manager/Component files must not
hardcode source entity ids, guide copy, resource ids, or phase-specific strings;
those values belong in `GeneratedDeliveryData` or project Entity composition.

### Prefab

`Assets/SLGFrameWork/Scripts/Prefab/GameEntry.prefab` is the composition root.
The v1 emitter must not output the old `Assets/Prefabs/GameEntry.prefab` path.

## Naming And Assembly Contract

`unitycomponent-v1` uses native UnityComponent names, not a GMP wrapper:

- Target framework names: `Entity`, `BaseComponent`, `EntityManager`, `GameEntry`.
- Forbidden in the v1 Unity output: `GMP_`, `GFM_`, `MonoSingleton`, `mSpawnEntities`.
- Internal Blueprint IR may still use neutral names such as `GeneratedEntity`, `GeneratedComponent`, and `PhaseFlow`.

Generated C# follows the reference package and does not use the old
`Blueprint.UnityComponent` namespace. The emitted Unity project must not create
the earlier generated asmdef layer set.

The hardgate scope for forbidden identifiers is the `unitycomponent-v1` output. Legacy fixtures, archived docs, and `gmp-v14` output are not scanned by this v1 gate.

## Lifecycle Contract

UnityComponent(3) uses separate component and entity vocabularies:

Component lifecycle:

```text
OnAwake -> OnEnable -> OnStart -> OnUpdate -> OnDisable -> OnDestroy
```

Entity lifecycle:

```text
OnAwake -> OnOpen -> OnStart -> OnUpdate -> OnClose -> OnDelete
```

Implementation rules:

- `Entity` forwards Unity callbacks into the framework lifecycle.
- `BaseComponent` is `[Serializable]` pure logic and never inherits `MonoBehaviour`.
- `EntityManager` exposes the reference spelling `RegistarEntity` / `UnRegistarEntity` and drives `Entity.OnUpdate()`.
- Pool owns activation, deactivation, reuse, and prefab instantiation.
- Capability components are not decorative shells. A generated `*Component :
  BaseComponent` must own state/tuning and a non-empty semantic API or lifecycle
  method. Empty `Execute*()` style wrappers are hardgate failures.

## GameEntry Contract

`Assets/SLGFrameWork/Scripts/Prefab/GameEntry.prefab` is the only composition
root.

Rules:

- The generator must not create an empty `GameEntry` at runtime and then `AddComponent`.
- `GameEntry.Awake` preserves the reference `static GameEntry Instance` and
  `static EntityManager EntityManager` contract, hydrating managers from the
  prefab hierarchy via `GetComponentInChildren`.
- Missing refs must not fallback to `FindObjectOfType`, `GameObject.Find`, or tag scans.
- The prefab composes `GameEntry`, `EntityManager`, `EventManager`, and
  `BlueprintPlayableManager` at file level; Editor hydration may extend this
  with real project managers/serialized refs.

## UnityDeliverySpec

The projector consumes existing accepted artifacts:

```text
SourceIR + GameSchema + PlayableSceneIR + AssetManifest + UnityAssetPlan
  -> UnityDeliverySpec
```

The internal spec can include source projection, feature evidence, scene/pool classification, component-selection rationale, asset bindings, and diagnostics.

The Unity-visible spec is a minimal audit artifact:

```text
Assets/BlueprintDelivery/UnityDeliverySpec.json
```

It is read-only, not used at runtime, and should contain:

- `entities`: source id -> Unity class / prefab / scene ref / pool archetype
- `components`: selected `BaseComponent` per entity and evidence
- `phases`: phase id, guide text, target sequence, gates, and mapped data ids
- `sceneRefs`: persistent scene objects
- `poolArchetypes`: repeated transient prefab archetypes
- `uiRefs`: guide label, HUD root, CTA/button, dialog anchors
- `assetBindings`: source asset key -> Unity asset/prefab/material/audio/animation path

Runtime bake rule:

- Emitter must project `UnityDeliverySpec` into baked `GeneratedDeliveryData`,
  prefab/scene refs, serialized assets, and `GameEntry.prefab` composition.
- Unity runtime must use the baked Unity assets, not the JSON.
- The v1 hardgate must verify Unity output and baked refs are consistent with `UnityDeliverySpec`.

## Source Parity Invariant

`UnityDeliverySpec.phases`, `guideText`, `targetSequence`, `entities`, `resources`, and `gates` must be semantically 1:1 with SourceIR. Allowed additions are Unity binding ids, class names, prefab paths, pool archetype ids, and diagnostics.

Required test:

```text
delivery-spec-source-parity.test.cjs
```

It must cover accepted SourceIR artifacts and fail on projector-introduced phase, guide, target, entity, resource, or gate drift.

## Component Selection

Components must come from feature evidence:

- movement evidence -> Move component
- attack/damage evidence -> Attack and HP components
- pickup/stack/resource evidence -> `PickUpComponent`, `StackComponent`, or Resource components
- build/upgrade evidence -> Build component
- skill evidence -> Skill component

No source/spec evidence means no generated component. Default Skill, Inventory, Build, or similar optional systems are forbidden.

## SceneRefs / PoolArchetypes / UIRefs

SceneRefs contain persistent key objects:

- player
- camera roots
- UI roots
- spawn roots
- level anchors
- persistent interactable roots

PoolArchetypes contain repeatable transient objects:

- bullet
- drop
- effect
- floating text
- wave minion
- transient projectile / pickup / hit marker

UIRefs contain UI bindings:

- UI root
- guide label
- CTA/button
- HUD root
- dialog/popup anchors

Game code must not use runtime scene scans or object creation for main gameplay. Pool-internal prefab instantiation is whitelisted; business code must request objects through Pool and manifests.

## Hardgate

`unitycomponent-v1` requires a profile-specific hardgate. It must not replace `gmp-v14` gates.

Positive checks:

- `Assets/SLGFrameWork/Scripts/{Base,Component,Entity,Manager,Prefab}` exist.
- The old `Assets/Scripts/Base` layout, old `Assets/Prefabs/GameEntry.prefab`
  path, `Blueprint.UnityComponent` namespace, and old asmdef layer set are absent.
- Framework core files are template-owned and not generated by AI.
- Generated entities live under `Scripts/Entity` and inherit `Entity`.
- Generated components live under `Scripts/Component`, are `[Serializable]`,
  inherit `BaseComponent`, and do not inherit `MonoBehaviour`.
- Generated components are real capabilities with state/tuning plus non-empty
  semantic API or lifecycle work.
- Entities have explicit `AddEcsComponent` registration in `public override void OnAwake()`.
- `Assets/SLGFrameWork/Scripts/Prefab/GameEntry.prefab` exists and composes
  `GameEntry`, `EntityManager`, `EventManager`, and `BlueprintPlayableManager`.
- SceneRefs / PoolArchetypes / UIRefs / AssetBindings match `UnityDeliverySpec`.
- `UnityDeliverySpec` matches SourceIR semantics.
- Runtime uses `Manager/BlueprintDelivery/GeneratedDeliveryData.cs`, not
  `UnityDeliverySpec.json`.

Forbidden checks:

- `GMP_`, `GFM_`, `MonoSingleton`, `mSpawnEntities`.
- Runtime `GameObject.Find`, `FindObjectOfType`, `FindWithTag`.
- Runtime non-whitelisted `AddComponent` or `new GameObject`.
- Default optional components without feature evidence.
- Projector semantic drift.

## Corpus And Cutover

Milestones:

- v0: N=5 accepted artifact exports passed as internal profile only.
- v1: N=10 accepted artifact exports plus Unity import/compile smoke passed before default programmer-delivery prompt cutover.
- v2: N=20 broader accepted artifact corpus for stronger confidence.

Current executable coverage:

- `test/delivery-spec-source-parity.test.cjs` covers SourceIR -> UnityDeliverySpec
  semantic parity.
- `test/unitycomponent-v1-synthetic-export-corpus.test.cjs` covers N=10
  synthetic SourceIR fixtures -> UnityComponent v1 Unity export -> v1 hardgate.
  This is unit coverage, not cutover evidence.
- `test/unitycomponent-v1-accepted-artifact-corpus.test.cjs` discovers accepted
  SourceIR/WebGL artifact directories and runs the same export/hardgate flow
  when repo-owned fixtures or `UNITYCOMPONENT_ACCEPTED_CORPUS_ROOT` are present.
  If no accepted corpus is available locally, it skips explicitly instead of
  claiming cutover evidence.
- `test/unitycomponent-v1-hardgate.test.cjs` now fails on missing
  `source-ir.json`, modified template-owned SLGFrameWork files, missing
  `GameEntry.prefab` manager composition, old namespace/asmdef/layout leakage,
  runtime reads of `UnityDeliverySpec.json`, generated component files without
  feature evidence, and `GeneratedDeliveryData` drift from `UnityDeliverySpec`.
- `test/unitycomponent-v1-emitter.test.cjs` verifies the emitted project includes
  deterministic `.meta` coverage, `FrameworkTemplateManifest.json`,
  `Assets/SLGFrameWork/Scripts/Prefab/GameEntry.prefab`, baked
  `GeneratedDeliveryData` arrays for phases, entities, scene refs, pool
  archetypes, UI refs, and asset bindings, plus the v1 validation report.
- `scripts/export-unity-project.sh <taskId> --profile unitycomponent-v1 --out <tar.gz>`
  is the explicit export entry. It requires an accepted
  `server-data/webgl/<taskId>/source-ir.json`, routes to
  `scripts/export-unitycomponent-v1.cjs`, writes
  `Assets/BlueprintDelivery/UnityDeliverySpec.json`,
  `Assets/BlueprintDelivery/FrameworkTemplateManifest.json`,
  `Assets/SLGFrameWork/Scripts/Prefab/GameEntry.prefab`, and packages
  `UNITYCOMPONENT_V1_VALIDATION.json`.
- `scripts/validation-router.cjs` routes `scripts/export-unity-project.sh`
  changes through both legacy programmer-delivery coverage and the
  unitycomponent-v1 profile/projector/emitter/hardgate/synthetic-corpus plus
  accepted-corpus discovery gates.

Corpus must come from already accepted storyboard2html / IR / WebGL artifacts and cannot be used as a reason to change upstream source contracts.

Cutover rule:

- Default exports remain `gmp-v14` until a separate explicit cutover decision.
- `unitycomponent-v1` output must be behind explicit profile flag or branch.
- File-level v1 output may say it passed the v1 hardgate; final delivery
  certification still requires Unity Editor/AIBridge hydration evidence.

## Implementation DAG

```text
[A] freeze gmp-v14

[B] UnityComponent Contract v1
  -> [D] framework template repair
  -> [E] unitycomponent-v1 emitter
  -> [F] UnityComponent hardgate
  -> [G] programmer-delivery prompt cutover

[B] -> [C] UnityDeliverySpec projector/adapter -> [E]
```

Task C and Task D can run in parallel. Contract -> template -> emitter -> hardgate -> prompt cutover must remain serial.
