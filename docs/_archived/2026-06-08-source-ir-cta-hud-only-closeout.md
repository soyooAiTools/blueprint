# SourceIR CTA HUD-only closeout

Date: 2026-06-08

## Scope

This records the SourceSceneIR / SourceVisualIR closeout that fixed the CTA-as-entity regression and verified the `卖水` SourceIR delivery path.

## Decision

- New storyboard2html output is SourceIR-first: `window.__BP_SOURCE_IR__` is required.
- `scripts/source-ir-build.cjs` is the preferred build path for new storyboard2html output.
- `adapters/demo2spec/index.js` is now a SourceIR-only compatibility wrapper. Missing SourceIR writes `semanticSource=source-scene-ir-required` and fails; it does not run legacy JS semantic inference.
- CTA/install/download UI is HUD-only. It must use `ctaId` and `cta_arrival`, not `entity` / `near_entity(CtaButton)` in gameplay data.

## Invariant

`CtaButton` and equivalent install/download controls must not appear in:

- `SourceSceneIR.entities[]`
- `phases[].showEntities`
- `phases[].targetSequence`
- `hudText.targetEntity`
- `uiOverlayContract.entities[]`
- `visual-runtime-contract` world target affordances
- `playable-scene-ir` gameplay entities or targets
- `blueprint.plans` as `move_to:CtaButton`
- generated C# as `GameObject CtaButton` or `CtaButtonState`

Allowed forms:

- `SourceSceneIR.hud.cta.ctaId`
- `SourceVisualIR.visual.cta.ctaId`
- final phase gate `{ kind: "cta_arrival", ctaId: "CtaButton" }`
- GameSchema trigger `{ type: "cta_arrival", ctaId: "CtaButton", range: 2 }`
- final step `{ kind: "cta_finish", ctaId: "CtaButton" }`

## Files Touched

- `engine/source-scene-ir.cjs`
- `engine/source-visual-ir.cjs`
- `engine/source-ir-preview-renderer.cjs`
- `engine/source-ir-phase-liveness.cjs`
- `engine/playable-scene-ir.cjs`
- `engine/stages/codegen-schema.cjs`
- `contracts/source-scene-ir.v1.json`
- `contracts/source-visual-ir.v1.json`
- `adapters/source-ir/*`
- `adapters/demo2spec/{blueprint-project,proof-bundle,snapshot-schema,visual-assets,visual-overlay}.js`
- `adapters/schema/{game-schema.json,validate-schema.cjs}`
- SourceIR / demo2spec / visual overlay tests

## Sell-water Validation

Artifacts:

- Source HTML: `/tmp/卖水-source-ir-preview-cta-ui.html`
- WebGL: `/tmp/卖水-source-ir-build-cta-ui-webgl/blueprint-smoke/index.html`
- HTML phase8 screenshot: `/tmp/卖水-source-ir-preview-cta-ui-phase8.png`
- WebGL phase8 screenshot: `/tmp/卖水-source-ir-webgl-cta-ui-phase8.png`
- HTML liveness report: `/tmp/卖水-source-phase-liveness-cta-ui-report.json`

Commands:

```bash
node scripts/source-ir-preview-html.cjs <卖水-source> /tmp/卖水-source-ir-preview-cta-ui.html
node scripts/source-ir-phase-liveness.cjs /tmp/卖水-source-ir-preview-cta-ui.html /tmp/卖水-source-phase-liveness-cta-ui-report.json
node scripts/source-ir-build.cjs /tmp/卖水-source-ir-build-cta-ui-plans/source-ir.json /tmp/卖水-source-ir-build-cta-ui-webgl --project 卖水-cta-ui --blueprint-smoke
```

Observed:

- Source phase liveness passed.
- SourceIR entities had zero CTA entries.
- `hud.cta.ctaId === "CtaButton"` and no CTA `entity` field remained after normalization.
- final SourceIR gate used `cta_arrival`.
- SourceVisualIR carried `visual.cta.ctaId`, not `visual.cta.entity`.
- `visual-runtime-contract`, `playable-scene-ir`, GameSchema and generated C# had no gameplay `CtaButton` entity/target.
- WebGL phase8 had no visible `目标：CtaButton`, no stale target label, no CTA entity state, and the CTA UI stayed visible.

## Verification

Passed focused checks:

```bash
node -c engine/source-scene-ir.cjs
node -c engine/source-visual-ir.cjs
node -c engine/source-ir-preview-renderer.cjs
node -c engine/source-ir-phase-liveness.cjs
node -c adapters/schema/validate-schema.cjs
node -c adapters/source-ir/compile-to-gameschema.js
node -c engine/stages/codegen-schema.cjs
node -c adapters/demo2spec/visual-assets.js
node -c adapters/demo2spec/blueprint-project.js
node test/source-ir-phase-liveness.test.cjs
node test/source-ir-preview-renderer.test.cjs
node test/source-ir-compiler.test.cjs
node test/source-visual-ir.test.cjs
node test/source-ir-build-cli.test.cjs
node test/demo2spec-source-ir-bridge.test.cjs
node test/demo2spec-playable-scene-ir-contract.test.cjs
node test/demo2spec-visual-overlay.test.cjs
node test/visual-assets-build-gate.test.cjs
node test/storyboard2html-contract.test.cjs
node test/storyboard2html-prompt.test.cjs
git diff --check
```

Full visual diff was not rerun in this closeout; SourceIR structural/browser checks and the `卖水` SourceIR WebGL build were used for this CTA regression.
