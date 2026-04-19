# Unity 场景物体模型替换插件设计 spec

> 日期: 2026-04-19
> 作者: Claude
> 状态: 待评审
>
> **scope 声明**：这是一个**纯 Unity Editor 工具**，与 blueprint 流水线、codegen、CUA 无关。它只做一件事：在 Unity 编辑器里打开工程 → 扫场景所有物体 → 给每个物体配用户提供的 3D 模型 → 一键替换。任何项目的任何场景都能用。

---

## 1. 背景

美术 / 程序员打开一个 Unity 工程后，场景里的物体经常是占位几何体（Cube/Sphere 等），视觉辨识度低。需要一个编辑器插件，把这些占位物统一替换成真正的 3D 模型。手动替换流程：Hierarchy 找对象 → 删 MeshFilter → 拖 FBX → 改 Material → 调 Transform，步骤多且易错。插件把这套流程压缩成"每个对象一个按钮"。

---

## 2. 功能边界

### 2.1 做什么

| 功能 | 描述 |
|------|------|
| 扫描当前场景 | 列出 Hierarchy 里所有含 MeshFilter 的 GameObject（可按名称前缀 / Tag / Layer 过滤） |
| 展示列表 | EditorWindow 面板，每行一个 GameObject 名称 + 当前 Mesh 资产名 + 选择按钮 |
| 选择模型 | 点按钮 → 文件选择器，支持 FBX / GLB / OBJ |
| 导入 | 文件复制进 `Assets/Models/` + `AssetDatabase.ImportAsset` |
| 替换 | 将目标 GameObject 的 Mesh + Material 就地替换，Transform / name / 其他组件保持不变 |
| 批量 | 选中多行 → 选一个模型一次性替换全部 |

### 2.2 不做什么

- ❌ 不做 Undo / Ctrl+Z 撤销（替换错了就再次选一个正确模型替换即可）
- ❌ 不做"恢复原始"按钮（同上，插件不记录替换前的 Mesh/Material 引用）
- ❌ 不做运行时动态加载（纯 Editor 工具）
- ❌ 不自动调 Transform / 缩放适配（用户自己在场景里调）
- ❌ 不处理骨骼动画导入（v1 扫描时检测到 Animator 会警告但不阻止）
- ❌ 不做 Prefab 实例化（只换现有 GameObject 的 Mesh/Material，不 Instantiate）
- ❌ 不依赖任何外部系统（blueprint、SVN、CI 都和插件无关）

---

## 3. 技术方案

### 3.1 扫描逻辑

```csharp
// 默认扫当前激活场景的所有根物体，递归找含 MeshFilter 的 GameObject
Scene activeScene = SceneManager.GetActiveScene();
var all = new List<GameObject>();
foreach (var root in activeScene.GetRootGameObjects()) {
    all.AddRange(root.GetComponentsInChildren<MeshFilter>(true)
                     .Select(mf => mf.gameObject));
}
```

**过滤器**（UI 上可切换）：
- 名称前缀（默认空，用户可填 `__Pool_` 这种）
- Tag / Layer（可选）

插件**无状态**——每次打开都按场景当前状况重新扫，不区分"已替换 / 未替换"。每行展示的"当前 Mesh 资产名"（读 `MeshFilter.sharedMesh.name`）本身就足够让用户判断哪些是占位体、哪些已经换过。

### 3.2 替换逻辑

```csharp
public static void ReplaceModel(GameObject target, GameObject importedModel) {
    // 导入的 FBX prefab 可能有多个子 MeshRenderer，v1 只取第一个
    var srcMf = importedModel.GetComponentInChildren<MeshFilter>();
    var srcMr = importedModel.GetComponentInChildren<MeshRenderer>();
    
    var tgtMf = target.GetComponent<MeshFilter>() ?? target.AddComponent<MeshFilter>();
    var tgtMr = target.GetComponent<MeshRenderer>() ?? target.AddComponent<MeshRenderer>();
    
    tgtMf.sharedMesh = srcMf.sharedMesh;
    tgtMr.sharedMaterials = srcMr.sharedMaterials;
    
    EditorSceneManager.MarkSceneDirty(target.scene);
}
```

**关键点**：
- 不动 Transform / 不动 name / 不动其他组件（Collider、自定义脚本等全保留）
- 不加标签组件、不记原始引用——替换错了，用户再次选模型覆盖即可

### 3.3 导入管线

```csharp
public static GameObject ImportModel(string srcFilePath) {
    string fileName = Path.GetFileName(srcFilePath);
    string destPath = Path.Combine("Assets/Models", fileName);
    Directory.CreateDirectory("Assets/Models");
    File.Copy(srcFilePath, destPath, overwrite: false);
    AssetDatabase.ImportAsset(destPath);
    
    // 应用推荐导入设置
    var importer = (ModelImporter)AssetImporter.GetAtPath(destPath);
    importer.animationType = ModelImporterAnimationType.None;  // v1 禁动画
    importer.importLights = false;
    importer.importCameras = false;
    importer.SaveAndReimport();
    
    return AssetDatabase.LoadAssetAtPath<GameObject>(destPath);
}
```

**重复文件处理**：目标路径已存在时弹窗询问"覆盖 / 重命名 / 使用已存在"。

### 3.4 EditorWindow 骨架

```csharp
public class ModelReplacementWindow : EditorWindow {
    [MenuItem("Tools/Model Replacement Tool")]
    static void Open() => GetWindow<ModelReplacementWindow>("Model Replacement");
    
    private Vector2 scroll;
    private string filterPrefix = "";
    private List<GameObject> cached;
    
    void OnGUI() {
        DrawToolbar();  // 刷新 / 名称前缀过滤 / 批量替换
        scroll = EditorGUILayout.BeginScrollView(scroll);
        foreach (var go in GetFilteredObjects()) {
            DrawRow(go);
        }
        EditorGUILayout.EndScrollView();
    }
    
    void DrawRow(GameObject go) {
        EditorGUILayout.BeginHorizontal();
        EditorGUILayout.ObjectField(go, typeof(GameObject), true);      // 点击可定位 Hierarchy
        var mesh = go.GetComponent<MeshFilter>()?.sharedMesh;
        GUILayout.Label(mesh != null ? mesh.name : "(none)", GUILayout.Width(140));
        if (GUILayout.Button("选模型", GUILayout.Width(80))) OnSelectModel(go);
        EditorGUILayout.EndHorizontal();
    }
}
```

---

## 4. 边界情况

| 情况 | 处理 |
|------|------|
| 源模型有多个子 MeshRenderer（如带武器的角色） | v1 只取第一个并在 UI 标黄提示。v2 支持"整组替换子物体结构"。 |
| 源模型没有 MeshFilter（纯 Empty / 只带骨骼） | 导入后弹窗报错，不做替换。 |
| 目标 GameObject 没有 MeshFilter/MeshRenderer | 自动 AddComponent。 |
| 目标被多个场景引用（SubScene / Prefab 实例） | v1 仅支持当前激活场景的非 Prefab 实例。遇到 Prefab 实例的 GameObject → 弹窗提示用户"去 Prefab 里改"。 |
| 替换错了想回到之前 | 不支持撤销/恢复。用户需再次选正确模型替换；若要回到 Unity 内置 Cube 等原始资产，自行在 Inspector 里拖 mesh。 |
| 场景未保存直接关 Unity | MarkSceneDirty 触发，Unity 本身会弹"保存"对话框。 |
| 目标名称重复 | Hierarchy 里允许重名，UI 列表按 InstanceID 去重显示，每行展示完整路径（`Parent/Child/Target`）。 |

---

## 5. 目录结构

```
Assets/
└── Editor/
    └── ModelReplacementTool/
        ├── ModelReplacementWindow.cs     # EditorWindow UI
        ├── ModelReplacer.cs              # 核心替换逻辑（纯静态方法，可单元测试）
        ├── ModelImporter_Helpers.cs      # 导入管线
        ├── SceneScanner.cs               # 扫描 + 过滤
        ├── ModelReplacementTool.Editor.asmdef
        └── Tests/
            ├── ModelReplacerTests.cs     # EditMode 测试
            ├── SceneScannerTests.cs
            └── ModelReplacementTool.Tests.asmdef
```

**说明**：
- 所有代码纯 Editor，不进 Build
- 打包成 `.unitypackage` 后别的工程拖进去即可用
- 不再需要 `Runtime/` 目录（取消了标签组件后无场景序列化需求）

---

## 6. 实施分阶段（TDD-friendly）

| Stage | 交付 | 验收 |
|-------|------|------|
| **S0 项目骨架** | 目录结构 + asmdef + 空 EditorWindow（能打开） | Unity 菜单 `Tools/Model Replacement Tool` 打开空窗口 |
| **S1 扫描 + 列表渲染** | `SceneScanner` + `DrawRow` 单行 UI，展示 GameObject + 当前 Mesh 资产名，不带过滤 | 打开窗口能看到当前场景所有含 MeshFilter 的 GameObject，点击能在 Hierarchy 定位 |
| **S2 过滤器** | 名称前缀 过滤（Tag / Layer 可选） | 过滤器切换即时刷新列表 |
| **S3 导入 + 替换核心** | `ModelImporter_Helpers` + `ModelReplacer` + "选模型"按钮 | 选 FBX → Assets/Models/ 下多出文件，目标对象 Mesh 和 Material 被替换，Transform 不变 |
| **S4 批量 + 边界情况** | 多选批量、重复文件、无 MeshFilter、Prefab 实例等情况的 UI 处理 | 所有边界情况表有对应行为，不炸 |
| **S5 测试 + 打包** | EditMode 单元测试（不依赖场景的部分）+ 导出 .unitypackage | `UnityTest` 套件跑通；.unitypackage 拖进空工程能直接用 |

每个 Stage 独立可 demo、可回滚。

---

## 7. 非功能要求

- **Unity 版本**：基于 Unity 2021.3 LTS 测试（`/opt/luna-base-template` 工程使用版本），API 尽量 2020+ 兼容
- **依赖**：只用 UnityEditor + UnityEngine，不引入第三方包（保证工具轻量、易打 .unitypackage）
- **性能**：扫描 1000+ GameObject 的场景时 UI 不卡顿（用缓存 + `OnHierarchyChange` 触发刷新）
- **国际化**：v1 中文 UI；v2 按需加英文

---

## 8. 待你拍板

1. **扫描默认范围**：默认扫"所有含 MeshFilter 的对象"，还是默认只扫某个名称前缀（比如 `__Pool_`）？前者通用，后者更契合 blueprint 输出工程的心智。
2. **多子 MeshRenderer 模型的处理**：v1 只取第一个 + 标黄提示，还是直接禁止导入这类模型？
3. **是否打 .unitypackage 发布**：内部工具直接放 `Assets/Editor/` 就够，还是希望能打包给外部美术用？
4. **命名空间**：用 `BlueprintEditor.ModelTool`（沿用项目名）还是更通用的 `ModelReplacementTool`？（关系到未来是否独立 open source）

---

## 9. 参考

- Unity API: `UnityEditor.EditorWindow`, `UnityEditor.AssetDatabase`, `UnityEngine.SceneManagement.Scene`
- 推荐配套工具：Unity Package Manager（打 UPM 包可选）
