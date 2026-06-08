# SourceIR Legacy Adapter Removal Closeout

Date: 2026-06-08

## Summary

Blueprint Editor active pipeline has been consolidated on `source-ir`. The legacy adapter path was removed from active code, tests, and skill-facing documentation. The SourceIR adapter is now the only HTML/SourceIR to Blueprint smoke entry for this lane.

## Commits

| Repo | Commit | Message |
|---|---|---|
| `soyooAiTools/blueprint` | `4977e83` | `refactor(source-ir): remove legacy adapter path` |
| `soyooAiTools/blueprint-skill` | `fe6c88f` | `docs(skill): align blueprint docs with SourceIR` |

## Main Changes

- Removed the legacy adapter directory from active source.
- Moved reusable contract, proof, visual, smoke, and verify modules under `adapters/source-ir/`.
- Renamed related tests to `source-ir-*`.
- Updated `source-html-bind` hard-mode detection to use `source-ir` / `source-scene-ir` naming.
- Added `docs/blueprint-skill-project-brief-2026-06-08.md` for team discussion.
- Updated Blueprint skill docs and references to SourceIR naming.

## Validation

Keyword checks:

```bash
rg -n "<legacy-adapter-keyword>" \
  adapters engine scripts test worker docs/blueprint-skill-project-brief-2026-06-08.md \
  --glob '!node_modules/**' --glob '!cua-results/**'

rg -n "<legacy-adapter-keyword>" /opt/blueprint-skill --glob '!*.git/**'
```

Both checks returned no active-code / skill hits.

Syntax checks:

```bash
node -c engine/stages/source-html-bind.cjs
node -c scripts/source-ir-build.cjs
node -c adapters/source-ir/index.js
for f in adapters/source-ir/*.js adapters/source-ir/*.cjs; do node -c "$f"; done
node -c worker/codex-code-coder.js
node -c worker/worker-playableagent.js
node -c engine/stages/codegen-schema.cjs
node -c engine/stages/runtime-contract.cjs
```

Focused tests:

```bash
node test/source-html-bind-hardgate.test.cjs
node test/source-ir-bridge.test.cjs
node test/source-ir-verify-facade.test.cjs
node test/source-ir-compiler.test.cjs
node test/source-scene-ir.test.cjs
node test/source-ir-playable-scene-ir-contract.test.cjs
node test/source-ir-source-contract-mapping.test.cjs
node test/source-ir-proof-bundle.test.cjs
node test/source-ir-visual-overlay.test.cjs
node test/source-ir-snapshot-schema-phase-steps.test.cjs
node test/source-ir-buildentity-gadd.test.cjs
node test/source-ir-fidelity-hud-per-phase.test.cjs
node test/storyboard2html-contract.test.cjs
node test/storyboard2html-prompt.test.cjs
node test/validation-router.test.cjs
node test/playable-flow-manifest.test.cjs
node test/runtime-contract-module-gate.test.cjs
node test/storyboard-webgl-visual-diff-script.test.cjs
node test/codegen-schema-trigger-repair.test.cjs
node test/codegen-schema-prebuilt-gameschema.test.cjs
node test/codegen-schema-prompt-v3.test.cjs
node test/codegen-schema-skeleton-spec-expansion.test.cjs
node test/fidelity-contract.test.cjs
node test/fidelity-report.test.cjs
node test/fidelity-unity-writer.test.cjs
node test/playable-scene-ir.test.cjs
node test/visual-assets-build-gate.test.cjs
node test/schema-validate-final-cta.test.cjs
node test/worker-playableagent-patch.test.cjs
node test/playableagent-manual-joystick-probe.test.cjs
node test/playableagent-report-normalization.test.cjs
```

All listed checks passed.

## Deployment

Commands run:

```bash
bash scripts/deploy-ecs.sh
pm2 restart blueprint-editor blueprint-api \
  linux-worker-1 linux-worker-2 linux-worker-3 \
  linux-worker-4 linux-worker-5 linux-worker-6 \
  luna-build-api --update-env
```

Deployment result:

- Frontend build completed successfully with Vite.
- `blueprint-editor`, `blueprint-api`, `linux-worker-1..6`, and `luna-build-api` restarted and online.
- `https://playcools.top/blueprint/` returned `200`.
- `https://playcools.top/api/projects` returned `200`.
- `https://playcools.top/webgl/proj_1780206159599_6uzhan/index.html` returned `200`.

## Notes

Historical generated artifacts and telemetry outside git may still contain old adapter labels. They are not active runtime code. If the team wants literal cleanup of local artifacts and telemetry names, handle that as a separate data/archive migration.

