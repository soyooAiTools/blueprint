# 2026-06-07 Storyboard2HTML Batch Acceptance TODO

## Context

Source PDFs:

- `/nickTemp/分镜目录/*.pdf`

Batch evidence:

- Report: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-015430/ACCEPTANCE_REPORT.md`
- Machine summary: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-015430/acceptance-summary-enriched.json`
- Per-task artifacts: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-015430/<task>/`
- Current-fixes rerun report: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/ACCEPTANCE_REPORT.md`
- Current-fixes machine summary: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/acceptance-summary.json`

Batch result:

- PDF -> blueprint precheck: `8/8`
- storyboard2html HTML generated: `8/8`
- storyboard2html static preflight: `7/8`
- Full production CUA + storyboard/WebGL visual certification: `0/8`

Current-fixes rerun result:

- Scope: reused the 8 generated `storyboard2html.html` artifacts from the original batch; did not reparse PDFs or regenerate HTML.
- Current hardgate preflight: `8/8`
- Production observe phase/signal coverage: `7/7` tasks that reached CUA had `8/8` phase coverage and full signal coverage.
- Final production CUA + storyboard/WebGL visual certification: `2/8`
- Certified: `回收子弹`, `卖水`
- Visual screenshot evidence: `1134` PNGs under the current-fixes batch directory.

Targeted continuation result:

- Scope: still reused existing generated `storyboard2html.html` artifacts; no PDF reparse or storyboard2html regeneration was done.
- `制作子弹` is now certified on targeted combined rerun:
  - Combined report dir: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/制作子弹/rerun-final-cert`
  - Production observe: PASS `8/8`, `60/60`
  - Manual joystick probe: PASS
  - Manual joystick flow: PASS `8/8`
  - Visual diff: PASS `8/8`
  - Latest post-camera-contract phase8 canary: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/制作子弹/rerun-post-camera-contract-phase8-canary/storyboard-webgl-visual-diff/report.json`, PASS, phase8 `over50Pct=5.0691`
- `太空捡垃圾分镜` is green on targeted evidence:
  - Production/manual report dir: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空捡垃圾分镜/rerun-final-cert-after-visual`
  - Production observe: PASS `8/8`, `56/56`
  - Manual joystick probe: PASS
  - Manual joystick flow: PASS `8/8`, `drags=9`
  - Final visual-only report after overlay/diff fixes: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空捡垃圾分镜/rerun-conditional-baseline-full-visual-settle1800/report.json`, PASS `8/8`, phase8 `over50Pct=5.8339`
  - Note: the last single combined production+visual command failed only because it used the old visual settle default before the final `1800ms` stabilization; rerun the combined command if a canonical one-dir certification artifact is required.
- `救人泡澡` is now green on a targeted same-dir production + visual rerun:
  - Combined report dir: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/救人泡澡/rerun-manual-target-state-production-verify`
  - Production observe: PASS `8/8`, `55/55`
  - Manual joystick probe: PASS
  - Manual joystick flow: PASS `8/8`, `drags=11`
  - Visual diff: PASS `8/8`, max `over50Pct=5.6209`, phase8 `over50Pct=5.0633`
- `太空卖氧气` is now green on targeted split evidence:
  - Existing production report: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空卖氧气/source-ir-full/blueprint-smoke/unity-verify-summary.json`, PASS `8/8`, `57/57`
  - Final visual report: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空卖氧气/rerun-final-camera-contract-full-visual/storyboard-webgl-visual-diff/report.json`, PASS `8/8`, max `over50Pct=1.6815`, phase8 `over50Pct=1.6686`
  - Fix source: camera follow contract now preserves `null` Y fallback to source camera height, applies dynamic lookAt from `lookAtFactor`, and meter-pills HUD now creates the external source tip.
- `守护家园` is green on targeted split evidence:
  - Existing production report: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/守护家园/source-ir-full/blueprint-smoke/unity-verify-summary.json`, PASS `8/8`, `70/70`
  - Final visual report: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/守护家园/rerun-upgrade-panel-full-visual/storyboard-webgl-visual-diff/report.json`, PASS `8/8`, phase8 `over50Pct=4.7323`
- `PA-守护家园-分镜_3` is green on targeted split evidence:
  - Existing production report: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/PA-守护家园-分镜_3/source-ir-full/blueprint-smoke/unity-verify-summary.json`, PASS `8/8`, `76/76`
  - Final visual report: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/PA-守护家园-分镜_3/rerun-shared-contract-full-visual/storyboard-webgl-visual-diff/report.json`, PASS `8/8`, max `over50Pct=5.4342`, phase8 `over50Pct=5.0639`
- Passing canaries remain visually green after overlay/runtime changes:
  - `回收子弹`: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/回收子弹/rerun-post-camera-contract-phase8-canary/storyboard-webgl-visual-diff/report.json`, PASS, phase8 `over50Pct=3.3553`
  - `卖水`: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/卖水/rerun-post-camera-contract-phase8-canary/storyboard-webgl-visual-diff/report.json`, PASS, phase8 `over50Pct=4.4298`
  - `制作子弹`: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/制作子弹/rerun-post-camera-contract-phase8-canary/storyboard-webgl-visual-diff/report.json`, PASS, phase8 `over50Pct=5.0691`
- Added a phase-selectable storyboard/WebGL visual diff fast path:
  - Direct script accepts `--phases phase8`, `--phases 6-8`, or `--phases phase6,phase8`.
  - `source-ir` accepts `--visual-phases` / `--visual-diff-phases` and forwards it to the diff script.
  - Backward compatibility is preserved: `--phases 8` still means run phases `1`-`8`.
  - Invalid selectors fail immediately instead of falling back to a slow full-phase run.
  - CSS animations/transitions are frozen during visual diff, and the default settle is now `1800ms` for stable screenshots.
  - Verified on `太空捡垃圾分镜` phase8 only in about 12 seconds using an existing `blueprint-smoke` build: `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空捡垃圾分镜/phase8-conditional-settle1800/report.json`, selected `phase8`, PASS (`over50Pct=5.7726`).
- Batch-level `acceptance-summary.json` still says final certification `2/8`; run a full current-fixes batch rerun before updating batch totals.

## Acceptance Standard

A task is not certified until all of these pass:

- `storyboard2html-preflight.json.passed === true`
- production CUA summary `runner === "production"` and `passed === true`
- `storyboard-webgl-visual-diff/report.json.passed === true`
- phase count and phase copy match source storyboard2html
- per-phase source/webgl/diff screenshots exist

Do not accept CUA alone as visual certification.

## Original Main Blockers

1. **Phase timing / batch completion**
   - Several builds advance multiple phases inside one CUA poll.
   - Symptoms: `screenshot-timing`, `batch-completion`, screenshot sharing.
   - Affected: `回收子弹`, `救人泡澡`, `守护家园`, `太空捡垃圾分镜`, `太空卖氧气`, `PA-守护家园-分镜_3`.

2. **Storyboard/WebGL visual drift**
   - `storyboard-webgl-visual-diff` failed for every full-run task.
   - `卖水` and `回收子弹` are closest: `7/8` phases passed, only phase8 failed.
   - Other tasks have broad drift across most phases.

3. **Missing projectile evidence**
   - Missing signals:
     - `回收子弹`: `phase3:projectile_visible`, `phase8:projectile_visible`
     - `卖水`: `phase2:projectile_visible`
     - `太空捡垃圾分镜`: `phase4:projectile_visible`
     - `PA-守护家园-分镜_3`: `phase5:projectile_visible`, `phase6:projectile_visible`

4. **CTA arrival gate regression**
   - `制作子弹` failed static preflight.
   - Error: `CtaButton click handlers must be arrival-gated`.

## Current Closure Gaps After Targeted Fixes

1. **Canonical batch summary is stale**
   - `/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/acceptance-summary.json` still reports final certification `2/8`.
   - Targeted evidence is now green for all eight tasks, but several are split across production and visual artifact dirs.
   - Do not update batch totals or report final closure until a canonical combined rerun or report merge is completed.

2. **Combined artifact coverage is uneven**
   - Same-dir production + visual green evidence exists for `回收子弹`, `卖水`, `制作子弹`, and `救人泡澡`.
   - `太空捡垃圾分镜`, `太空卖氧气`, `守护家园`, and `PA-守护家园-分镜_3` are green on split targeted evidence and should be rerun or merged into canonical task dirs.

3. **Full expensive verification remains intentionally deferred**
   - No full PDF reparse/regenerate was run after these fixes.
   - No full repository test suite was run.
   - The focused checks and visual canaries are green; CUA should be reserved for canonical certification boundaries.

4. **Template/module assembly hardening has moved from reactive fixes to contract enforcement**
   - `visual-runtime-contract.json` is emitted per rerun and now carries DOM HUD/CTA, scene/camera, guidance, visibility, entity, phase, target affordance, and evidence expectations.
   - Remaining architectural work is to make this contract the first-class deterministic gate before CUA and to merge cache/incremental evidence into batch reports.

## Recommended Fix Order

1. Rerun canonical combined certification for the split-evidence tasks, or implement a conservative evidence merge into the current-fixes batch report.
   - Start with `太空捡垃圾分镜`, `太空卖氧气`, `守护家园`, and `PA-守护家园-分镜_3`.
   - Keep using generated `storyboard2html.html` artifacts; do not reparse PDFs unless a fix requires regeneration.

2. Regenerate the current-fixes `acceptance-summary.json` and `ACCEPTANCE_REPORT.md`.
   - Only then move batch totals above `2/8`.
   - Verify every certified row has hardgate preflight, production runner, visual diff, phase/copy consistency, and source/webgl/diff screenshots.

3. Preserve phase8 canaries after any further overlay/runtime/manual-flow change.
   - Current post-camera-contract canaries: `回收子弹`, `卖水`, and `制作子弹`.
   - Add `太空卖氧气` as a camera contract canary because it covers high-gain non-absolute follow plus dynamic lookAt.

4. Convert the template/module assembly shortboards into gates.
   - Front-load `visual-runtime-contract` validation before WebGL generation and CUA.
   - Make deterministic probes and phase-only visual diff the default iteration path.
   - Keep CUA for final certification and cases the deterministic contract cannot prove.

## Useful Commands

Summarize the existing batch:

```bash
cd /opt/blueprint-editor
node -e "const s=require('/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-015430/acceptance-summary-enriched.json'); console.log(JSON.stringify(s.totals,null,2));"
```

Summarize the current-fixes rerun:

```bash
cd /opt/blueprint-editor
node -e "const s=require('/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/acceptance-summary.json'); console.log(JSON.stringify(s.totals,null,2));"
```

Inspect the report:

```bash
sed -n '1,220p' '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-015430/ACCEPTANCE_REPORT.md'
sed -n '1,220p' '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/ACCEPTANCE_REPORT.md'
```

Re-run one generated HTML through production + visual diff:

```bash
cd /opt/blueprint-editor
node adapters/source-ir/index.js \
  '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-015430/卖水/storyboard2html.html' \
  '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-015430/卖水/rerun-after-fix' \
  --blueprint-smoke --visual-diff --verify --verify-runner production --steps 40
```

Run visual diff for only one or a few phases against an existing WebGL smoke build:

```bash
cd /opt/blueprint-editor
node scripts/storyboard-webgl-visual-diff.cjs \
  --source '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空捡垃圾分镜/storyboard2html.html' \
  --webgl '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空捡垃圾分镜/rerun-after-cta-subtitle-visual/blueprint-smoke' \
  --out '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空捡垃圾分镜/phase8-only-fast-visual' \
  --phases phase8 \
  --no-fail
```

Run `source-ir` with visual diff restricted to selected phases:

```bash
cd /opt/blueprint-editor
node adapters/source-ir/index.js \
  '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-015430/太空捡垃圾分镜/storyboard2html.html' \
  '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-current-fixes/太空捡垃圾分镜/rerun-phase8-visual' \
  --blueprint-smoke --visual-diff --visual-phases phase8
```

Use `phase8` for one phase. `--phases 8` still runs phases `1`-`8`.

Full batch helper used in the original run:

```bash
node /tmp/blueprint-batch-tools/blueprint-batch-acceptance.cjs \
  --root '/nickTemp/分镜目录' \
  --out '/nickTemp/分镜目录/_blueprint_outputs/batch-acceptance-20260607-015430' \
  --mode summary
```

If `/tmp/blueprint-batch-tools/blueprint-batch-acceptance.cjs` is gone, use the per-task commands above or reconstruct from the batch artifacts.

## Task Status

| Task | Current status | Next action |
|---|---|---|
| `回收子弹` | Canonical current-fixes certified; post-camera-contract phase8 canary PASS `over50Pct=3.3553` | Preserve as regression canary |
| `卖水` | Canonical current-fixes certified; post-camera-contract phase8 canary PASS `over50Pct=4.4298` | Preserve as low-gain camera canary |
| `救人泡澡` | Targeted same-dir green: production PASS `8/8`, `55/55`; manual flow PASS `8/8`; visual diff PASS `8/8`, phase8 `over50Pct=5.0633` | Merge/rerun canonical batch report |
| `守护家园` | Targeted split green: production PASS `8/8`, `70/70`; visual diff PASS `8/8`, phase8 `over50Pct=4.7323` | Rerun combined or merge evidence into canonical report |
| `太空捡垃圾分镜` | Targeted split green: production PASS `8/8`, `56/56`; manual flow PASS `8/8`; visual diff PASS `8/8`, phase8 `over50Pct=5.8339` | Rerun combined or merge evidence into canonical report |
| `太空卖氧气` | Targeted split green: production PASS `8/8`, `57/57`; visual diff PASS `8/8`, phase8 `over50Pct=1.6686` | Rerun combined or merge evidence into canonical report; keep as camera contract canary |
| `制作子弹` | Targeted combined certified; production PASS `8/8`, `60/60`; manual flow PASS `8/8`; visual diff PASS `8/8`; post-camera-contract phase8 canary PASS `over50Pct=5.0691` | Preserve as regression canary until canonical batch totals update |
| `PA-守护家园-分镜_3` | Targeted split green: production PASS `8/8`, `76/76`; visual diff PASS `8/8`, phase8 `over50Pct=5.0639` | Rerun combined or merge evidence into canonical report |
