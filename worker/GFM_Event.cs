// ============================================================
// GFM_Event.cs — 事件系统
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;
using System.Collections.Generic;

public class GFM_Event : MonoBehaviour
{
    public static GFM_Event instance;

    public delegate void GFM_EventHandler(object sender, string data);

    private Dictionary<int, List<GFM_EventHandler>> _subscribers = new Dictionary<int, List<GFM_EventHandler>>();

    private struct PendingEvent
    {
        public int id;
        public object sender;
        public string data;
    }
    private Queue<PendingEvent> _pending = new Queue<PendingEvent>();

    public static GFM_Event Init(GameObject parent)
    {
        if (instance != null) return instance;
        var obj = new GameObject("GFM_Event");
        obj.transform.SetParent(parent.transform);
        instance = obj.AddComponent<GFM_Event>();
        return instance;
    }

    void Update()
    {
        while (_pending.Count > 0)
        {
            var e = _pending.Dequeue();
            Dispatch(e.id, e.sender, e.data);
        }
    }

    public static void Subscribe(int eventId, GFM_EventHandler handler)
    {
        if (instance == null) return;
        if (!instance._subscribers.ContainsKey(eventId))
            instance._subscribers[eventId] = new List<GFM_EventHandler>();
        if (!instance._subscribers[eventId].Contains(handler))
            instance._subscribers[eventId].Add(handler);
    }

    public static void Unsubscribe(int eventId, GFM_EventHandler handler)
    {
        if (instance == null) return;
        if (instance._subscribers.ContainsKey(eventId))
            instance._subscribers[eventId].Remove(handler);
    }

    public static void Fire(int eventId, object sender, string data)
    {
        if (instance == null) return;
        instance._pending.Enqueue(new PendingEvent { id = eventId, sender = sender, data = data });
    }

    public static void FireNow(int eventId, object sender, string data)
    {
        if (instance == null) return;
        instance.Dispatch(eventId, sender, data);
    }

    private void Dispatch(int eventId, object sender, string data)
    {
        if (!_subscribers.ContainsKey(eventId)) return;
        var list = _subscribers[eventId];
        for (int i = 0; i < list.Count; i++)
        {
            if (list[i] != null) list[i](sender, data);
        }
    }

    public static void Clear()
    {
        if (instance != null) instance._subscribers.Clear();
    }
}
