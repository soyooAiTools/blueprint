#!/bin/bash
# export-unity-project.sh — Overlay a blueprint-editor project's C# sources onto
# the Luna base template and produce a self-contained Unity project archive.
#
# Why this exists:
#   1. `cp` is often aliased to `cp -i` in interactive shells, which silently
#      aborts when stdin is not a TTY — leading to stub files left behind and
#      CS0260 partial class mismatches (2026-04-19 incident).
#   2. Need a reproducible one-shot export: overlay + Luna-strip + meta-gen + tar.
#
# Usage:
#   ./scripts/export-unity-project.sh <taskId> [--strip-luna] [--out /path/to.tar.gz]
#
# Example:
#   ./scripts/export-unity-project.sh proj_1776391516726_urbib0 --strip-luna

set -euo pipefail

# ── Parse args ──────────────────────────────────────────────────────────
TASK_ID="${1:-}"
STRIP_LUNA=0
OUT=""
shift || true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --strip-luna) STRIP_LUNA=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TASK_ID" ]; then
  echo "Usage: $0 <taskId> [--strip-luna] [--out /path/to.tar.gz]" >&2
  exit 2
fi

BP_ROOT="/opt/blueprint-editor"
BASE="/opt/luna-base-template"
SRC="$BP_ROOT/server-data/project-sources/$TASK_ID"
WORK="/tmp/export-unity-$TASK_ID-$$"
OUT="${OUT:-/root/$TASK_ID-unity-project.tar.gz}"

# ── Preflight ───────────────────────────────────────────────────────────
[ -d "$SRC" ] || { echo "FAIL: project sources missing: $SRC" >&2; exit 1; }
[ -d "$BASE" ] || { echo "FAIL: luna base template missing: $BASE" >&2; exit 1; }

echo "[export] task=$TASK_ID strip-luna=$STRIP_LUNA out=$OUT"

# ── Step 1: Seed with base template (rsync bypasses cp alias) ──────────
mkdir -p "$WORK"
command cp -rf "$BASE/Assets" "$BASE/Packages" "$BASE/ProjectSettings" "$WORK/"
# Clean Luna build artifacts that may have snuck in (stage4-engine is a sibling of Assets, not under it)
rm -rf "$WORK/Assets/.git" 2>/dev/null || true

# ── Step 2: Overlay project's C# sources (force-overwrite) ─────────────
SCRIPT_DIR="$WORK/Assets/Program/Script"
mkdir -p "$SCRIPT_DIR/Manager" "$SCRIPT_DIR/Commons"

# Main partial files → Manager/
for f in GameFlowManagerMain.cs GameFlowManagerMain.Systems.cs; do
  if [ -f "$SRC/$f" ]; then
    command cp -rf "$SRC/$f" "$SCRIPT_DIR/Manager/$f"
  fi
done

# Every other .cs → Commons/ (GFM_*/ScriptActivator/GameSceneCtrl etc.)
for f in "$SRC"/*.cs; do
  name=$(basename "$f")
  case "$name" in
    GameFlowManagerMain.cs|GameFlowManagerMain.Systems.cs) continue ;;
  esac
  command cp -rf "$f" "$SCRIPT_DIR/Commons/$name"
done

# ── Step 3: Generate .meta for newly-added files ───────────────────────
gen_meta() {
  local cs_file="$1"
  local meta="${cs_file}.meta"
  if [ -f "$meta" ]; then return 0; fi
  local guid
  guid=$(python3 -c "import uuid; print(uuid.uuid4().hex)")
  cat > "$meta" <<EOF
fileFormatVersion: 2
guid: ${guid}
MonoImporter:
  externalObjects: {}
  serializedVersion: 2
  defaultReferences: []
  executionOrder: 0
  icon: {instanceID: 0}
  userData:
  assetBundleName:
  assetBundleVariant:
EOF
}

find "$SCRIPT_DIR" -name '*.cs' | while read -r cs; do gen_meta "$cs"; done

# ── Step 4: Partial-class consistency check (CS0260 guard) ─────────────
main_cs="$SCRIPT_DIR/Manager/GameFlowManagerMain.cs"
sys_cs="$SCRIPT_DIR/Manager/GameFlowManagerMain.Systems.cs"
if [ -f "$sys_cs" ] && grep -q 'partial class GameFlowManagerMain' "$sys_cs"; then
  if ! grep -q 'partial class GameFlowManagerMain' "$main_cs"; then
    echo "[export] FAIL: $sys_cs declares partial but $main_cs does not — CS0260 guaranteed." >&2
    echo "[export] This usually means rsync didn't copy the real main file. Aborting." >&2
    exit 3
  fi
  echo "[export] partial class consistency OK"
fi

# ── Step 5: Strip Luna plugin (optional) ───────────────────────────────
if [ "$STRIP_LUNA" -eq 1 ]; then
  # 5a) remove playworks package from manifest
  python3 - <<PY
import json, pathlib
mf = pathlib.Path("$WORK/Packages/manifest.json")
d = json.loads(mf.read_text())
d.get("dependencies", {}).pop("com.unity.playworks.upp", None)
mf.write_text(json.dumps(d, indent=2))
PY

  # 5b) comment Luna.Unity.* calls — python to avoid sed/grep regex escaping hell
  python3 - <<PY
import pathlib, re
root = pathlib.Path("$SCRIPT_DIR")
pat = re.compile(r'^([ \t]*)(Luna\.Unity\.(?:LifeCycle\.GameEnded|Playable\.InstallFullGame)\([^)]*\);)', re.MULTILINE)
for p in root.rglob("*.cs"):
    t = p.read_text()
    t2 = pat.sub(r'\1// \2  // Luna plugin stripped', t)
    if t2 != t:
        p.write_text(t2)
        print(f"  stripped: {p.relative_to(root)}")
PY

  echo "[export] Luna plugin stripped (manifest + Luna.Unity.* calls)"
fi

# ── Step 6: Write README ───────────────────────────────────────────────
cat > "$WORK/README.md" <<EOF
# Unity Project Export — $TASK_ID

Exported: $(date -Iseconds)
Strip Luna: $([ "$STRIP_LUNA" -eq 1 ] && echo "yes" || echo "no")

## Layout
- Assets/Program/Script/Manager/  — GameFlowManagerMain.cs + partial
- Assets/Program/Script/Commons/  — GFM_*.cs canonical library (incl. 7 Managers)
- Assets/Scenes/templeteScene.unity — pre-baked 160-component pool scene
- Packages/manifest.json — Unity package dependencies
- ProjectSettings/ — Tags/Layers/Input/Graphics etc.

## Open
Unity Hub → Add → select this folder root, open with Unity 2022 LTS.
EOF

# ── Step 7: Archive (rename to friendly folder name) ───────────────────
FRIENDLY="${TASK_ID}-unity-project"
FINAL_DIR="$(dirname "$WORK")/$FRIENDLY"
rm -rf "$FINAL_DIR"
mv "$WORK" "$FINAL_DIR"
tar -C "$(dirname "$FINAL_DIR")" -czf "$OUT" "$FRIENDLY"
du -h "$OUT"
rm -rf "$FINAL_DIR"

echo "[export] done → $OUT"
