// ============================================================
// GFM_Pool.cs — 通用对象池 + 自动归还计时器
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;
using System.Collections.Generic;

public class GFM_Pool : MonoBehaviour
{
    public static GFM_Pool instance;

    private Dictionary<int, Queue<GameObject>> _pools = new Dictionary<int, Queue<GameObject>>();
    private Dictionary<int, GameObject> _prefabMap = new Dictionary<int, GameObject>();
    private Transform _poolRoot;

    public static GFM_Pool Init(GameObject parent)
    {
        if (instance != null) return instance;
        var obj = new GameObject("GFM_Pool");
        obj.transform.SetParent(parent.transform);
        instance = obj.AddComponent<GFM_Pool>();
        instance._poolRoot = obj.transform;
        return instance;
    }

    public void Preload(GameObject prefab, int count)
    {
        if (prefab == null) return;
        int id = prefab.GetInstanceID();
        if (!_pools.ContainsKey(id)) _pools[id] = new Queue<GameObject>();
        for (int i = 0; i < count; i++)
        {
            var obj = Instantiate(prefab, _poolRoot);
            obj.SetActive(false);
            _pools[id].Enqueue(obj);
            _prefabMap[obj.GetInstanceID()] = prefab;
        }
    }

    public static GameObject Get(GameObject prefab)
    {
        if (instance == null || prefab == null) return null;
        int id = prefab.GetInstanceID();
        if (instance._pools.ContainsKey(id) && instance._pools[id].Count > 0)
        {
            var obj = instance._pools[id].Dequeue();
            obj.SetActive(true);
            return obj;
        }
        var newObj = Instantiate(prefab);
        instance._prefabMap[newObj.GetInstanceID()] = prefab;
        return newObj;
    }

    public static void Return(GameObject obj)
    {
        if (instance == null || obj == null) return;
        obj.SetActive(false);
        obj.transform.SetParent(instance._poolRoot);
        int objId = obj.GetInstanceID();
        if (instance._prefabMap.ContainsKey(objId))
        {
            int prefabId = instance._prefabMap[objId].GetInstanceID();
            if (!instance._pools.ContainsKey(prefabId))
                instance._pools[prefabId] = new Queue<GameObject>();
            instance._pools[prefabId].Enqueue(obj);
        }
    }

    public static void ReturnAfter(GameObject obj, float delay)
    {
        if (instance == null || obj == null) return;
        var timer = obj.GetComponent<GFM_ReturnTimer>();
        if (timer == null) timer = obj.AddComponent<GFM_ReturnTimer>();
        timer.StartTimer(delay);
    }
}

public class GFM_ReturnTimer : MonoBehaviour
{
    private float _timer = -1f;
    public void StartTimer(float delay) { _timer = delay; }
    void Update()
    {
        if (_timer < 0) return;
        _timer -= Time.deltaTime;
        if (_timer <= 0)
        {
            _timer = -1f;
            GFM_Pool.Return(gameObject);
        }
    }
}
