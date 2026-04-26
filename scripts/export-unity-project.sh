#!/bin/bash
# export-unity-project.sh — 将 blueprint-editor 项目的 C# 源码覆盖到
# Luna 基础模板上，并产出可独立打开的完整 Unity 工程归档。
#
# 存在原因：
#   1. 交互 shell 里 `cp` 经常被 alias 成 `cp -i`，stdin 不是 TTY 时会静默中断，
#      留下 stub 文件并触发 CS0260 partial class mismatch（2026-04-19 事故）。
#   2. 需要可复现的一次性导出：模板覆盖 + 可选 Luna 剥离 + meta 生成 + tar。
#   3. 导出的 C# 注释统一中文化；机器标记（TODO_* / [SKELETON] / [ASSEMBLY]）
#      保持原样，避免破坏后续自动修复链路。
#
# 用法：
#   ./scripts/export-unity-project.sh <taskId> [--strip-luna] [--programmer-delivery] [--out /path/to.tar.gz]
#
# 示例：
#   ./scripts/export-unity-project.sh proj_1776391516726_urbib0 --strip-luna

set -euo pipefail

# ── 参数解析 ──────────────────────────────────────────────────────────
TASK_ID="${1:-}"
STRIP_LUNA=0
LOCALIZE_COMMENTS=1
PROGRAMMER_DELIVERY=0
OUT=""
shift || true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --strip-luna) STRIP_LUNA=1; shift ;;
    --keep-comment-language) LOCALIZE_COMMENTS=0; shift ;;
    --programmer-delivery) PROGRAMMER_DELIVERY=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TASK_ID" ]; then
  echo "Usage: $0 <taskId> [--strip-luna] [--programmer-delivery] [--keep-comment-language] [--out /path/to.tar.gz]" >&2
  exit 2
fi

BP_ROOT="/opt/blueprint-editor"
BASE="${UNITY_BASE_TEMPLATE:-/opt/luna-base-template}"
if [ ! -d "$BASE" ] && [ -d "/tmp/luna-base-cache" ]; then
  BASE="/tmp/luna-base-cache"
fi
SRC="$BP_ROOT/server-data/project-sources/$TASK_ID"
WORK="/tmp/export-unity-$TASK_ID-$$"
OUT="${OUT:-/root/$TASK_ID-unity-project.tar.gz}"

# ── 预检 ───────────────────────────────────────────────────────────
[ -d "$SRC" ] || { echo "FAIL: project sources missing: $SRC" >&2; exit 1; }
[ -d "$BASE" ] || { echo "FAIL: luna base template missing: $BASE" >&2; exit 1; }

echo "[export] task=$TASK_ID strip-luna=$STRIP_LUNA localize-comments=$LOCALIZE_COMMENTS programmer-delivery=$PROGRAMMER_DELIVERY base=$BASE out=$OUT"

# ── Step 1: 以基础模板铺底（command cp 绕过 cp alias） ──────────
mkdir -p "$WORK"
for entry in Assets Packages ProjectSettings luna.json tools; do
  if [ -e "$BASE/$entry" ]; then
    command cp -rf "$BASE/$entry" "$WORK/"
  fi
done
# 清理可能混入的 Luna 构建产物（stage4-engine 是 Assets 的同级目录，不在 Assets 内）
rm -rf "$WORK/Assets/.git" 2>/dev/null || true

# ── Step 2: 覆盖项目 C# 源码（强制覆盖） ─────────────
SCRIPT_DIR="$WORK/Assets/Program/Script"
mkdir -p "$SCRIPT_DIR/Manager" "$SCRIPT_DIR/Commons"

# GameFlowManagerMain*.cs 源文件 → Manager/
for f in "$SRC"/GameFlowManagerMain*.cs; do
  [ -f "$f" ] || continue
  command cp -rf "$f" "$SCRIPT_DIR/Manager/$(basename "$f")"
done

# 其他 .cs → Commons/（GFM_* / ScriptActivator / GameSceneCtrl 等）
for f in "$SRC"/*.cs; do
  name=$(basename "$f")
  case "$name" in
    GameFlowManagerMain*.cs) continue ;;
  esac
  command cp -rf "$f" "$SCRIPT_DIR/Commons/$name"
done

# ── Step 3: 为新增脚本生成 .meta ───────────────────────
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

# ── Step 4: partial class 一致性检查（CS0260 防线） ─────────────
main_cs="$SCRIPT_DIR/Manager/GameFlowManagerMain.cs"
partial_count=$(find "$SCRIPT_DIR/Manager" -maxdepth 1 -name 'GameFlowManagerMain*.cs' ! -name 'GameFlowManagerMain.cs' | wc -l | tr -d ' ')
if [ "$partial_count" -gt 0 ]; then
  if ! grep -q 'partial class GameFlowManagerMain' "$main_cs"; then
    echo "[export] FAIL: companion files declare partial but $main_cs does not — CS0260 guaranteed." >&2
    echo "[export] This usually means the real main file was not copied. Aborting." >&2
    exit 3
  fi
  echo "[export] partial class consistency OK ($partial_count companion file(s))"
fi

# ── Step 5: 剥离 Luna 插件（可选） ───────────────────────────────
if [ "$STRIP_LUNA" -eq 1 ]; then
  # 5a) 从 manifest 移除 playworks package
  python3 - <<PY
import json, pathlib
mf = pathlib.Path("$WORK/Packages/manifest.json")
d = json.loads(mf.read_text())
d.get("dependencies", {}).pop("com.unity.playworks.upp", None)
mf.write_text(json.dumps(d, indent=2))
PY

  # 5b) 注释 Luna.Unity.* 调用；用 python 避免 sed/grep 正则转义问题
  python3 - <<PY
import pathlib, re
root = pathlib.Path("$SCRIPT_DIR")
pat = re.compile(r'^([ \t]*)(Luna\.Unity\.(?:LifeCycle\.GameEnded|Playable\.InstallFullGame)\([^)]*\);)', re.MULTILINE)
for p in root.rglob("*.cs"):
    t = p.read_text()
    t2 = pat.sub(r'\1// \2  // Luna 插件已剥离', t)
    if t2 != t:
        p.write_text(t2)
        print(f"  stripped: {p.relative_to(root)}")
PY

  echo "[export] Luna plugin stripped (manifest + Luna.Unity.* calls)"
fi

# ── Step 6: C# 注释中文化 ───────────────────────────────────────────────
if [ "$LOCALIZE_COMMENTS" -eq 1 ]; then
  node "$BP_ROOT/lib/csharp-comment-localizer.cjs" --write "$SCRIPT_DIR"
fi

# ── Step 7: 附带 Blueprint 验证产物（可选） ───────────────────────────────
ARTIFACT_DIR="$WORK/BlueprintArtifacts"
if [ "$PROGRAMMER_DELIVERY" -eq 0 ]; then
  mkdir -p "$ARTIFACT_DIR"
  for artifact in \
    "$BP_ROOT/server-data/webgl/$TASK_ID/index.html:webgl-index.html" \
    "$BP_ROOT/server-data/webgl/$TASK_ID/specs.json:specs.json" \
    "$BP_ROOT/server-data/webgl/$TASK_ID/plans.json:plans.json" \
    "$BP_ROOT/server-data/projects/$TASK_ID.json:$TASK_ID.json"; do
    src="${artifact%%:*}"
    dst="${artifact##*:}"
    if [ -f "$src" ]; then
      command cp -rf "$src" "$ARTIFACT_DIR/$dst"
    fi
  done
  if [ -z "$(find "$ARTIFACT_DIR" -type f -print -quit)" ]; then
    rmdir "$ARTIFACT_DIR"
  fi
fi

# ── Step 8: 写入 README ───────────────────────────────────────────────
cat > "$WORK/README.md" <<EOF
# Unity 工程导出 — $TASK_ID

导出时间：$(date -Iseconds)
是否剥离 Luna：$([ "$STRIP_LUNA" -eq 1 ] && echo "是" || echo "否")
是否中文化 C# 注释：$([ "$LOCALIZE_COMMENTS" -eq 1 ] && echo "是" || echo "否")
是否程序员交付版清理：$([ "$PROGRAMMER_DELIVERY" -eq 1 ] && echo "是" || echo "否")

## 目录
- Assets/Program/Script/Manager/  — GameFlowManagerMain*.cs 源文件
- Assets/Program/Script/Commons/  — GFM_*.cs canonical 工具库
- Assets/Scenes/templeteScene.unity — 预烘焙对象池场景
- CODE_RELATION_GRAPH.md — 代码关系图、运行时调用链和维护入口
- CODE_RELATION_GRAPH.html — 可直接用浏览器打开的图表化关系图
- BlueprintArtifacts/ — 已验证 WebGL 与 Blueprint 规格/计划元数据（如果存在）
- Packages/manifest.json — Unity 包依赖
- ProjectSettings/ — Tags/Layers/Input/Graphics 等工程设置

## 打开方式
Unity Hub → Add → 选择此文件夹根目录，使用 Unity 2022 LTS 打开。

## 程序员交付边界
- 程序员交付版会整理为 GameFlowManagerMain.cs 主入口 + GameFlow*Base.cs 普通继承分层，不使用 C# 拆分类组织主流程。
- 每个 GameFlow 脚本目标保持在 1000 行以内；phase、资源、UI、场景和输入逻辑按基类职责维护。
- 实体引用只来自 RegisterEntityBindings()/GameSceneCtrl，不要在 TODO 区直接 GameObject.Find("__Pool_*") 覆盖字段。
- 资源 API 使用 GFM_ResourceIds.Gold / GFM_ResourceIds.Normalize("...")，不要裸写 "gold"/"Gold"。
- 引导文案统一调用 SetGuideText()；guideText.text 只应在这个 helper 内落地。

## 环境注意
- Packages/manifest.json 可能包含 Luna/Playworks 本机 file: 依赖；交接前请把它改成团队机器可访问的安装路径或包源。
EOF

node "$BP_ROOT/lib/code-relation-graph-writer.cjs" "$WORK" "$TASK_ID"

if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
  node "$BP_ROOT/lib/programmer-delivery-cleaner.cjs" "$WORK" "$TASK_ID" "$TASK_ID"
  # programmer-delivery-cleaner may create Entities/*.cs and delete merged
  # GameFlowManagerMain companion files. Refresh .meta coverage after that step.
  find "$SCRIPT_DIR" -name '*.cs' | while read -r cs; do gen_meta "$cs"; done
fi

# ── Step 9: 打包归档（使用友好的文件夹名） ───────────────────
FRIENDLY="${TASK_ID}-unity-project"
FINAL_DIR="$(dirname "$WORK")/$FRIENDLY"
rm -rf "$FINAL_DIR"
mv "$WORK" "$FINAL_DIR"
tar -C "$(dirname "$FINAL_DIR")" -czf "$OUT" "$FRIENDLY"
du -h "$OUT"
rm -rf "$FINAL_DIR"

echo "[export] done → $OUT"
