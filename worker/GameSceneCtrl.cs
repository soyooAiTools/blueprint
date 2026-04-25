// GameSceneCtrl.cs — scene entity management singleton
// Centralizes Find/cache/show/hide to reduce skeleton boilerplate.
// Plain class (no MonoBehaviour) — Luna-safe, no AddComponent needed.
using UnityEngine;

public class GameSceneCtrl
{
    public static GameSceneCtrl instance;

    private string[] _names;
    private GameObject[] _objects;
    private int _count = 0;
    private const int MAX = 64;

    // 初始化场景实体控制器和实体缓存。
    public static GameSceneCtrl Init(GameObject parent)
    {
        if (instance != null) return instance;
        instance = new GameSceneCtrl();
        instance._names = new string[MAX];
        instance._objects = new GameObject[MAX];
        return instance;
    }

    // 注册实体名与场景物体的绑定关系。
    public void Register(string name, string poolName)
    {
        var go = GameObject.Find(poolName);
        for (int i = 0; i < _count; i++)
        {
            if (_names[i] == name)
            {
                _objects[i] = go;
                return;
            }
        }
        if (_count >= MAX) return;
        _names[_count] = name;
        _objects[_count] = go;
        _count++;
    }

    // 按实体名获取已注册的场景物体。
    public GameObject Get(string name)
    {
        for (int i = 0; i < _count; i++)
        {
            if (_names[i] == name) return _objects[i];
        }
        return null;
    }

    // 显示实体并放置到指定世界坐标。
    public void Show(string name, Vector3 pos)
    {
        var go = Get(name);
        if (go != null) go.transform.position = pos;
    }

    // 隐藏实体到镜头外。
    public void Hide(string name)
    {
        var go = Get(name);
        if (go != null) go.transform.position = new Vector3(0, -999, 0);
    }

    // 设置实体缩放。
    public void SetScale(string name, Vector3 scale)
    {
        var go = Get(name);
        if (go != null) go.transform.localScale = scale;
    }

    // 判断两个实体或实体与坐标是否足够接近。
    public bool IsNear(string a, string b, float range)
    {
        var ga = Get(a);
        var gb = Get(b);
        if (ga == null || gb == null) return false;
        return Vector3.Distance(ga.transform.position, gb.transform.position) < range;
    }

    // 判断两个实体或实体与坐标是否足够接近。
    public bool IsNear(string a, GameObject b, float range)
    {
        var ga = Get(a);
        if (ga == null || b == null) return false;
        return Vector3.Distance(ga.transform.position, b.transform.position) < range;
    }

    // 从已注册实体中查找离指定位置最近的一个。
    public string FindNearest(string origin, string[] candidates)
    {
        var go = Get(origin);
        if (go == null) return null;
        float minDist = float.MaxValue;
        string nearest = null;
        for (int i = 0; i < candidates.Length; i++)
        {
            var cand = Get(candidates[i]);
            if (cand == null) continue;
            // Hidden pooled objects are parked below the playable camera range.
            if (cand.transform.position.y < -900) continue;
            float d = Vector3.Distance(go.transform.position, cand.transform.position);
            if (d < minDist) { minDist = d; nearest = candidates[i]; }
        }
        return nearest;
    }
}
