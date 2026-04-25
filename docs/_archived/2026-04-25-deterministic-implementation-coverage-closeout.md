# 2026-04-25 Deterministic Implementation Coverage Closeout

## Context

`feedback1.docx` required stricter generated-code structure: detailed comments, 1920x1080 UI defaults, five-partial `GameFlowManagerMain` splitting, small responsibility-specific methods, no large interaction switch bodies, and direct method calls instead of event-system indirection.

The same live task, `proj_1776912973985_5o2lyu`, also exposed a deeper moduleization gap:

- `assemblyCoverage=1` meant the plan could map atoms to modules, but not that every planned module had a deterministic implementation.
- The task still produced `customLogic` and entered `codegen-custom`; one run hit the 300s custom runner timeout and fallback model access issues.
- Review still invoked Codex for deterministic scaffold/static-rule noise after method-check and static-check had enough information to decide locally.

## Changes

- Made comment, branch-comment, switch/case-comment, and partial-project static checks blocking for generated `GameFlowManagerMain*` code.
- Extended project static checking across `GameFlowManagerMain.cs` plus all companion partials.
- Updated skeleton and interaction/NPC templates so generated fields, methods, conditions, and cases satisfy the stricter feedback rules by default.
- Added deterministic implementation coverage for assembly modules. Full moduleization now requires implementation coverage, not only plan coverage.
- Added deterministic emitter/fallback coverage for modules and system slots used by the live task, including cooldown/spawn/joystick/wallet/drop/CTA/world-label/floating-feedback style slots.
- Suppressed schema `customLogic` only when assembly is ready, unresolved modules are zero, owner files are complete, and implementation coverage is 100%.
- Added a deterministic review gate: assembly-ready projects with full implementation coverage and clean method/static/spec checks can skip adversarial Codex review.
- Preserved machine-readable assembly comments during C# comment localization, especially `[ASSEMBLY SLOT]`, `[ASSEMBLY PHASE]`, and owner manifest markers.
- Made assembly contract parsing backward-compatible with already-localized `装配槽` slot comments.
- Fixed generated runtime helpers/static rules so deterministic scaffolds no longer get routed to review-fix for style-only issues.

## Live Verification

Task:
- `proj_1776912973985_5o2lyu`
- Preview: `https://playcools.top/webgl/proj_1776912973985_5o2lyu/index.html`

Observed live result after worker restart and rerun:

- Pipeline ended with `success=true`.
- Assembly gate: `assembly_ready`.
- Deterministic implementation coverage: `106/106 = 1.000`.
- Missing implementation count: `0`.
- Codegen log confirmed `Suppressed customLogic`.
- Codegen log confirmed `No custom logic — skipping text runner entirely`.
- Review log confirmed deterministic review passed; Codex reviewer did not take over implementation repair.
- Compile: Bridge.NET `Build OK`.
- Visual check: PASS.
- Runtime contract: `Coverage 11/11`, `Signals 109/109`.
- Heavy CUA skipped because runtime contract passed.
- Upload/public preview verification passed with `visualDiff=0.132`.

## Local Verification

- `node test/assembly-emitter.test.cjs`
- `node test/codegen-schema-trigger-repair.test.cjs`
- `node test/assembly-contracts-and-cua-bridge.test.cjs`
- `node test/csharp-comment-localizer.test.cjs`
- `node test/assembly-stage-and-prompt.test.cjs`
- `npm test`

## Operational Notes

- `assemblyCoverage=1` must not be treated as enough to bypass custom codegen or reviewer paths.
- The safe bypass condition is `assembly_ready + unresolved=0 + implementation coverage=1 + missing implementation=0 + clean method/static/spec checks`.
- Machine-readable C# comments are part of the assembly contract. Do not localize or rephrase their prefixes.
- If future runs show `assembly-module-owner-mismatch`, first check comment localization and owner-slot parsing before adding another AI repair loop.
