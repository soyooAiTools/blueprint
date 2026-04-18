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

    public static GameSceneCtrl Init(GameObject parent)
    {
        if (instance != null) return instance;
        instance = new GameSceneCtrl();
        instance._names = new string[MAX];
        instance._objects = new GameObject[MAX];
        return instance;
    }

    public void Register(string name, string poolName)
    {
        if (_count >= MAX) return;
        var go = GameObject.Find(poolName);
        _names[_count] = name;
        _objects[_count] = go;
        _count++;
    }

    public GameObject Get(string name)
    {
        for (int i = 0; i < _count; i++)
        {
            if (_names[i] == name) return _objects[i];
        }
        return null;
    }

    public void Show(string name, Vector3 pos)
    {
        var go = Get(name);
        if (go != null) go.transform.position = pos;
    }

    public void Hide(string name)
    {
        var go = Get(name);
        if (go != null) go.transform.position = new Vector3(0, -999, 0);
    }

    public void SetScale(string name, Vector3 scale)
    {
        var go = Get(name);
        if (go != null) go.transform.localScale = scale;
    }

    public bool IsNear(string a, string b, float range)
    {
        var ga = Get(a);
        var gb = Get(b);
        if (ga == null || gb == null) return false;
        return Vector3.Distance(ga.transform.position, gb.transform.position) < range;
    }

    public bool IsNear(string a, GameObject b, float range)
    {
        var ga = Get(a);
        if (ga == null || b == null) return false;
        return Vector3.Distance(ga.transform.position, b.transform.position) < range;
    }

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
            if (cand.transform.position.y < -900) continue;
            float d = Vector3.Distance(go.transform.position, cand.transform.position);
            if (d < minDist) { minDist = d; nearest = candidates[i]; }
        }
        return nearest;
    }
}
