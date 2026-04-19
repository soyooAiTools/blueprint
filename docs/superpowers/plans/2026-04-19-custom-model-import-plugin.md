# Unity 场景物体模型替换插件 - 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Unity 编辑器里打开任意工程 → 扫描当前场景所有含 MeshFilter 的 GameObject → 为每个物体一键导入并替换成用户提供的 3D 模型。

**Architecture:** 纯 Unity Editor 工具（无 Runtime 组件）。核心由 `SceneScanner`（扫描+过滤）、`ModelReplacer`（Mesh/Material 就地替换）、`ModelImportHelpers`（FBX/GLB 导入管线）、`ModelReplacementWindow`（EditorWindow UI）四个模块组成。无撤销/恢复/状态追踪——替换错了再选一次即可，插件保持无状态。

**Tech Stack:**
- Unity 2021.3 LTS（`/opt/luna-base-template` 工程版本）
- UnityEditor + UnityEngine only（零第三方依赖）
- Unity Test Framework (UTF) EditMode 测试
- Assembly Definition 文件（asmdef）隔离编译

**Spec 源文件：** `docs/superpowers/specs/2026-04-19-custom-model-import-plugin-design.md`

**工作目录：** `/opt/luna-base-template/`（Unity 工程根目录）

---

## 拍板默认值（已确认）

1. 扫描默认范围 = 所有含 MeshFilter 的 GameObject；名称前缀过滤器可选、默认空
2. 多子 MeshRenderer 模型 = v1 只取第一个 + UI 标黄警告（不禁止）
3. 打 .unitypackage = 是（S5 里包含脚本）
4. 命名空间 = `ModelReplacementTool`（通用，未来可独立）

---

## 文件结构总览

```
/opt/luna-base-template/Assets/Editor/ModelReplacementTool/
├── ModelReplacementTool.Editor.asmdef     # 编译隔离
├── ModelReplacementWindow.cs               # EditorWindow UI 主入口
├── SceneScanner.cs                         # 扫描 + 过滤
├── ModelReplacer.cs                        # Mesh/Material 替换核心
├── ModelImportHelpers.cs                   # FBX/GLB 导入 + 重名处理
└── Tests/
    ├── ModelReplacementTool.Tests.asmdef   # 测试程序集
    ├── SceneScannerTests.cs                # 扫描/过滤单元测试
    ├── ModelReplacerTests.cs               # 替换逻辑单元测试
    └── ModelImportHelpersTests.cs          # 导入辅助单元测试

/opt/luna-base-template/tools/
└── build-unitypackage.sh                   # CI 打包脚本（S5）
```

每个 `.cs` 文件职责单一；测试按模块 1:1 镜像。`ModelReplacementWindow.cs` 因含 `OnGUI` 逻辑不写单测（手动验收）。

---

## 文件职责边界

| 文件 | 输入 | 输出 | 纯函数？ |
|------|------|------|---------|
| `SceneScanner.cs` | `Scene` + 过滤选项 | `List<GameObject>` | 是（给定 scene + 过滤器即确定） |
| `ModelReplacer.cs` | `GameObject target` + `GameObject importedModel` | void（副作用改 target.Mesh/Material） | 否（有副作用，可单测） |
| `ModelImportHelpers.cs` | `string srcFilePath` | `GameObject`（已导入资产） | 否（有 IO 副作用） |
| `ModelReplacementWindow.cs` | 用户 UI 交互 | 调用上述三个 | UI，不单测 |

---

## TDD 基本循环（每个 step 2-5 分钟）

Unity Test Runner 运行方式：编辑器内 `Window → General → Test Runner` → EditMode → `Run All`。CI 版本用命令行：

```bash
/opt/unity/Editor/Unity -batchmode -nographics \
  -projectPath /opt/luna-base-template \
  -runTests -testPlatform EditMode \
  -testResults /tmp/test-results.xml -quit
```

每个 Task 的验证 step 用这个命令，期望 exit code 0 + `/tmp/test-results.xml` 里 `<test-run result="Passed">`。

如果当前环境没装 Unity CLI，退化为手动在编辑器里点 Run All（plan 里的"Run"命令可替换）。

---

# Stage 0 — 项目骨架

**目标**：Unity 菜单 `Tools/Model Replacement Tool` 打开一个空 EditorWindow。

### Task 0.1: 创建目录结构 + asmdef

**Files:**
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/ModelReplacementTool.Editor.asmdef`
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/Tests/ModelReplacementTool.Tests.asmdef`

- [ ] **Step 1: 创建主 asmdef**

文件内容：
```json
{
  "name": "ModelReplacementTool.Editor",
  "rootNamespace": "ModelReplacementTool",
  "references": [],
  "includePlatforms": ["Editor"],
  "excludePlatforms": [],
  "allowUnsafeCode": false,
  "overrideReferences": false,
  "autoReferenced": true,
  "defineConstraints": [],
  "versionDefines": [],
  "noEngineReferences": false
}
```

- [ ] **Step 2: 创建测试 asmdef**

```json
{
  "name": "ModelReplacementTool.Tests",
  "rootNamespace": "ModelReplacementTool.Tests",
  "references": [
    "ModelReplacementTool.Editor",
    "UnityEngine.TestRunner",
    "UnityEditor.TestRunner"
  ],
  "includePlatforms": ["Editor"],
  "excludePlatforms": [],
  "allowUnsafeCode": false,
  "overrideReferences": true,
  "precompiledReferences": [
    "nunit.framework.dll"
  ],
  "autoReferenced": false,
  "defineConstraints": [
    "UNITY_INCLUDE_TESTS"
  ],
  "versionDefines": [],
  "noEngineReferences": false
}
```

- [ ] **Step 3: 在 Unity 编辑器里验证两个 asmdef 被识别**

打开 Unity，等 Asset Refresh 完成。在 Project 窗口里点 `ModelReplacementTool.Editor.asmdef`，Inspector 应显示 asmdef 编辑器；同理测试 asmdef。

期望：无红色错误，两个 asmdef 分别生成 `ModelReplacementTool.Editor.dll` 和 `ModelReplacementTool.Tests.dll`。

- [ ] **Step 4: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/
git commit -m "feat(model-tool): scaffold asmdef files for editor + tests"
```

---

### Task 0.2: 空 EditorWindow + 菜单项

**Files:**
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/ModelReplacementWindow.cs`

- [ ] **Step 1: 写最小 EditorWindow**

```csharp
using UnityEditor;
using UnityEngine;

namespace ModelReplacementTool {
    public class ModelReplacementWindow : EditorWindow {
        [MenuItem("Tools/Model Replacement Tool")]
        public static void Open() {
            GetWindow<ModelReplacementWindow>("Model Replacement");
        }

        private void OnGUI() {
            EditorGUILayout.LabelField("Model Replacement Tool", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("Stage 0 skeleton - UI not wired yet.", MessageType.Info);
        }
    }
}
```

- [ ] **Step 2: 在 Unity 里验证菜单能打开窗口**

等 Asset Refresh 完成后，点 Unity 菜单 `Tools → Model Replacement Tool`。

期望：弹出一个可拖拽的 EditorWindow，标题 "Model Replacement"，内容显示粗体标题和蓝色 Info 提示条。

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/ModelReplacementWindow.cs
git commit -m "feat(model-tool): add menu item + empty editor window"
```

---

# Stage 1 — 扫描 + 列表渲染

**目标**：打开窗口看到当前场景所有含 MeshFilter 的 GameObject，每行显示名称 + 当前 Mesh 资产名，点击能在 Hierarchy 定位。

### Task 1.1: SceneScanner 空场景返回空列表（TDD: 红）

**Files:**
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/Tests/SceneScannerTests.cs`

- [ ] **Step 1: 写失败测试**

```csharp
using System.Collections.Generic;
using NUnit.Framework;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;
using ModelReplacementTool;

namespace ModelReplacementTool.Tests {
    public class SceneScannerTests {
        [Test]
        public void Scan_EmptyScene_ReturnsEmpty() {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var result = SceneScanner.Scan(scene);
            Assert.IsNotNull(result);
            Assert.AreEqual(0, result.Count);
        }
    }
}
```

- [ ] **Step 2: 运行测试，期望 FAIL（`SceneScanner` 类不存在）**

```bash
/opt/unity/Editor/Unity -batchmode -nographics \
  -projectPath /opt/luna-base-template \
  -runTests -testPlatform EditMode \
  -testResults /tmp/test-results.xml -quit
```

期望编译错误：`The type or namespace name 'SceneScanner' could not be found`。

---

### Task 1.2: SceneScanner 骨架（TDD: 绿）

**Files:**
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/SceneScanner.cs`

- [ ] **Step 1: 最小实现让测试通过**

```csharp
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace ModelReplacementTool {
    public static class SceneScanner {
        public static List<GameObject> Scan(Scene scene) {
            var result = new List<GameObject>();
            if (!scene.IsValid()) return result;
            foreach (var root in scene.GetRootGameObjects()) {
                var mfs = root.GetComponentsInChildren<MeshFilter>(includeInactive: true);
                foreach (var mf in mfs) {
                    result.Add(mf.gameObject);
                }
            }
            return result;
        }
    }
}
```

- [ ] **Step 2: 运行测试，期望 PASS**

```bash
/opt/unity/Editor/Unity -batchmode -nographics \
  -projectPath /opt/luna-base-template -runTests -testPlatform EditMode \
  -testResults /tmp/test-results.xml -quit
grep 'result="Passed"' /tmp/test-results.xml
```

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/SceneScanner.cs \
        Assets/Editor/ModelReplacementTool/Tests/SceneScannerTests.cs
git commit -m "feat(model-tool): SceneScanner skeleton + empty scene test"
```

---

### Task 1.3: 场景含 MeshFilter 返回对应 GameObject

- [ ] **Step 1: 加测试（红）**

追加到 `SceneScannerTests.cs`：

```csharp
[Test]
public void Scan_SceneWithThreeMeshFilters_ReturnsAll() {
    var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    var a = GameObject.CreatePrimitive(PrimitiveType.Cube);
    var b = GameObject.CreatePrimitive(PrimitiveType.Sphere);
    var c = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
    SceneManager.MoveGameObjectToScene(a, scene);
    SceneManager.MoveGameObjectToScene(b, scene);
    SceneManager.MoveGameObjectToScene(c, scene);

    var result = SceneScanner.Scan(scene);

    Assert.AreEqual(3, result.Count);
    CollectionAssert.Contains(result, a);
    CollectionAssert.Contains(result, b);
    CollectionAssert.Contains(result, c);
}
```

- [ ] **Step 2: 运行测试，期望 PASS（实现已支持）**

因为 SceneScanner.Scan 已递归收集 MeshFilter，这个测试应该直接 PASS。如果 FAIL，对照 Scan 逻辑调试。

- [ ] **Step 3: 加排除 MeshFilter 外对象的测试**

```csharp
[Test]
public void Scan_IgnoresGameObjectsWithoutMeshFilter() {
    var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    var withMesh = GameObject.CreatePrimitive(PrimitiveType.Cube);
    var empty = new GameObject("Empty");
    var light = new GameObject("Light");
    light.AddComponent<Light>();
    SceneManager.MoveGameObjectToScene(withMesh, scene);
    SceneManager.MoveGameObjectToScene(empty, scene);
    SceneManager.MoveGameObjectToScene(light, scene);

    var result = SceneScanner.Scan(scene);

    Assert.AreEqual(1, result.Count);
    Assert.AreEqual(withMesh, result[0]);
}
```

- [ ] **Step 4: 运行，期望 PASS + Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/Tests/SceneScannerTests.cs
git commit -m "test(model-tool): verify scan returns MeshFilter GameObjects only"
```

---

### Task 1.4: Window 渲染列表

- [ ] **Step 1: 修改 `ModelReplacementWindow.cs` 渲染列表**

```csharp
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace ModelReplacementTool {
    public class ModelReplacementWindow : EditorWindow {
        private Vector2 _scroll;
        private List<GameObject> _cached = new List<GameObject>();

        [MenuItem("Tools/Model Replacement Tool")]
        public static void Open() {
            GetWindow<ModelReplacementWindow>("Model Replacement");
        }

        private void OnEnable() { Refresh(); }
        private void OnHierarchyChange() { Refresh(); Repaint(); }

        private void Refresh() {
            var scene = EditorSceneManager.GetActiveScene();
            _cached = SceneScanner.Scan(scene);
        }

        private void OnGUI() {
            DrawToolbar();
            _scroll = EditorGUILayout.BeginScrollView(_scroll);
            foreach (var go in _cached) {
                if (go == null) continue;
                DrawRow(go);
            }
            EditorGUILayout.EndScrollView();
        }

        private void DrawToolbar() {
            EditorGUILayout.BeginHorizontal(EditorStyles.toolbar);
            if (GUILayout.Button("刷新", EditorStyles.toolbarButton, GUILayout.Width(60))) Refresh();
            GUILayout.FlexibleSpace();
            GUILayout.Label($"{_cached.Count} objects", EditorStyles.miniLabel);
            EditorGUILayout.EndHorizontal();
        }

        private void DrawRow(GameObject go) {
            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.ObjectField(go, typeof(GameObject), true);
            var mf = go.GetComponent<MeshFilter>();
            var meshName = mf != null && mf.sharedMesh != null ? mf.sharedMesh.name : "(none)";
            GUILayout.Label(meshName, GUILayout.Width(160));
            EditorGUILayout.EndHorizontal();
        }
    }
}
```

- [ ] **Step 2: 手动验证**

打开 Unity → 新建一个场景，放几个 Cube/Sphere → 打开 `Tools → Model Replacement Tool`。

期望：窗口里每个 Cube/Sphere 一行，展示对象字段 + Mesh 名字（`Cube`/`Sphere`）。点击对象字段能在 Hierarchy 高亮该 GameObject。新建新对象后窗口自动刷新（`OnHierarchyChange`）。

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/ModelReplacementWindow.cs
git commit -m "feat(model-tool): render scene scan result in editor window"
```

---

# Stage 2 — 名称前缀过滤器

**目标**：Toolbar 加文本框，填前缀后列表即时过滤。Tag/Layer 过滤 v1 不做（YAGNI）。

### Task 2.1: SceneScanner 加过滤参数（TDD: 红）

- [ ] **Step 1: 加测试**

追加到 `SceneScannerTests.cs`：

```csharp
[Test]
public void Scan_WithPrefixFilter_ReturnsOnlyMatching() {
    var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    var pool1 = GameObject.CreatePrimitive(PrimitiveType.Cube);
    pool1.name = "__Pool_Cube_Red_01";
    var pool2 = GameObject.CreatePrimitive(PrimitiveType.Sphere);
    pool2.name = "__Pool_Sphere_Blue_02";
    var other = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
    other.name = "SomeCylinder";
    SceneManager.MoveGameObjectToScene(pool1, scene);
    SceneManager.MoveGameObjectToScene(pool2, scene);
    SceneManager.MoveGameObjectToScene(other, scene);

    var result = SceneScanner.Scan(scene, namePrefix: "__Pool_");

    Assert.AreEqual(2, result.Count);
    CollectionAssert.DoesNotContain(result, other);
}

[Test]
public void Scan_WithEmptyPrefix_ReturnsAll() {
    var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    var a = GameObject.CreatePrimitive(PrimitiveType.Cube);
    SceneManager.MoveGameObjectToScene(a, scene);

    var resultEmpty = SceneScanner.Scan(scene, namePrefix: "");
    var resultNull = SceneScanner.Scan(scene, namePrefix: null);

    Assert.AreEqual(1, resultEmpty.Count);
    Assert.AreEqual(1, resultNull.Count);
}
```

- [ ] **Step 2: 运行测试，期望编译错 / FAIL（`namePrefix` 参数不存在）**

---

### Task 2.2: 实现过滤（TDD: 绿）

- [ ] **Step 1: 修改 `SceneScanner.cs`**

把 Scan 改成带默认参数：

```csharp
public static List<GameObject> Scan(Scene scene, string namePrefix = null) {
    var result = new List<GameObject>();
    if (!scene.IsValid()) return result;
    var hasFilter = !string.IsNullOrEmpty(namePrefix);
    foreach (var root in scene.GetRootGameObjects()) {
        var mfs = root.GetComponentsInChildren<MeshFilter>(includeInactive: true);
        foreach (var mf in mfs) {
            var go = mf.gameObject;
            if (hasFilter && !go.name.StartsWith(namePrefix)) continue;
            result.Add(go);
        }
    }
    return result;
}
```

- [ ] **Step 2: 运行测试，期望全部 PASS**

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/SceneScanner.cs \
        Assets/Editor/ModelReplacementTool/Tests/SceneScannerTests.cs
git commit -m "feat(model-tool): name-prefix filter for SceneScanner"
```

---

### Task 2.3: Window 接入过滤文本框

- [ ] **Step 1: 修改 `ModelReplacementWindow.cs`**

在字段区加：
```csharp
private string _filterPrefix = "";
```

`DrawToolbar` 改为：
```csharp
private void DrawToolbar() {
    EditorGUILayout.BeginHorizontal(EditorStyles.toolbar);
    if (GUILayout.Button("刷新", EditorStyles.toolbarButton, GUILayout.Width(60))) Refresh();
    GUILayout.Label("前缀:", GUILayout.Width(40));
    var newPrefix = EditorGUILayout.TextField(_filterPrefix, EditorStyles.toolbarTextField, GUILayout.Width(200));
    if (newPrefix != _filterPrefix) {
        _filterPrefix = newPrefix;
        Refresh();
    }
    GUILayout.FlexibleSpace();
    GUILayout.Label($"{_cached.Count} objects", EditorStyles.miniLabel);
    EditorGUILayout.EndHorizontal();
}
```

`Refresh` 改为传入 prefix：
```csharp
private void Refresh() {
    var scene = EditorSceneManager.GetActiveScene();
    _cached = SceneScanner.Scan(scene, _filterPrefix);
}
```

- [ ] **Step 2: 手动验证**

打开场景 → Tool 窗口 → 前缀框填 `__Pool_`，应该只剩 pool 对象。清空后回到全部。

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/ModelReplacementWindow.cs
git commit -m "feat(model-tool): wire name-prefix filter in toolbar"
```

---

# Stage 3 — 导入 + 替换核心

**目标**：每行"选模型"按钮 → 文件选择器 → FBX 导入 `Assets/Models/` → 替换目标 GameObject 的 Mesh + Material，Transform 保持不变。

### Task 3.1: ModelReplacer 替换保持 Transform（TDD: 红）

**Files:**
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/Tests/ModelReplacerTests.cs`

- [ ] **Step 1: 写测试**

```csharp
using NUnit.Framework;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using ModelReplacementTool;

namespace ModelReplacementTool.Tests {
    public class ModelReplacerTests {
        [Test]
        public void Replace_KeepsTransform() {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var target = GameObject.CreatePrimitive(PrimitiveType.Cube);
            target.transform.position = new Vector3(1, 2, 3);
            target.transform.localScale = new Vector3(4, 5, 6);
            target.transform.rotation = Quaternion.Euler(10, 20, 30);
            SceneManager.MoveGameObjectToScene(target, scene);

            var source = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            ModelReplacer.Replace(target, source);

            Assert.AreEqual(new Vector3(1, 2, 3), target.transform.position);
            Assert.AreEqual(new Vector3(4, 5, 6), target.transform.localScale);
            Assert.AreEqual(Quaternion.Euler(10, 20, 30), target.transform.rotation);
        }
    }
}
```

- [ ] **Step 2: 运行测试，期望编译错（`ModelReplacer` 不存在）**

---

### Task 3.2: ModelReplacer 骨架（TDD: 绿）

**Files:**
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/ModelReplacer.cs`

- [ ] **Step 1: 实现**

```csharp
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace ModelReplacementTool {
    public static class ModelReplacer {
        public static void Replace(GameObject target, GameObject importedModel) {
            if (target == null || importedModel == null) return;

            var srcMf = importedModel.GetComponentInChildren<MeshFilter>();
            var srcMr = importedModel.GetComponentInChildren<MeshRenderer>();
            if (srcMf == null || srcMf.sharedMesh == null) {
                Debug.LogWarning($"[ModelReplacer] source '{importedModel.name}' has no MeshFilter/Mesh");
                return;
            }

            var tgtMf = target.GetComponent<MeshFilter>() ?? target.AddComponent<MeshFilter>();
            var tgtMr = target.GetComponent<MeshRenderer>() ?? target.AddComponent<MeshRenderer>();

            tgtMf.sharedMesh = srcMf.sharedMesh;
            if (srcMr != null) tgtMr.sharedMaterials = srcMr.sharedMaterials;

            if (target.scene.IsValid()) EditorSceneManager.MarkSceneDirty(target.scene);
        }
    }
}
```

- [ ] **Step 2: 运行测试，期望 PASS**

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/ModelReplacer.cs \
        Assets/Editor/ModelReplacementTool/Tests/ModelReplacerTests.cs
git commit -m "feat(model-tool): ModelReplacer preserves transform on replace"
```

---

### Task 3.3: Replace 复制 Mesh 和 Material

- [ ] **Step 1: 加测试**

追加到 `ModelReplacerTests.cs`：

```csharp
[Test]
public void Replace_CopiesMeshAndMaterials() {
    var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    var target = GameObject.CreatePrimitive(PrimitiveType.Cube);
    SceneManager.MoveGameObjectToScene(target, scene);
    var originalMesh = target.GetComponent<MeshFilter>().sharedMesh;

    var source = GameObject.CreatePrimitive(PrimitiveType.Sphere);
    var sourceMesh = source.GetComponent<MeshFilter>().sharedMesh;
    var sourceMaterials = source.GetComponent<MeshRenderer>().sharedMaterials;

    ModelReplacer.Replace(target, source);

    Assert.AreNotEqual(originalMesh, target.GetComponent<MeshFilter>().sharedMesh);
    Assert.AreEqual(sourceMesh, target.GetComponent<MeshFilter>().sharedMesh);
    CollectionAssert.AreEqual(sourceMaterials, target.GetComponent<MeshRenderer>().sharedMaterials);
}

[Test]
public void Replace_KeepsOtherComponents() {
    var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    var target = GameObject.CreatePrimitive(PrimitiveType.Cube);
    var collider = target.AddComponent<SphereCollider>();
    SceneManager.MoveGameObjectToScene(target, scene);

    var source = GameObject.CreatePrimitive(PrimitiveType.Sphere);
    ModelReplacer.Replace(target, source);

    Assert.IsNotNull(target.GetComponent<SphereCollider>());
    Assert.AreEqual(collider, target.GetComponent<SphereCollider>());
}
```

- [ ] **Step 2: 运行测试，期望 PASS（实现已满足）**

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/Tests/ModelReplacerTests.cs
git commit -m "test(model-tool): verify mesh/material copy + other components kept"
```

---

### Task 3.4: Replace target 无 MeshFilter 自动 AddComponent

- [ ] **Step 1: 加测试**

追加到 `ModelReplacerTests.cs`：

```csharp
[Test]
public void Replace_TargetWithoutMeshFilter_AddsComponents() {
    var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    var target = new GameObject("Empty");
    SceneManager.MoveGameObjectToScene(target, scene);

    var source = GameObject.CreatePrimitive(PrimitiveType.Cube);
    ModelReplacer.Replace(target, source);

    Assert.IsNotNull(target.GetComponent<MeshFilter>());
    Assert.IsNotNull(target.GetComponent<MeshRenderer>());
    Assert.AreEqual(source.GetComponent<MeshFilter>().sharedMesh,
                    target.GetComponent<MeshFilter>().sharedMesh);
}
```

- [ ] **Step 2: 运行测试，期望 PASS（实现已用 `?? AddComponent`）**

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/Tests/ModelReplacerTests.cs
git commit -m "test(model-tool): target without MeshFilter auto-adds components"
```

---

### Task 3.5: ModelImportHelpers 默认设置（TDD: 红）

**Files:**
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/Tests/ModelImportHelpersTests.cs`

- [ ] **Step 1: 写测试**

```csharp
using System.IO;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using ModelReplacementTool;

namespace ModelReplacementTool.Tests {
    public class ModelImportHelpersTests {
        private const string TestAssetsDir = "Assets/Models";
        private static string _fixtureFbx;

        [OneTimeSetUp]
        public void Setup() {
            // 从已有 Unity 内置资产复制一个 FBX 来做 fixture
            // 或者下面 Task 里手动放一个 cube.fbx 到 Assets/Editor/ModelReplacementTool/Tests/Fixtures/
            _fixtureFbx = "Assets/Editor/ModelReplacementTool/Tests/Fixtures/cube.fbx";
            Assume.That(File.Exists(_fixtureFbx), "Test fixture missing; place cube.fbx in Tests/Fixtures/");
        }

        [TearDown]
        public void Cleanup() {
            if (Directory.Exists(TestAssetsDir)) {
                AssetDatabase.DeleteAsset(TestAssetsDir);
                AssetDatabase.Refresh();
            }
        }

        [Test]
        public void Import_AppliesDefaultSettings() {
            var imported = ModelImportHelpers.Import(_fixtureFbx);
            Assert.IsNotNull(imported);
            var destPath = AssetDatabase.GetAssetPath(imported);
            var importer = (ModelImporter)AssetImporter.GetAtPath(destPath);
            Assert.AreEqual(ModelImporterAnimationType.None, importer.animationType);
            Assert.IsFalse(importer.importCameras);
            Assert.IsFalse(importer.importLights);
        }

        [Test]
        public void GenerateUniqueName_IncrementsSuffix() {
            Assert.AreEqual("Assets/Models/tree_1.fbx",
                ModelImportHelpers.GenerateUniqueName("Assets/Models/tree.fbx",
                    exists: p => p == "Assets/Models/tree.fbx"));
            Assert.AreEqual("Assets/Models/tree_2.fbx",
                ModelImportHelpers.GenerateUniqueName("Assets/Models/tree.fbx",
                    exists: p => p == "Assets/Models/tree.fbx" || p == "Assets/Models/tree_1.fbx"));
            Assert.AreEqual("Assets/Models/tree.fbx",
                ModelImportHelpers.GenerateUniqueName("Assets/Models/tree.fbx",
                    exists: p => false));
        }
    }
}
```

**注**：fixture `cube.fbx` 在 Task 3.6 里加入。

- [ ] **Step 2: 运行，期望编译错**

---

### Task 3.6: ModelImportHelpers 实现（TDD: 绿）

**Files:**
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/ModelImportHelpers.cs`
- Create: `/opt/luna-base-template/Assets/Editor/ModelReplacementTool/Tests/Fixtures/cube.fbx`（导出 Unity 内置 Cube 为 FBX，或从任何免费 CC0 模型取一份）

- [ ] **Step 1: 加 fixture FBX**

在 Unity 里把内置 Cube 拖出来 → 右键 `Model → Export FBX` → 存到 `Assets/Editor/ModelReplacementTool/Tests/Fixtures/cube.fbx`。或用命令：

```bash
# 用已有的任一 FBX 资产当 fixture，比如（如果工程里本来就有 FBX）:
find /opt/luna-base-template/Assets -name "*.fbx" | head -1
# 复制：
mkdir -p /opt/luna-base-template/Assets/Editor/ModelReplacementTool/Tests/Fixtures
cp <找到的 fbx> /opt/luna-base-template/Assets/Editor/ModelReplacementTool/Tests/Fixtures/cube.fbx
```

如果工程里没 FBX，跳过 `Import_AppliesDefaultSettings` 这个测试（`[Ignore]`），只跑 `GenerateUniqueName_IncrementsSuffix`（纯逻辑不需 fixture）。

- [ ] **Step 2: 实现 `ModelImportHelpers.cs`**

```csharp
using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace ModelReplacementTool {
    public static class ModelImportHelpers {
        private const string DefaultImportDir = "Assets/Models";

        public static GameObject Import(string srcFilePath, Func<string, bool> exists = null) {
            if (!File.Exists(srcFilePath)) {
                Debug.LogError($"[ModelImportHelpers] source not found: {srcFilePath}");
                return null;
            }

            Directory.CreateDirectory(DefaultImportDir);
            exists = exists ?? File.Exists;

            var fileName = Path.GetFileName(srcFilePath);
            var destPath = Path.Combine(DefaultImportDir, fileName).Replace('\\', '/');
            destPath = GenerateUniqueName(destPath, exists);

            File.Copy(srcFilePath, destPath, overwrite: false);
            AssetDatabase.ImportAsset(destPath);

            var importer = AssetImporter.GetAtPath(destPath) as ModelImporter;
            if (importer != null) {
                importer.animationType = ModelImporterAnimationType.None;
                importer.importCameras = false;
                importer.importLights = false;
                importer.SaveAndReimport();
            }

            return AssetDatabase.LoadAssetAtPath<GameObject>(destPath);
        }

        public static string GenerateUniqueName(string destPath, Func<string, bool> exists) {
            if (!exists(destPath)) return destPath;
            var dir = Path.GetDirectoryName(destPath).Replace('\\', '/');
            var stem = Path.GetFileNameWithoutExtension(destPath);
            var ext = Path.GetExtension(destPath);
            for (int i = 1; i < 10000; i++) {
                var candidate = $"{dir}/{stem}_{i}{ext}";
                if (!exists(candidate)) return candidate;
            }
            throw new InvalidOperationException("No unique name found in 10000 attempts");
        }
    }
}
```

- [ ] **Step 3: 运行测试，期望 PASS**

- [ ] **Step 4: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/ModelImportHelpers.cs \
        Assets/Editor/ModelReplacementTool/Tests/ModelImportHelpersTests.cs \
        Assets/Editor/ModelReplacementTool/Tests/Fixtures/
git commit -m "feat(model-tool): ModelImportHelpers with default settings + unique naming"
```

---

### Task 3.7: Window 接入"选模型"按钮

- [ ] **Step 1: 修改 `ModelReplacementWindow.cs`**

`DrawRow` 改为：

```csharp
private void DrawRow(GameObject go) {
    EditorGUILayout.BeginHorizontal();
    EditorGUILayout.ObjectField(go, typeof(GameObject), true);
    var mf = go.GetComponent<MeshFilter>();
    var meshName = mf != null && mf.sharedMesh != null ? mf.sharedMesh.name : "(none)";
    GUILayout.Label(meshName, GUILayout.Width(160));
    if (GUILayout.Button("选模型", GUILayout.Width(80))) {
        OnSelectModel(go);
    }
    EditorGUILayout.EndHorizontal();
}

private void OnSelectModel(GameObject target) {
    var path = EditorUtility.OpenFilePanel("选择模型", "", "fbx,glb,obj");
    if (string.IsNullOrEmpty(path)) return;
    var imported = ModelImportHelpers.Import(path);
    if (imported == null) {
        EditorUtility.DisplayDialog("导入失败", "无法导入该模型。", "确定");
        return;
    }
    ModelReplacer.Replace(target, imported);
    Repaint();
}
```

- [ ] **Step 2: 手动端到端验证**

Unity 里：找一份 FBX → 打开 Tool 窗口 → 选一个 Cube 那行的"选模型"按钮 → 文件选择器选该 FBX → 关闭对话框后场景里该 Cube 立刻变成 FBX 模型形态，Transform（位置/旋转/缩放）不变。

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add Assets/Editor/ModelReplacementTool/ModelReplacementWindow.cs
git commit -m "feat(model-tool): wire select-model button end-to-end"
```

---

# Stage 4 — 批量 + 边界情况

**目标**：多选批量替换、处理 spec §4 全部边界情况。

### Task 4.1: 每行加选择框

- [ ] **Step 1: Window 加选择状态**

`ModelReplacementWindow.cs` 字段：

```csharp
private HashSet<int> _selected = new HashSet<int>();
```

`DrawRow` 开头加：

```csharp
var id = go.GetInstanceID();
var isSelected = _selected.Contains(id);
var newSelected = EditorGUILayout.Toggle(isSelected, GUILayout.Width(18));
if (newSelected != isSelected) {
    if (newSelected) _selected.Add(id); else _selected.Remove(id);
}
```

Toolbar 加：

```csharp
if (GUILayout.Button("全选", EditorStyles.toolbarButton, GUILayout.Width(50))) {
    foreach (var go in _cached) _selected.Add(go.GetInstanceID());
}
if (GUILayout.Button("清空选择", EditorStyles.toolbarButton, GUILayout.Width(70))) {
    _selected.Clear();
}
```

- [ ] **Step 2: 手动验证勾选 / 全选 / 清空能正常工作**

- [ ] **Step 3: Commit**

```bash
git add Assets/Editor/ModelReplacementTool/ModelReplacementWindow.cs
git commit -m "feat(model-tool): multi-selection toggles"
```

---

### Task 4.2: 批量替换按钮

- [ ] **Step 1: Toolbar 加按钮**

```csharp
if (GUILayout.Button("批量选模型", EditorStyles.toolbarButton, GUILayout.Width(90))) {
    OnBatchReplace();
}
```

- [ ] **Step 2: 实现 `OnBatchReplace`**

```csharp
private void OnBatchReplace() {
    if (_selected.Count == 0) {
        EditorUtility.DisplayDialog("未选中对象", "请先勾选要批量替换的对象。", "确定");
        return;
    }
    var path = EditorUtility.OpenFilePanel("批量选择模型", "", "fbx,glb,obj");
    if (string.IsNullOrEmpty(path)) return;
    var imported = ModelImportHelpers.Import(path);
    if (imported == null) {
        EditorUtility.DisplayDialog("导入失败", "无法导入该模型。", "确定");
        return;
    }
    int count = 0;
    foreach (var go in _cached) {
        if (_selected.Contains(go.GetInstanceID())) {
            ModelReplacer.Replace(go, imported);
            count++;
        }
    }
    EditorUtility.DisplayDialog("完成", $"已替换 {count} 个对象。", "确定");
    Repaint();
}
```

- [ ] **Step 3: 手动验证：勾 3 个 → 批量选模型 → 3 个同时变**

- [ ] **Step 4: Commit**

```bash
git add Assets/Editor/ModelReplacementTool/ModelReplacementWindow.cs
git commit -m "feat(model-tool): batch replace for selected objects"
```

---

### Task 4.3: 源模型无 MeshFilter → 警告不替换

- [ ] **Step 1: 修改 `ModelReplacer.Replace` 返回值为 bool + 原因枚举**

```csharp
public enum ReplaceResult { Success, SourceMissingMesh, TargetIsPrefabInstance, NullInput }

public static ReplaceResult Replace(GameObject target, GameObject importedModel) {
    if (target == null || importedModel == null) return ReplaceResult.NullInput;
    var srcMf = importedModel.GetComponentInChildren<MeshFilter>();
    if (srcMf == null || srcMf.sharedMesh == null) return ReplaceResult.SourceMissingMesh;
    // ... 其余逻辑同前 ...
    return ReplaceResult.Success;
}
```

- [ ] **Step 2: 更新现有测试适配新签名**

所有 `ModelReplacer.Replace(...)` 调用改为检查返回值。

- [ ] **Step 3: 加测试**

```csharp
[Test]
public void Replace_SourceWithoutMeshFilter_ReturnsSourceMissingMesh() {
    var target = GameObject.CreatePrimitive(PrimitiveType.Cube);
    var source = new GameObject("Empty");
    var result = ModelReplacer.Replace(target, source);
    Assert.AreEqual(ModelReplacer.ReplaceResult.SourceMissingMesh, result);
    // target 不变
    Assert.IsNotNull(target.GetComponent<MeshFilter>().sharedMesh);
}
```

- [ ] **Step 4: Window 处理失败结果**

`OnSelectModel` 和 `OnBatchReplace` 里根据返回值弹窗：

```csharp
var result = ModelReplacer.Replace(target, imported);
if (result == ModelReplacer.ReplaceResult.SourceMissingMesh) {
    EditorUtility.DisplayDialog("模型无 Mesh", "该模型不包含可用的 Mesh 数据，跳过替换。", "确定");
}
```

- [ ] **Step 5: 运行测试 + 手动验证：选一个空 FBX → 弹窗提示 → 场景对象不变**

- [ ] **Step 6: Commit**

```bash
git add Assets/Editor/ModelReplacementTool/ModelReplacer.cs \
        Assets/Editor/ModelReplacementTool/ModelReplacementWindow.cs \
        Assets/Editor/ModelReplacementTool/Tests/ModelReplacerTests.cs
git commit -m "feat(model-tool): warn + skip when source model has no mesh"
```

---

### Task 4.4: 源模型多个子 MeshRenderer → 黄色警告

- [ ] **Step 1: 加测试**

```csharp
[Test]
public void Replace_MultipleChildRenderers_StillSucceedsWithFirst() {
    var target = GameObject.CreatePrimitive(PrimitiveType.Cube);
    var sourceRoot = new GameObject("Root");
    var childA = GameObject.CreatePrimitive(PrimitiveType.Sphere);
    childA.transform.SetParent(sourceRoot.transform);
    var childB = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
    childB.transform.SetParent(sourceRoot.transform);
    int count = 0;
    foreach (var mf in sourceRoot.GetComponentsInChildren<MeshFilter>()) count++;
    Assert.Greater(count, 1);

    var result = ModelReplacer.Replace(target, sourceRoot);
    Assert.AreEqual(ModelReplacer.ReplaceResult.Success, result);
    // 用了第一个子
    Assert.AreEqual(childA.GetComponent<MeshFilter>().sharedMesh,
                    target.GetComponent<MeshFilter>().sharedMesh);
}
```

- [ ] **Step 2: 加 `ReplaceResult` + 输出参数告知 UI**

加新字段：
```csharp
public class ReplaceReport {
    public ReplaceResult Result;
    public int ChildRendererCount;
    public bool HasAnimator;
}
```

修改 Replace 返回 `ReplaceReport`。测试同步更新。

- [ ] **Step 3: Window UI 上黄色 HelpBox 提示**

`OnSelectModel` 里如果 `report.ChildRendererCount > 1`:

```csharp
EditorUtility.DisplayDialog("多子 Renderer 警告",
    $"该模型含 {report.ChildRendererCount} 个子 Renderer，v1 只使用第一个。", "确定");
```

- [ ] **Step 4: 运行测试 + Commit**

```bash
git add Assets/Editor/ModelReplacementTool/
git commit -m "feat(model-tool): warn on multi-child-renderer models"
```

---

### Task 4.5: 目标是 Prefab 实例 → 阻止

- [ ] **Step 1: 加测试**

Unity 里 PrefabUtility 在 headless 测试不易构造 Prefab 实例，这个用手动验证。spec §4 说"弹窗提示用户去 Prefab 里改"。

- [ ] **Step 2: 实现防御**

`ModelReplacer.Replace` 开头加：

```csharp
if (UnityEditor.PrefabUtility.IsPartOfPrefabInstance(target)) {
    return new ReplaceReport { Result = ReplaceResult.TargetIsPrefabInstance };
}
```

Window 处理：

```csharp
if (report.Result == ModelReplacer.ReplaceResult.TargetIsPrefabInstance) {
    EditorUtility.DisplayDialog("Prefab 实例不支持",
        $"{target.name} 是 Prefab 实例。请打开 Prefab 编辑模式后再替换。", "确定");
}
```

- [ ] **Step 3: 手动验证**

场景拖一个 prefab 实例进来 → tool 里点"选模型" → 弹窗阻止。

- [ ] **Step 4: Commit**

```bash
git add Assets/Editor/ModelReplacementTool/
git commit -m "feat(model-tool): block replacing prefab instances with dialog"
```

---

### Task 4.6: DrawRow 显示完整 Hierarchy 路径

- [ ] **Step 1: 加工具方法**

`SceneScanner.cs`：

```csharp
public static string GetHierarchyPath(GameObject go) {
    var path = go.name;
    var t = go.transform.parent;
    while (t != null) {
        path = t.name + "/" + path;
        t = t.parent;
    }
    return path;
}
```

- [ ] **Step 2: 单测**

```csharp
[Test]
public void GetHierarchyPath_ReturnsFullPath() {
    var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    var root = new GameObject("Root");
    var child = new GameObject("Child");
    var grand = new GameObject("Grand");
    child.transform.SetParent(root.transform);
    grand.transform.SetParent(child.transform);
    SceneManager.MoveGameObjectToScene(root, scene);
    Assert.AreEqual("Root/Child/Grand", SceneScanner.GetHierarchyPath(grand));
}
```

- [ ] **Step 3: Window DrawRow 用全路径**

```csharp
GUILayout.Label(SceneScanner.GetHierarchyPath(go), GUILayout.Width(250));
// 保留 ObjectField 的点击定位功能
```

- [ ] **Step 4: 运行测试 + Commit**

```bash
git add Assets/Editor/ModelReplacementTool/
git commit -m "feat(model-tool): display full hierarchy path in rows"
```

---

### Task 4.7: 重复文件名对话框

- [ ] **Step 1: 修改 `ModelImportHelpers.Import` 加 onDuplicate 回调**

```csharp
public enum DuplicateAction { Overwrite, Rename, UseExisting }

public static GameObject Import(string srcFilePath, Func<DuplicateAction> onDuplicate = null, Func<string, bool> exists = null) {
    // ... 检查 destPath 是否存在 ...
    if (exists(destPath)) {
        var action = onDuplicate?.Invoke() ?? DuplicateAction.Rename;
        switch (action) {
            case DuplicateAction.Overwrite: File.Copy(srcFilePath, destPath, true); break;
            case DuplicateAction.Rename: destPath = GenerateUniqueName(destPath, exists); File.Copy(srcFilePath, destPath); break;
            case DuplicateAction.UseExisting: return AssetDatabase.LoadAssetAtPath<GameObject>(destPath);
        }
    }
    else {
        File.Copy(srcFilePath, destPath);
    }
    // ... 其余同前 ...
}
```

- [ ] **Step 2: Window 里的回调**

```csharp
var imported = ModelImportHelpers.Import(path, onDuplicate: () => {
    var choice = EditorUtility.DisplayDialogComplex(
        "文件已存在",
        $"Assets/Models/{Path.GetFileName(path)} 已存在。",
        "覆盖", "重命名", "使用已有");
    switch (choice) {
        case 0: return ModelImportHelpers.DuplicateAction.Overwrite;
        case 1: return ModelImportHelpers.DuplicateAction.Rename;
        case 2: return ModelImportHelpers.DuplicateAction.UseExisting;
        default: return ModelImportHelpers.DuplicateAction.Rename;
    }
});
```

- [ ] **Step 3: 加测试验证三种 action 行为**

```csharp
[Test]
public void Import_Duplicate_Rename_GeneratesUniqueName() {
    // 用 mock exists 模拟文件已存在
}
// 其他两种行为类似
```

- [ ] **Step 4: 手动验证 + Commit**

```bash
git add Assets/Editor/ModelReplacementTool/
git commit -m "feat(model-tool): duplicate-file dialog (overwrite/rename/use-existing)"
```

---

# Stage 5 — 测试 + 打包

**目标**：所有单测绿灯 + 能一键导出 `.unitypackage` 到任意工程。

### Task 5.1: 全量测试 pass

- [ ] **Step 1: 跑全量 EditMode 测试**

```bash
/opt/unity/Editor/Unity -batchmode -nographics \
  -projectPath /opt/luna-base-template \
  -runTests -testPlatform EditMode \
  -testResults /tmp/test-results.xml -quit
cat /tmp/test-results.xml | grep -E 'result|total|failed'
```

期望：`total` 等于测试用例总数（S1+S2+S3+S4 约 15-18 个），`failed="0"`，顶层 `<test-run result="Passed">`。

- [ ] **Step 2: 修复所有 failure**

如果有失败，逐个修复——不要跳过。修复完重跑直到全绿。

---

### Task 5.2: 打包脚本

**Files:**
- Create: `/opt/luna-base-template/tools/build-unitypackage.sh`

- [ ] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
set -euo pipefail

UNITY=${UNITY:-/opt/unity/Editor/Unity}
PROJECT=${PROJECT:-/opt/luna-base-template}
OUTPUT=${OUTPUT:-$PROJECT/build/ModelReplacementTool.unitypackage}

mkdir -p "$(dirname "$OUTPUT")"

"$UNITY" -batchmode -nographics -quit \
  -projectPath "$PROJECT" \
  -exportPackage \
    "Assets/Editor/ModelReplacementTool/ModelReplacementTool.Editor.asmdef" \
    "Assets/Editor/ModelReplacementTool/ModelReplacementWindow.cs" \
    "Assets/Editor/ModelReplacementTool/SceneScanner.cs" \
    "Assets/Editor/ModelReplacementTool/ModelReplacer.cs" \
    "Assets/Editor/ModelReplacementTool/ModelImportHelpers.cs" \
    "$OUTPUT"

echo "Exported: $OUTPUT"
ls -lh "$OUTPUT"
```

注意：打包**不含 Tests/ 目录**（外部用户不需要）。

- [ ] **Step 2: 赋执行权 + 跑一次**

```bash
chmod +x /opt/luna-base-template/tools/build-unitypackage.sh
/opt/luna-base-template/tools/build-unitypackage.sh
```

期望：生成 `build/ModelReplacementTool.unitypackage`，体积 < 100KB。

- [ ] **Step 3: Commit**

```bash
cd /opt/luna-base-template
git add tools/build-unitypackage.sh
git commit -m "build(model-tool): unitypackage export script"
```

---

### Task 5.3: 冒烟验证 - 新工程导入

- [ ] **Step 1: 新建一个空 Unity 工程（或用已有空工程）**

手动步骤：Unity Hub → New Project → 2021.3 LTS → Empty。

- [ ] **Step 2: 双击 `.unitypackage` 导入**

期望：`Assets/Editor/ModelReplacementTool/` 目录出现 5 个文件，无编译错误。

- [ ] **Step 3: 功能冒烟**

新场景放几个 Cube → `Tools/Model Replacement Tool` → 扫描到 → 导入一个 FBX → 替换成功。

全部通过 = 插件 v1 完成。

- [ ] **Step 4: 最后 commit（如需）**

```bash
cd /opt/luna-base-template
git log --oneline -20
git tag model-tool-v1
```

---

# 附录：关键实现细节备忘

### 为什么测试用 `EditorSceneManager.NewScene` 而不是直接 new GameObject？

普通 `new GameObject()` 创建的对象不在任何场景里（属于"默认 root"），`SceneScanner.Scan` 按 scene 遍历会漏掉它们。必须显式 `MoveGameObjectToScene`。

### 为什么 `MeshRenderer.sharedMaterials` 而不是 `materials`？

`materials` 访问会**实例化材质**（Unity runtime fork 一份新 Material asset），编辑器下不希望这个副作用。`sharedMaterials` 直接引用资产。

### 为什么 `AddComponent` 不需要 Undo？

spec 明确不做 Undo。正常 `AddComponent` 即可——用户如果误操作，打开插件重新选个正确模型覆盖即可。

### Fixture FBX 从哪来？

Task 3.6 列了两条路：① Unity 编辑器手动导出内置 Cube 为 FBX；② 工程里有现成 FBX 直接复制。如果都没有，跳过 `Import_AppliesDefaultSettings`（`[Ignore]` 标注），只跑 `GenerateUniqueName_IncrementsSuffix` 纯逻辑测试。

### 命名空间统一用 `ModelReplacementTool`

spec §8 Q4 拍板通用命名，不绑 blueprint，未来可独立开源。

---

# Plan Review Loop

Plan 完成。下一步按 writing-plans 指引：

1. 我会 dispatch 一个 `plan-document-reviewer` 子 agent 审查
2. Reviewer 返回 ✅ Approved → 进入执行阶段
3. Reviewer 返回 ❌ Issues → 修复后重审，最多 3 轮

# 执行方案选择

Plan 评审通过后，请选：

**1. Subagent-Driven（推荐）**：每个 Task 一个新 subagent，Task 间我做 review，快速迭代，用 `superpowers:subagent-driven-development`。

**2. Inline Execution**：在当前会话批量执行，中途 checkpoint，用 `superpowers:executing-plans`。

选哪个？
