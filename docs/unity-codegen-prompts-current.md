# Unity Codegen Prompts Current Contract

Date: 2026-06-24

This document lists the current prompt surfaces that can influence Unity/Luna
code generation. It is a maintenance map, not a new source of truth. The
source of truth remains the prompt files, tests, and the blueprint skill.

## Prompt Surfaces

- `engine/stages/build-schema-prompt-v3.cjs`: HTML -> Luna staging schema prompt. `GFM_*` guidance here is only for WebGL staging translation.
- `worker/prompt-v5-basetemplate.js`: primary V5 Luna/WebGL staging generation prompt.
- `worker/prompt-v4.js`: legacy V4 Luna/WebGL staging prompt.
- `worker/luna-codex-code.md`: Codex code runner guide copied into Luna staging workdirs.
- `worker/worker-coder.js`: legacy worker generation/fix prompts and post-processing.
- `worker/codex-code-coder.js`: Codex runner generation/fix prompts and post-processing.
- `worker/behavior-templates.md`: behavior examples included by staging prompts.

## Boundary

These prompt surfaces generate Luna/WebGL staging code. They must not be used
as programmer Unity delivery contracts.

Programmer Unity delivery is split by explicit profile:

- `gmp-v14`: frozen legacy default, validated by the GMP/Core-Tool-Game path.
- `unitycomponent-v1`: explicit UnityComponent(3) / SLGFrameWork profile using
  `Assets/SLGFrameWork/Scripts/{Base,Component,Entity,Manager,Prefab}`,
  `Entity` / `BaseComponent` / `EntityManager` / `GameEntry`,
  `UnityDeliverySpec`, v1 hardgate, accepted corpus, required Unity batchmode
  smoke, and Editor/AIBridge hydration certification.

Neither profile may modify storyboard2html/source HTML/WebGL parity:
phase, guideText, targetSequence, entity/resource/gate semantics must continue
to flow from accepted source artifacts.

## Current Guards

Prompt changes must run:

```bash
node test/unity-codegen-prompt-contract.test.cjs
```

This test blocks stale prompt patterns that previously caused regressions:

- "every field/method must have detailed comments" style boilerplate.
- direct `Instantiate` as a positive pool overflow strategy.
- `Vector3.Distance(...) < radius` distance gates instead of `sqrMagnitude`.
- rewriting `FindObjectOfType<T>()` into non-generic scene scans.
- warnings that encourage restoring `GFM_Create.Obj()` or direct `GameObject.Find`.

When prompt files change, `scripts/validation-router.cjs` routes them to the
same prompt contract test.

## Evidence Rules

For `unitycomponent-v1` cutover or delivery review, Unity smoke JSON is not
sufficient by itself. The reviewer must open the preserved real Unity log and
confirm batchmode execution for the same project path. `BatchMode: 0`,
`-openfile`, a missing `-batchmode`, or a mismatched `projectPath` invalidates
the evidence even if the JSON says `passed`.
