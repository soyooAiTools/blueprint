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
