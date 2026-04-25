# 2026-04-25 Unity Export And Comment Localization Closeout

## Scope

- Project: `proj_1776912973985_5o2lyu`
- Public preview: `https://playcools.top/webgl/proj_1776912973985_5o2lyu/index.html`
- Follow-up request: provide a complete Unity project export and make generated C# comments Chinese by default.

## Changes

- Added a reusable C# comment localizer:
  - `lib/csharp-comment-localizer.cjs`
  - Preserves machine markers such as `TODO_*`, `[SKELETON]`, `[ASSEMBLY]`, API names, variable names, and signal names.
  - Supports context objects with `csCode` and `extraFiles`, and a CLI `--write <file-or-dir>` mode.
- Wired comment localization into generation/build paths:
  - `engine/stages/codegen-schema.cjs`
  - `engine/stages/compile.cjs`
- Expanded complete Unity export:
  - `scripts/export-unity-project.sh`
  - Copies `Assets/`, `Packages/`, `ProjectSettings/`, `luna.json`, and `tools/` from the base template when present.
  - Copies every `GameFlowManagerMain*.cs` partial into `Assets/Program/Script/Manager/`.
  - Copies other generated C# files into `Assets/Program/Script/Commons/`.
  - Adds `BlueprintArtifacts/` with verified WebGL/spec/project metadata when available.
  - Localizes exported C# comments by default; `--keep-comment-language` opts out.
- Tightened preview UI/API behavior:
  - `api/assets.cjs` no longer appends `autoplay=1` to public WebGL URLs.
  - `frontend/src/App.jsx` filters runtime meta phases (`gameStart`, `gameEnd`, etc.) before matching preview step states.

## Export Artifacts

Generated locally for inspection:

- `server-data/exports/proj_1776912973985_5o2lyu_unity_project/`
- `server-data/exports/proj_1776912973985_5o2lyu_unity_project.tar.gz`
- Older one-shot archive retained locally:
  - `server-data/exports/proj_1776912973985_5o2lyu_unity_complete.tar.gz`

These are runtime/export artifacts and should not be committed unless explicitly requested.

## Verification

- `node test/csharp-comment-localizer.test.cjs`
- `node test/api-webgl-url.test.cjs`
- `node test/preview-phase-states.test.cjs`
- `node test/upload-public-preview.test.cjs`
- `node -c engine/stages/upload.cjs`
- `node -c engine/stages/codegen-schema.cjs`
- `node -c engine/stages/compile.cjs`
- `node -c scripts/export-unity-project.sh` is not applicable because it is a shell script; use `bash -n scripts/export-unity-project.sh`.

## Skill Sync

Both local Blueprint monitor skill copies must mention:

- Complete Unity export means a real Unity project, not only generated `.cs` files.
- Use `scripts/export-unity-project.sh <taskId> --out <tar.gz>`.
- C# comments are localized through `lib/csharp-comment-localizer.cjs`.
- Do not commit `server-data/exports/**` by default.

## Follow-up: Systemic Skeleton Comment Cleanup

Timestamp: `2026-04-25 18:18 CST`

Follow-up request:

- Remove repetitive or low-value generated comments from the `blueprint` skill workflow and from the exported Unity project.
- Specifically eliminate per-line state/flag/object comments such as `0=waiting`, `Set to true on player interaction`, and generic `说明：...` prefixes.
- Keep machine-readable markers intact.

Source changes:

- `adapters/skeleton-generator.cjs`
  - Moved state/flag/GameObject/Spawn explanations from repeated trailing comments into section-level Chinese comments.
  - Localized generated skeleton headers, AutoPlay guidance, Flow/Input/Resource/UI/Scene partial headers, and runtime evidence helper comments.
  - Preserved `TODO_*`, `[SKELETON]`, `[ASSEMBLY SLOT]`, phase ids, signal keys, API names, and code identifiers.
- `lib/csharp-comment-localizer.cjs`
  - Stopped using `说明：...` and `数据: ...` as a blind fallback for unknown comments.
  - Prevented `[SKELETON]` style contract comments from being converted into `数据: [SKELETON] ...`.
- `engine/static-check.cjs`
  - Allowed grouped skeleton documentation for generated fields so static-check no longer forces noisy per-line field comments.
  - Kept `Camera.main` blocking, while accepting the canonical one-time `mainCam = Camera.main; // 正常` cache assignment.

Export cleanup:

- Cleaned the local exported project:
  - `server-data/exports/proj_1776912973985_5o2lyu_unity_project_full_20260425_173243`
- Created a local archive for handoff:
  - `server-data/exports/proj_1776912973985_5o2lyu_unity_project_full_20260425_173243_comment_localized_20260425_1825.tar.gz`
  - SHA-256: `620a2aa0a21e0e8cb678e44f6aa9275c1b806127ae2ef1202dcb3c97fcfec76b`
- The export directory and archive remain runtime/export artifacts and are not part of the git commit.

Second-pass export artifact cleanup:

- Timestamp: `2026-04-25 18:25 CST`
- Cleaned generated artifact files that mirror the Unity source:
  - `BlueprintArtifacts/webgl-index.html`
  - `BlueprintArtifacts/specs.json`
  - `BlueprintArtifacts/proj_1776912973985_5o2lyu.json`
  - `READABILITY_RESEARCH.md`
- Fixed the mojibake phase title `建造兵营出兵` in the derived JSON/html/research artifacts.
- Removed residual `TODO: AI ...`, `AI 填充...`, and `AI/模板填充...` wording while preserving `TODO_*` machine anchors.

Verification:

- `node --check adapters/skeleton-generator.cjs`
- `node --check lib/csharp-comment-localizer.cjs`
- `node --check engine/static-check.cjs`
- `node --check server-data/exports/proj_1776912973985_5o2lyu_unity_project_full_20260425_173243/tools/stage4-to-html.cjs`
- `node --check /root/.codex/skills/blueprint/scripts/deploy.cjs`
- `node --check /tmp/blueprint-skill-sync.SSvHDx/scripts/deploy.cjs`
- Minimal generated skeleton smoke:
  - Generated a 5-partial skeleton through `generateSkeleton(...)`.
  - Confirmed no `说明：`, `数据: [SKELETON]`, `0=waiting`, `Set to true on player interaction`, `route tap handling`, or `AUTO-GENERATED` residue in generated output.
  - `staticCheckProject(...)` returned `blocking=0` for the smoke scenario.
- Export project audit:
  - No `说明：`, `数据: [SKELETON]`, mojibake replacement characters, repeated state/flag comments, or English template tail comments remained in the export project.
  - No `TODO: AI`, `AI 填充`, or `AI/模板填充` residue remained in the export project.
  - `[ASSEMBLY SLOT]` count remained `106`.
  - No `[装配槽]` or `[装配阶段]` contract mistranslation found.
