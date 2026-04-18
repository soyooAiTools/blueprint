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

    public static void SetBaseMaterial(Material mat)
    {
        _baseMat = mat;
    }

    public static Material InitMaterialFromScene()
    {
        var matSource = GameObject.Find("__MaterialSource");
        if (matSource != null)
        {
            var r = matSource.GetComponent<Renderer>();
            if (r != null) _baseMat = new Material(r.sharedMaterial);
        }
        if (_baseMat == null)
        {
            var anyRenderer = UnityEngine.Object.FindObjectOfType<Renderer>();
            if (anyRenderer != null) _baseMat = new Material(anyRenderer.sharedMaterial);
        }
        if (_baseMat == null) _baseMat = new Material(Shader.Find("Standard"));
        if (_baseMat != null)
        {
            _baseMat.mainTexture = null;
            _baseMat.color = Color.white;
        }
        var cam = Camera.main;
        if (cam != null)
        {
            cam.backgroundColor = new Color(0.6f, 0.8f, 1f);
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.orthographic = true;
            cam.orthographicSize = 8f;
            cam.transform.rotation = Quaternion.Euler(45f, 0f, 0f);
            cam.transform.position = new Vector3(0f, 15f, -15f);
        }
        return _baseMat;
    }

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
            var r = obj.GetComponent<Renderer>();
            if (r != null) r.material = new Material(_baseMat);
        }
        return obj;
    }

    public static void ResetPool()
    {
        _cubeIdx = 0; _sphereIdx = 0; _planeIdx = 0; _cylinderIdx = 0;
        for (int i = 1; i <= MAX_CUBES; i++) { var o = GameObject.Find("__Pool_Cube_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
        for (int i = 1; i <= MAX_SPHERES; i++) { var o = GameObject.Find("__Pool_Sphere_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
        for (int i = 1; i <= MAX_PLANES; i++) { var o = GameObject.Find("__Pool_Plane_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
        for (int i = 1; i <= MAX_CYLINDERS; i++) { var o = GameObject.Find("__Pool_Cylinder_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
    }

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
            var renderer = obj.GetComponent<Renderer>();
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

    public static GameObject Ground(float width, float depth)
    {
        var obj = PoolGet(PrimitiveType.Plane, Vector3.zero, new Vector3(width / 10f, 1, depth / 10f));
        obj.name = "Ground";
        if (_baseMat != null)
        {
            var r = obj.GetComponent<Renderer>();
            if (r != null)
            {
                var mat = new Material(_baseMat);
                mat.color = new Color(0.35f, 0.25f, 0.15f);
                r.material = mat;
            }
        }
        return obj;
    }

    public static void SetColor(GameObject obj, Color color)
    {
        if (obj == null) return;
        var r = obj.GetComponent<Renderer>();
        if (r != null)
        {
            if (r.material != null) r.material.color = color;
            else if (_baseMat != null) { r.material = new Material(_baseMat); r.material.color = color; }
        }
    }
}
