#if UNITY_EDITOR
using UnityEngine;
using UnityEditor;

/// <summary>
/// 基础样例工程 — 一键批量创建预制对象
/// 使用方式: Unity 菜单 → Tools → Create Base Template Objects
/// 创建后 Ctrl+S 保存场景，然后 SVN commit
/// </summary>
public class CreateBaseTemplateObjects : MonoBehaviour
{
    [MenuItem("Tools/Create Base Template Objects")]
    static void CreateAll()
    {
        // 清理旧的预制对象（如果重复运行）
        GameObject old = GameObject.Find("__BaseTemplate");
        if (old != null) DestroyImmediate(old);

        GameObject root = new GameObject("__BaseTemplate");
        root.transform.position = Vector3.zero;

        int count = 0;

        // ========== 环境 ==========
        // Ground
        count += CreateObj(root, "Ground", PrimitiveType.Plane, 
            new Vector3(0, 0, 0), new Vector3(10, 1, 10), C(0.35f, 0.3f, 0.15f));

        // ========== 通用 ==========
        count += CreateObj(root, "Player", PrimitiveType.Cube,
            V(-999), new Vector3(1, 2, 1), C(0.2f, 0.4f, 0.9f));

        count += CreateBatch(root, "Wall", 10, PrimitiveType.Cube,
            new Vector3(4, 1, 0.3f), C(0.3f, 0.3f, 0.3f));

        count += CreateBatch(root, "Coin", 15, PrimitiveType.Sphere,
            new Vector3(0.4f, 0.4f, 0.4f), C(1f, 0.85f, 0f));

        count += CreateBatch(root, "Gem", 10, PrimitiveType.Sphere,
            new Vector3(0.4f, 0.4f, 0.4f), C(0.6f, 0.2f, 0.8f));

        // ========== SLG / 塔防 ==========
        count += CreateBatch(root, "Building", 8, PrimitiveType.Cube,
            new Vector3(2, 2, 2), C(0.85f, 0.7f, 0.4f));

        count += CreateBatch(root, "Turret", 8, PrimitiveType.Cylinder,
            new Vector3(0.6f, 1, 0.6f), C(0.5f, 0.5f, 0.55f));

        count += CreateBatch(root, "Castle", 2, PrimitiveType.Cube,
            new Vector3(4, 4, 4), C(0.75f, 0.75f, 0.7f));

        count += CreateBatch(root, "Farm", 5, PrimitiveType.Cube,
            new Vector3(2, 0.5f, 2), C(0.5f, 0.75f, 0.3f));

        count += CreateBatch(root, "Mine", 5, PrimitiveType.Cube,
            new Vector3(1.5f, 1.5f, 1.5f), C(0.4f, 0.25f, 0.1f));

        count += CreateBatch(root, "Barracks", 3, PrimitiveType.Cube,
            new Vector3(2, 1.5f, 2), C(0.6f, 0.2f, 0.2f));

        count += CreateBatch(root, "Worker", 8, PrimitiveType.Cube,
            new Vector3(0.8f, 1.2f, 0.8f), C(0.9f, 0.6f, 0.2f));

        count += CreateBatch(root, "Soldier", 10, PrimitiveType.Cube,
            new Vector3(0.8f, 1.4f, 0.8f), C(0.3f, 0.45f, 0.2f));

        count += CreateBatch(root, "Archer", 8, PrimitiveType.Cylinder,
            new Vector3(0.5f, 1.2f, 0.5f), C(0.6f, 0.35f, 0.1f));

        count += CreateBatch(root, "Flag", 5, PrimitiveType.Cylinder,
            new Vector3(0.15f, 2, 0.15f), C(0.85f, 0.15f, 0.15f));

        count += CreateBatch(root, "Shield", 5, PrimitiveType.Sphere,
            new Vector3(1, 0.2f, 1), C(0.8f, 0.8f, 0.85f));

        // ========== 射击 / 战斗 ==========
        count += CreateBatch(root, "Enemy", 15, PrimitiveType.Sphere,
            new Vector3(1, 1, 1), C(0.85f, 0.15f, 0.15f));

        count += CreateBatch(root, "Boss", 3, PrimitiveType.Sphere,
            new Vector3(2, 2, 2), C(0.5f, 0.1f, 0.1f));

        count += CreateBatch(root, "Arrow", 15, PrimitiveType.Cube,
            new Vector3(0.1f, 0.1f, 1), C(0.9f, 0.9f, 0.9f));

        count += CreateBatch(root, "Bullet", 15, PrimitiveType.Sphere,
            new Vector3(0.2f, 0.2f, 0.2f), C(1f, 0.9f, 0.2f));

        count += CreateBatch(root, "Bomb", 8, PrimitiveType.Sphere,
            new Vector3(0.8f, 0.8f, 0.8f), C(0.15f, 0.15f, 0.15f));

        count += CreateBatch(root, "Sword", 5, PrimitiveType.Cube,
            new Vector3(0.1f, 1.5f, 0.15f), C(0.8f, 0.8f, 0.85f));

        // ========== 太空 ==========
        count += CreateBatch(root, "Spaceship", 5, PrimitiveType.Cube,
            new Vector3(1.5f, 0.5f, 2.5f), C(0.6f, 0.7f, 0.85f));

        count += CreateBatch(root, "Satellite", 5, PrimitiveType.Sphere,
            new Vector3(0.8f, 0.8f, 0.8f), C(0.8f, 0.8f, 0.8f));

        count += CreateBatch(root, "Asteroid", 10, PrimitiveType.Sphere,
            new Vector3(1.5f, 1.2f, 1.5f), C(0.4f, 0.35f, 0.3f));

        count += CreateBatch(root, "SpaceStation", 2, PrimitiveType.Cube,
            new Vector3(5, 3, 5), C(0.85f, 0.85f, 0.85f));

        count += CreateBatch(root, "Planet", 3, PrimitiveType.Sphere,
            new Vector3(4, 4, 4), C(0.2f, 0.5f, 0.7f));

        count += CreateBatch(root, "Rocket", 5, PrimitiveType.Cylinder,
            new Vector3(0.3f, 2, 0.3f), C(0.9f, 0.3f, 0.2f));

        // ========== 装饰 / 环境 ==========
        // Tree = 树干(Cylinder) + 树冠(Sphere) 组合
        for (int i = 1; i <= 15; i++)
        {
            GameObject tree = new GameObject("Tree_" + i);
            tree.transform.parent = root.transform;
            tree.transform.position = V(-999);

            GameObject trunk = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            trunk.name = "Trunk";
            trunk.transform.parent = tree.transform;
            trunk.transform.localPosition = new Vector3(0, 0.75f, 0);
            trunk.transform.localScale = new Vector3(0.3f, 0.75f, 0.3f);
            SetColor(trunk, C(0.4f, 0.25f, 0.1f));

            GameObject crown = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            crown.name = "Crown";
            crown.transform.parent = tree.transform;
            crown.transform.localPosition = new Vector3(0, 2, 0);
            crown.transform.localScale = new Vector3(1.5f, 1.5f, 1.5f);
            SetColor(crown, C(0.1f, 0.55f, 0.1f));

            count++;
        }

        count += CreateBatch(root, "Rock", 10, PrimitiveType.Sphere,
            new Vector3(1, 0.6f, 1), C(0.5f, 0.5f, 0.45f));

        count += CreateBatch(root, "Bush", 8, PrimitiveType.Sphere,
            new Vector3(0.8f, 0.5f, 0.8f), C(0.15f, 0.4f, 0.1f));

        count += CreateBatch(root, "Water", 3, PrimitiveType.Plane,
            new Vector3(5, 1, 5), C(0.3f, 0.6f, 0.9f));

        count += CreateBatch(root, "Road", 8, PrimitiveType.Cube,
            new Vector3(4, 0.1f, 1), C(0.65f, 0.65f, 0.6f));

        count += CreateBatch(root, "Bridge", 3, PrimitiveType.Cube,
            new Vector3(3, 0.2f, 1.5f), C(0.6f, 0.35f, 0.1f));

        // ========== 标记完成 ==========
        EditorUtility.SetDirty(root);
        Debug.Log("✅ Base Template Created: " + count + " objects. 请 Ctrl+S 保存场景！");
        EditorUtility.DisplayDialog("Base Template", 
            "已创建 " + count + " 个预制对象！\n\n请 Ctrl+S 保存场景，然后 SVN commit。", "OK");
    }

    // ========== 工具方法 ==========

    static Vector3 V(float y) { return new Vector3(0, y, 0); }
    static Color C(float r, float g, float b) { return new Color(r, g, b); }

    /// <summary>批量创建同类对象 Name_1 ~ Name_N</summary>
    static int CreateBatch(GameObject parent, string baseName, int count, 
        PrimitiveType type, Vector3 scale, Color color)
    {
        for (int i = 1; i <= count; i++)
        {
            CreateObj(parent, baseName + "_" + i, type, V(-999), scale, color);
        }
        return count;
    }

    /// <summary>创建单个对象</summary>
    static int CreateObj(GameObject parent, string name, PrimitiveType type, 
        Vector3 position, Vector3 scale, Color color)
    {
        GameObject obj = GameObject.CreatePrimitive(type);
        obj.name = name;
        obj.transform.parent = parent.transform;
        obj.transform.position = position;
        obj.transform.localScale = scale;
        SetColor(obj, color);
        return 1;
    }

    /// <summary>设置颜色（创建新材质实例）</summary>
    static void SetColor(GameObject obj, Color color)
    {
        Renderer r = obj.GetComponent<Renderer>();
        if (r != null)
        {
            // 用 URP/Lit shader 创建材质
            Material mat = new Material(Shader.Find("Universal Render Pipeline/Lit"));
            mat.SetColor("_BaseColor", color);
            r.sharedMaterial = mat;
        }
    }
}
#endif
