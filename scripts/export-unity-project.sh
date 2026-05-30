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
if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
  STRIP_LUNA=1
fi

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

# Luna 基础模板来自 Windows 机器时，manifest 里可能残留 file:C:/7.1.0/scripts。
# 审核版为了本机验证可把 Playworks 包路径正规化；程序员交付版会在后续
# STRIP_LUNA 中直接删除该依赖，最终包不能含任何本机绝对 package 路径。
if [ -f "$WORK/Packages/manifest.json" ]; then
  python3 - <<PY
import json, os
from pathlib import Path
mf = Path("$WORK/Packages/manifest.json")
data = json.loads(mf.read_text())
deps = data.get("dependencies") or {}
pkg = deps.get("com.unity.playworks.upp")
local_pkg = os.environ.get("PLAYWORKS_PACKAGE_PATH") or "/opt/blueprint-editor/7.1.0/scripts"
if "$PROGRAMMER_DELIVERY" != "1" and pkg == "file:C:/7.1.0/scripts" and Path(local_pkg, "package.json").exists():
    deps["com.unity.playworks.upp"] = "file:" + local_pkg
    mf.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
PY
fi

# ── Step 2: 覆盖项目 C# 源码（强制覆盖） ─────────────
# 程序员交付版采用参考工程口径：业务脚本放在 Assets/Scripts 下，
# Manager / Common / Entities / UI / Player 等目录一眼可扫；非交付版
# 继续保持历史 Assets/Program/Script 路径，避免影响现有流水线。
if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
  SCRIPT_DIR="$WORK/Assets/Scripts"
  MANAGER_DIR="$SCRIPT_DIR"
  COMMON_DIR="$SCRIPT_DIR/Common"
else
  SCRIPT_DIR="$WORK/Assets/Program/Script"
  MANAGER_DIR="$SCRIPT_DIR/Manager"
  COMMON_DIR="$SCRIPT_DIR/Commons"
fi
mkdir -p "$MANAGER_DIR" "$COMMON_DIR"
if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
  rm -rf "$WORK/Assets/Program" "$WORK/Assets/Program.meta"
fi

delivery_script_dir() {
  local name="$1"
  if [ "$PROGRAMMER_DELIVERY" -ne 1 ]; then
    echo "$COMMON_DIR"
    return
  fi
  case "$name" in
    GFM_AutoPlay.cs|GFM_CameraController.cs|GFM_EconomyManager.cs|GFM_ItemManager.cs|GFM_NpcManager.cs|GFM_PhaseTransition.cs|GFM_SingletonBase.cs|GFM_TipsManager.cs|GFM_UIManager.cs)
      echo "$SCRIPT_DIR/Manager"
      ;;
    GFM_Player.cs|GFM_Joystick.cs)
      echo "$SCRIPT_DIR/Player"
      ;;
    GFM_Audio.cs)
      echo "$SCRIPT_DIR/Audio"
      ;;
    GFM_UI.cs|GFM_VisualGuide.cs|GFM_Billboard.cs)
      echo "$SCRIPT_DIR/UI"
      ;;
    *)
      echo "$COMMON_DIR"
      ;;
  esac
}

# GameFlowManagerMain*.cs 源文件 → Manager/
for f in "$SRC"/GameFlowManagerMain*.cs; do
  [ -f "$f" ] || continue
  command cp -rf "$f" "$MANAGER_DIR/$(basename "$f")"
done

# 其他 .cs → Common(s)/（源 worker 仍是 GFM_* / ScriptActivator / GameSceneCtrl 等；
# 程序员交付 cleaner 会统一重命名为 GMP_*）
for f in "$SRC"/*.cs; do
  name=$(basename "$f")
  case "$name" in
    GameFlowManagerMain*.cs) continue ;;
    Demo2SpecVisualAssetBaker.cs)
      if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
        continue
      fi
      ;;
  esac
  dst_dir="$(delivery_script_dir "$name")"
  mkdir -p "$dst_dir"
  command cp -rf "$f" "$dst_dir/$name"
done

# 程序员交付包脱离 Luna 构建链后，project-sources 里通常只包含
# GameFlowManagerMain*.cs。MainManager 仍依赖 worker 中维护的 canonical
# helper；这里复制 split helper 到参考工程式 Common 目录，并剔除
# Luna/Event/monolithic 兼容文件，避免本机 package 依赖和 duplicate class。
if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
  for f in "$BP_ROOT"/worker/*.cs; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    case "$name" in
      GameSceneCtrl.cs|ScriptActivator.cs|GFM_*.cs) ;;
      *) continue ;;
    esac
    case "$name" in
      GFM_Luna.cs|GFM_Event.cs|GFM_Tools.cs) continue ;;
    esac
    dst_dir="$(delivery_script_dir "$name")"
    mkdir -p "$dst_dir"
    command cp -rf "$f" "$dst_dir/$name"
  done
fi

if [ "$PROGRAMMER_DELIVERY" -eq 0 ]; then
cat > "$MANAGER_DIR/GameFlowBootstrap.cs" <<'EOF'
using UnityEngine;

/// <summary>
/// Unity Editor 直接打开工程时自动挂载玩法入口，避免模板场景只有对象池而没有主流程。
/// </summary>
public static class GameFlowBootstrap
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void EnsureGameFlowManager()
    {
        if (Object.FindObjectOfType<GameFlowManagerMain>() != null) return;

        var go = new GameObject("GameFlowManagerMain");
        go.AddComponent<GameFlowManagerMain>();
    }
}
EOF
fi

# ── Step 3: 为新增脚本生成 .meta ───────────────────────
gen_meta() {
  local cs_file="$1"
  local meta="${cs_file}.meta"
  if [ -f "$meta" ]; then return 0; fi
  local guid
  if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
    guid=$(python3 - "$cs_file" "$WORK" <<'PY'
import hashlib, pathlib, sys
path = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(sys.argv[2]).resolve()
try:
    rel = path.relative_to(root).as_posix()
except ValueError:
    rel = path.as_posix()
print(hashlib.sha1(("programmer-delivery-meta:" + rel).encode("utf-8")).hexdigest()[:32])
PY
)
  else
    guid=$(python3 -c "import uuid; print(uuid.uuid4().hex)")
  fi
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
main_cs="$MANAGER_DIR/GameFlowManagerMain.cs"
partial_count=$(find "$MANAGER_DIR" -maxdepth 1 -name 'GameFlowManagerMain*.cs' ! -name 'GameFlowManagerMain.cs' | wc -l | tr -d ' ')
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
roots = [pathlib.Path("$SCRIPT_DIR"), pathlib.Path("$COMMON_DIR")]
pat = re.compile(r'^([ \t]*)(Luna\.Unity\.(?:LifeCycle\.GameEnded|Playable\.InstallFullGame)\([^)]*\);)', re.MULTILINE)
for root in roots:
    if not root.exists():
        continue
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

# 程序员交付版固定提供参考工程式 Game.unity 入口；Luna 模板仍保留原
# templeteScene.unity 作为兼容备份。
if [ "$PROGRAMMER_DELIVERY" -eq 1 ] && [ -f "$WORK/Assets/Scenes/templeteScene.unity" ]; then
  command cp -rf "$WORK/Assets/Scenes/templeteScene.unity" "$WORK/Assets/Scenes/Game.unity"
  if [ -f "$WORK/Assets/Scenes/templeteScene.unity.meta" ]; then
    command cp -rf "$WORK/Assets/Scenes/templeteScene.unity.meta" "$WORK/Assets/Scenes/Game.unity.meta"
  fi
  if [ -f "$WORK/ProjectSettings/EditorBuildSettings.asset" ]; then
    python3 - <<PY
from pathlib import Path
p = Path("$WORK/ProjectSettings/EditorBuildSettings.asset")
t = p.read_text()
p.write_text(t.replace("Assets/Scenes/templeteScene.unity", "Assets/Scenes/Game.unity"))
PY
  fi
fi

if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
  rm -rf \
    "$WORK/Assets/__LunaMaterials" \
    "$WORK/Assets/__LunaMaterials.meta" \
    "$WORK/Assets/Scenes/templeteScene.unity" \
    "$WORK/Assets/Scenes/templeteScene.unity.meta" \
    "$WORK/Assets/Editor.meta" \
    "$WORK/Assets/Editor" \
    "$WORK/Assets/Program" \
    "$WORK/Assets/Program.meta" \
    "$WORK/luna.json"
fi

# ── Step 8: 写入 README ───────────────────────────────────────────────
MANAGER_README_PATH="${MANAGER_DIR#$WORK/}"
COMMON_README_PATH="${COMMON_DIR#$WORK/}"
if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
  ENTITY_README_PATH="Assets/Scripts/Entities"
else
  ENTITY_README_PATH="Assets/Program/Script/Manager/Entities"
fi
if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
  MANAGER_LABEL="MainManager.cs 主流程与 MonoSingleton.cs 单例基类"
else
  MANAGER_LABEL="GameFlowManagerMain*.cs 主流程与 GameFlowBootstrap.cs 入口"
fi
cat > "$WORK/README.md" <<EOF
# Unity 工程导出 — $TASK_ID

导出时间：$(date -Iseconds)
是否剥离 Luna：$([ "$STRIP_LUNA" -eq 1 ] && echo "是" || echo "否")
是否中文化 C# 注释：$([ "$LOCALIZE_COMMENTS" -eq 1 ] && echo "是" || echo "否")
是否程序员交付版清理：$([ "$PROGRAMMER_DELIVERY" -eq 1 ] && echo "是" || echo "否")

## 目录
- $MANAGER_README_PATH/  — $MANAGER_LABEL
- $COMMON_README_PATH/  — GMP_*.cs canonical 工具库
- $ENTITY_README_PATH/ — 领域对象类，承载 Player / NPC / 建筑 / 资源等可维护状态
- Assets/Scenes/Game.unity — 程序员交付入口场景，打开后直接按 Play
- 程序员交付版不保留 Luna 模板备份场景；审核版才会保留 templeteScene.unity
- CODE_RELATION_GRAPH.md — 代码关系图、运行时调用链和维护入口
- CODE_RELATION_GRAPH.html — 可直接用浏览器打开的图表化关系图
- BlueprintArtifacts/ — 已验证 WebGL 与 Blueprint 规格/计划元数据（如果存在）
- Packages/manifest.json — Unity 包依赖
- ProjectSettings/ — Tags/Layers/Input/Graphics 等工程设置

## 打开方式
Unity Hub → Add → 选择此文件夹根目录，使用 Unity 2022 LTS 打开，然后打开 Assets/Scenes/Game.unity 按 Play。

## 程序员交付边界
- 程序员交付版会整理为 MainManager.cs 单入口 + MonoSingleton<T> 单例基类，并在 Entities/ 下保留领域对象类。
- Unity Editor 直接点击 Play 时，MainManager 与关键 GMP 管理器已挂在 Game.unity 场景对象上，不再依赖运行时创建脚本物体。
- 程序员交付版已剥离 Luna 打包流水线依赖和模板备份场景；需要重新接入 Luna 时，从 Blueprint 流水线重新导出审核版。
- 每个脚本目标保持在 1000 行以内；phase、资源、UI、场景和输入逻辑按职责分段维护。
- 业务新增脚本优先放到 Assets/Scripts/Manager、Assets/Scripts/Entities、Assets/Scripts/UI、Assets/Scripts/Player、Assets/Scripts/Audio 这些参考工程式目录，不再放进 Assets/Program/Script。
- 实体引用只来自 RegisterEntityBindings()/GameSceneCtrl，不要在 TODO 区直接 GameObject.Find("__Pool_*") 覆盖字段。
- 资源 API 使用 GMP_ResourceIds.Gold / GMP_ResourceIds.Normalize("...")，不要裸写 "gold"/"Gold"。
- 引导文案统一调用 SetGuideText()；guideText.text 只应在这个 helper 内落地。

## 环境注意
- 程序员交付版不依赖本机绝对路径 package；Packages/manifest.json 可直接随工程打开。
EOF

node "$BP_ROOT/lib/code-relation-graph-writer.cjs" "$WORK" "$TASK_ID"

if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then
  node "$BP_ROOT/lib/programmer-delivery-cleaner.cjs" "$WORK" "$TASK_ID" "$TASK_ID"
  # programmer-delivery-cleaner may create Entities/*.cs, move scripts into
  # category folders, and inject scene-mounted manager objects. Refresh .meta
  # coverage after that step.
  find "$SCRIPT_DIR" -name '*.cs' | while read -r cs; do gen_meta "$cs"; done
  python3 - <<PY
import json, re
from datetime import datetime, timezone
from pathlib import Path
root = Path("$WORK")
manager = next(root.rglob("GMP_EntityBindingManager.cs"), None)
entity_names = []
legacy_pool_hits = []
if manager and manager.exists():
    text = manager.read_text(encoding="utf-8")
    match = re.search(r"mEntityNames\s*=\s*new string\[\]\s*\{(?P<body>.*?)\};", text, re.S)
    if match:
        entity_names = re.findall(r'"([^"]+)"', match.group("body"))
    legacy_pool_hits = re.findall(r"__Pool_[A-Za-z0-9_]+", text)
doc = {
    "schemaVersion": 3,
    "taskId": "$TASK_ID",
    "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(),
    "bridgeWarningPrefix": "[k-audit] GFM legacy pool name normalized to _player",
    "runtimeCounterField": "GameSceneCtrl.LegacyPlayerPoolNormalizeCount",
    "gfmLunaPath": {
        "registerCallsTotal": None,
        "playerBindingLegacyPoolNamesSeen": None,
        "normalizedToPlayerCount": None,
        "structuralZero": False,
        "status": "requires_phase1_bridge_probe"
    },
    "gmpDeliveryPath": {
        "registerCallsTotal": len(entity_names),
        "playerBindingLegacyPoolNamesSeen": 0,
        "legacyPoolNamesSeen": len(set(legacy_pool_hits)),
        "normalizedToPlayerCount": 0,
        "appliesBridge": False,
        "structuralZero": True,
        "status": "static_export_baseline"
    }
}
(root / "audit_k_fallback_count.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
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
