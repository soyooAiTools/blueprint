// ============================================================
// GFM_Event.cs — legacy internal event helper
// 由 GFM_Tools.cs 拆分。生成的 GameFlowManagerMain 禁止调用事件系统，必须直接调用业务方法。
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

    // 初始化事件中心并清空历史监听。
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

    // 注册一个事件监听回调。
    public static void Subscribe(int eventId, GFM_EventHandler handler)
    {
        if (instance == null) return;
        if (!instance._subscribers.ContainsKey(eventId))
            instance._subscribers[eventId] = new List<GFM_EventHandler>();
        if (!instance._subscribers[eventId].Contains(handler))
            instance._subscribers[eventId].Add(handler);
    }

    // 移除一个事件监听回调。
    public static void Unsubscribe(int eventId, GFM_EventHandler handler)
    {
        if (instance == null) return;
        if (instance._subscribers.ContainsKey(eventId))
            instance._subscribers[eventId].Remove(handler);
    }

    // 派发事件并携带一个参数。
    public static void Fire(int eventId, object sender, string data)
    {
        if (instance == null) return;
        instance._pending.Enqueue(new PendingEvent { id = eventId, sender = sender, data = data });
    }

    // 立即派发无参数事件。
    public static void FireNow(int eventId, object sender, string data)
    {
        if (instance == null) return;
        instance.Dispatch(eventId, sender, data);
    }

    // 执行指定事件的所有监听回调。
    private void Dispatch(int eventId, object sender, string data)
    {
        if (!_subscribers.ContainsKey(eventId)) return;
        var list = _subscribers[eventId];
        for (int i = 0; i < list.Count; i++)
        {
            if (list[i] != null) list[i](sender, data);
        }
    }

    // 清空所有事件监听。
    public static void Clear()
    {
        if (instance != null) instance._subscribers.Clear();
    }
}
