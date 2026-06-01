// ============================================================
// GFM_Create.cs — 3D 物体快捷创建工具
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;

public static class GFM_Create
{
    private static Material _baseMat;

    private static int _cubeIdx = 0;
    private static int _sphereIdx = 0;
    private static int _planeIdx = 0;
    private static int _cylinderIdx = 0;
    private const int MAX_CUBES = 50;
    private const int MAX_SPHERES = 20;
    private const int MAX_PLANES = 10;
    private const int MAX_CYLINDERS = 10;

    // 设置对象创建工具复用的基础材质。
    public static void SetBaseMaterial(Material mat)
    {
        _baseMat = mat;
    }

    // 从场景物体读取可用材质，供后续对象复用。
    public static Material InitMaterialFromScene()
    {
        var matSource = GameObject.Find("__MaterialSource");
        if (matSource != null)
        {
            var r = (Renderer)matSource.GetComponent(typeof(Renderer));
            if (r != null) _baseMat = new Material(r.sharedMaterial);
        }
        if (_baseMat == null)
        {
            var anyRenderer = (Renderer)UnityEngine.Object.FindObjectOfType(typeof(Renderer));
            if (anyRenderer != null) _baseMat = new Material(anyRenderer.sharedMaterial);
        }
        if (_baseMat == null) _baseMat = new Material(Shader.Find("Standard"));
        if (_baseMat != null)
        {
            _baseMat.mainTexture = null;
            _baseMat.color = Color.white;
        }
        // 2026-05-05: 不再在 InitMaterialFromScene 里改 backgroundColor / 相机姿态。
        // backgroundColor 由 GameFlowManagerMain.Start() 唯一设置 (skeleton 预设),
        // 之前这里又写一次 (0.6, 0.8, 1) → 帧 1 这里写浅蓝, 帧 2 main 覆盖深灰 = 用户看到 2 次闪。
        // 相机姿态由 GFM_CameraController.Init() 接管。
        return _baseMat;
    }

    // 从对象池取出指定基础形状，并应用位置与缩放。
    private static GameObject PoolGet(PrimitiveType type, Vector3 pos, Vector3 scale)
    {
        string prefix; int idx; int max;
        switch (type)
        {
            case PrimitiveType.Sphere:
                prefix = "Sphere"; idx = ++_sphereIdx; max = MAX_SPHERES; break;
            case PrimitiveType.Plane:
                prefix = "Plane"; idx = ++_planeIdx; max = MAX_PLANES; break;
            case PrimitiveType.Cylinder:
                prefix = "Cylinder"; idx = ++_cylinderIdx; max = MAX_CYLINDERS; break;
            default:
                prefix = "Cube"; idx = ++_cubeIdx; max = MAX_CUBES; break;
        }
        if (idx > max) idx = max;
        string name = "__Pool_" + prefix + "_" + idx.ToString("D2");
        var obj = GameObject.Find(name);
        if (obj == null)
        {
            obj = GameObject.CreatePrimitive(type);
        }
        obj.transform.position = pos;
        obj.transform.localScale = scale;
        if (_baseMat != null)
        {
            var r = (Renderer)obj.GetComponent(typeof(Renderer));
            if (r != null) r.material = new Material(_baseMat);
        }
        return obj;
    }

    // 回收并隐藏当前由创建工具生成的对象。
    public static void ResetPool()
    {
        _cubeIdx = 0; _sphereIdx = 0; _planeIdx = 0; _cylinderIdx = 0;
        for (int i = 1; i <= MAX_CUBES; i++) { var o = GameObject.Find("__Pool_Cube_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
        for (int i = 1; i <= MAX_SPHERES; i++) { var o = GameObject.Find("__Pool_Sphere_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
        for (int i = 1; i <= MAX_PLANES; i++) { var o = GameObject.Find("__Pool_Plane_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
        for (int i = 1; i <= MAX_CYLINDERS; i++) { var o = GameObject.Find("__Pool_Cylinder_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
    }

    // 创建或复用一个基础形状对象，并设置标签名。
    public static GameObject Obj(PrimitiveType type, Vector3 pos, Vector3 scale, string label)
    {
        var obj = PoolGet(type, pos, scale);
        if (obj != null)
        {
            var defaultColor = type == PrimitiveType.Cube ? new Color(0.7f, 0.5f, 0.25f) :
                               type == PrimitiveType.Sphere ? new Color(0.2f, 0.6f, 0.2f) :
                               type == PrimitiveType.Cylinder ? new Color(0.5f, 0.5f, 0.55f) :
                               type == PrimitiveType.Plane ? new Color(0.35f, 0.25f, 0.15f) :
                               new Color(0.6f, 0.6f, 0.6f);
            var renderer = (Renderer)obj.GetComponent(typeof(Renderer));
            if (renderer != null && _baseMat != null)
            {
                var mat = new Material(_baseMat);
                mat.color = defaultColor;
                renderer.material = mat;
            }
        }
        if (!string.IsNullOrEmpty(label))
        {
            obj.name = label;
            GFM_UI.AddWorldLabel(obj, label, scale.y * 0.5f + 0.5f);
        }
        return obj;
    }

    // 创建或复用地面平面。
    public static GameObject Ground(float width, float depth)
    {
        var obj = PoolGet(PrimitiveType.Plane, Vector3.zero, new Vector3(width / 10f, 1, depth / 10f));
        obj.name = "Ground";
        if (_baseMat != null)
        {
            var r = (Renderer)obj.GetComponent(typeof(Renderer));
            if (r != null)
            {
                var mat = new Material(_baseMat);
                mat.color = new Color(0.35f, 0.25f, 0.15f);
                r.material = mat;
            }
        }
        return obj;
    }

    // 设置物体材质颜色；Luna 导出时应谨慎使用。
    public static void SetColor(GameObject obj, Color color)
    {
        if (obj == null) return;
        var r = (Renderer)obj.GetComponent(typeof(Renderer));
        if (r != null)
        {
            if (r.material != null) r.material.color = color;
            else if (_baseMat != null) { r.material = new Material(_baseMat); r.material.color = color; }
        }
    }

    // ============================================================
    // Source-faithful composite mesh builders (Option C, Wave 3 Step 3).
    // Emitted by adapters/skeleton-generator.cjs BuildSourceFaithfulMeshes() when
    // OPTION_C_SOURCE_FAITHFUL_BUILD is on and ctx.blueprint.sourceMeshOps is present.
    // Called at Start()/scene-init (NOT in the hot Update path), so new Vector3 /
    // new GameObject allocations are acceptable here (see incident doc R4).
    // ============================================================

    // Add one composite primitive part under `root`, with local transform + material
    // (diffuse / emissive / metallic / smoothness / opacity). Returns the part.
    public static GameObject AddCompositePart(GameObject root, PrimitiveType type,
        Vector3 localPos, Vector3 localEuler, Vector3 scale,
        Color color, Color emissive, float emissiveIntensity,
        float metalness, float roughness, float opacity)
    {
        var part = GameObject.CreatePrimitive(type);
        // Visual-only: drop the auto-added collider so composites don't disturb physics.
        var col = (Collider)part.GetComponent(typeof(Collider));
        if (col != null) UnityEngine.Object.Destroy(col);
        if (root != null) part.transform.parent = root.transform;
        part.transform.localPosition = localPos;
        part.transform.localEulerAngles = localEuler;
        part.transform.localScale = scale;

        var r = (Renderer)part.GetComponent(typeof(Renderer));
        if (r != null)
        {
            Material mat = _baseMat != null ? new Material(_baseMat) : new Material(Shader.Find("Standard"));
            Color c = color; c.a = opacity;
            // Luna renders with URP/Lit, whose base color is _BaseColor — NOT Material.color
            // (_Color), which URP ignores, leaving composites white. Set _BaseColor (URP) plus
            // _Color/.color as a legacy fallback. (Confirmed against the build's own override
            // path which setParameter('_BaseColor','_Color'); diagnosed via headless render
            // probe 2026-06-01: URP/Lit "doesn't support '_ALPHABLEND_ON'" + white meshes.)
            mat.color = c;
            mat.SetColor("_BaseColor", c);
            mat.SetColor("_Color", c);
            if (emissiveIntensity > 0f)
            {
                mat.EnableKeyword("_EMISSION");
                mat.SetColor("_EmissionColor", new Color(emissive.r * emissiveIntensity, emissive.g * emissiveIntensity, emissive.b * emissiveIntensity, 1f));
            }
            mat.SetFloat("_Metallic", metalness);
            mat.SetFloat("_Smoothness", 1f - roughness);  // URP/Lit smoothness
            mat.SetFloat("_Glossiness", 1f - roughness);  // legacy fallback
            // Do NOT set Standard-shader transparency keywords (_Mode/_SrcBlend/_ALPHABLEND_ON):
            // URP/Lit rejects them and spams "doesn't support '_ALPHABLEND_ON'" errors. Alpha
            // rides in _BaseColor; full URP transparency (_Surface=1 + _SURFACE_TYPE_TRANSPARENT)
            // is deferred — opaque rendering is acceptable for v0.1 (incident doc R7).
            r.material = mat;
        }
        return part;
    }

    // Approximate a torus as a ring of `segments` small cubes (Luna has no Torus
    // primitive; see incident doc R5). Parts hang under a sub-anchor so the ring's
    // center/orientation is a single local transform on `root`.
    public static GameObject AddTorusRing(GameObject root, Vector3 center, Vector3 euler,
        float radius, float tube, int segments, Color color, float metalness)
    {
        if (segments < 3) segments = 3;
        var anchor = new GameObject("__TorusRing");
        if (root != null) anchor.transform.parent = root.transform;
        anchor.transform.localPosition = center;
        anchor.transform.localEulerAngles = euler;
        float step = 360f / (float)segments;
        for (int i = 0; i < segments; i++)
        {
            float a = step * (float)i * Mathf.Deg2Rad;
            Vector3 p = new Vector3(Mathf.Cos(a) * radius, 0f, Mathf.Sin(a) * radius);
            var seg = AddCompositePart(anchor, PrimitiveType.Cube, p,
                new Vector3(0f, -step * (float)i, 0f),
                new Vector3(tube * 2f, tube * 2f, tube * 2f),
                color, Color.black, 0f, metalness, 0.4f, 1f);
            seg.name = "__TorusSeg_" + i.ToString();
        }
        return anchor;
    }
}
