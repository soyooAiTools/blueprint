// ============================================================
// GFM_Tools.cs — 试玩广告工具类库 (Soyoo Playable Ad Toolkit)
// 放在 SVN 模板 Assets/Program/Script/GFM_Tools.cs
// AI 编码时直接调用，不要重定义这些类
// ============================================================
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;
using System;
using System.Collections;
using System.Collections.Generic;

// ============================================================
// GFM_Audio — 音频管理器
// ============================================================
// 用法：
//   var audio = GFM_Audio.Init(gameObject);  // 在 Start() 里初始化
//   audio.PlayBGM(clip);
//   audio.PlaySFX(clip);
//   audio.SetMute(true/false);
// ============================================================
public class GFM_Audio : MonoBehaviour
{
    public static GFM_Audio instance;

    private AudioSource _bgmSource;
    private AudioSource _sfxSource;
    private bool _muted = false;

    public static GFM_Audio Init(GameObject parent)
    {
        if (instance != null) return instance;
        var obj = new GameObject("GFM_Audio");
        obj.transform.SetParent(parent.transform);
        instance = obj.AddComponent<GFM_Audio>();

        instance._bgmSource = obj.AddComponent<AudioSource>();
        instance._bgmSource.loop = true;
        instance._bgmSource.playOnAwake = false;

        instance._sfxSource = obj.AddComponent<AudioSource>();
        instance._sfxSource.loop = false;
        instance._sfxSource.playOnAwake = false;

        // Luna 静音/取消静音回调
        // Luna.Unity.LifeCycle.OnMute += () => { AudioListener.volume = 0; };
        // Luna.Unity.LifeCycle.OnUnmute += () => { AudioListener.volume = 1; };

        return instance;
    }

    public void PlayBGM(AudioClip clip)
    {
        if (clip == null || _bgmSource == null) return;
        _bgmSource.clip = clip;
        if (!_muted) _bgmSource.Play();
    }

    public void StopBGM()
    {
        if (_bgmSource != null) _bgmSource.Stop();
    }

    public void PlaySFX(AudioClip clip)
    {
        if (clip == null || _sfxSource == null || _muted) return;
        _sfxSource.PlayOneShot(clip);
    }

    /// <summary>
    /// 音阶播放（原 AudioManager.PlayPitch）
    /// </summary>
    public void PlayPitch(AudioClip clip, int index)
    {
        if (clip == null || _sfxSource == null || _muted) return;
        float[] offset = new float[] { 2f, 2f, 1f, 2f, 2f, 2f, 1f, 2f, 2f, 1f };
        if (index >= offset.Length) index = index % offset.Length;
        float add = 0;
        for (int i = 0; i < index; i++) add += offset[i];
        _sfxSource.pitch = Mathf.Pow(2f, add / 12f);
        _sfxSource.clip = clip;
        _sfxSource.Play();
    }

    public void SetMute(bool mute)
    {
        _muted = mute;
        AudioListener.volume = mute ? 0f : 1f;
    }
}

// ============================================================
// GFM_Pool — 通用对象池
// ============================================================
// 用法：
//   GFM_Pool.Init(gameObject);  // 在 Start() 里初始化
//   GFM_Pool.Preload(prefab, 10);  // 预创建 10 个
//   var obj = GFM_Pool.Get(prefab);  // 获取
//   GFM_Pool.Return(obj);  // 归还
//   GFM_Pool.ReturnAfter(obj, 2f);  // 2 秒后自动归还
// ============================================================
public class GFM_Pool : MonoBehaviour
{
    public static GFM_Pool instance;

    // 按 prefab instanceId 分组的对象池
    private Dictionary<int, Queue<GameObject>> _pools = new Dictionary<int, Queue<GameObject>>();
    private Dictionary<int, GameObject> _prefabMap = new Dictionary<int, GameObject>(); // objId → prefab
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

    /// <summary>预创建对象</summary>
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

    /// <summary>从池中获取对象</summary>
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
        // 池空了就新建
        var newObj = Instantiate(prefab);
        instance._prefabMap[newObj.GetInstanceID()] = prefab;
        return newObj;
    }

    /// <summary>归还到池中</summary>
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

    /// <summary>延迟归还</summary>
    public static void ReturnAfter(GameObject obj, float delay)
    {
        if (instance == null || obj == null) return;
        var timer = obj.GetComponent<GFM_ReturnTimer>();
        if (timer == null) timer = obj.AddComponent<GFM_ReturnTimer>();
        timer.StartTimer(delay);
    }
}

/// <summary>自动归还计时器（内部使用）</summary>
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

// ============================================================
// GFM_Event — 事件系统
// ============================================================
// 用法：
//   GFM_Event.Init(gameObject);  // 在 Start() 里初始化
//   GFM_Event.Subscribe(1001, OnEnemyDied);  // 订阅事件
//   GFM_Event.Fire(1001, this, "enemy1");    // 触发事件（下一帧执行）
//   GFM_Event.FireNow(1001, this, "enemy1"); // 立即触发
//   GFM_Event.Unsubscribe(1001, OnEnemyDied);
//
//   void OnEnemyDied(object sender, string data) { ... }
// ============================================================
public class GFM_Event : MonoBehaviour
{
    public static GFM_Event instance;

    // 事件处理器签名：void Handler(object sender, string data)
    public delegate void GFM_EventHandler(object sender, string data);

    private Dictionary<int, List<GFM_EventHandler>> _subscribers = new Dictionary<int, List<GFM_EventHandler>>();

    // 延迟触发队列
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

    /// <summary>下一帧触发（线程安全）</summary>
    public static void Fire(int eventId, object sender, string data)
    {
        if (instance == null) return;
        instance._pending.Enqueue(new PendingEvent { id = eventId, sender = sender, data = data });
    }

    /// <summary>立即触发</summary>
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

    /// <summary>清除所有订阅</summary>
    public static void Clear()
    {
        if (instance != null) instance._subscribers.Clear();
    }
}

// ============================================================
// GFM_Utils — 通用工具方法
// ============================================================
// 用法：
//   GFM_Utils.IsInRange(2f, posA, posB)
//   GFM_Utils.IsOnScreen(obj.transform)
//   GFM_Utils.IsPlayingAnim(animator, "Run")
//   GFM_Utils.WorldToUI(worldPos, canvasRect)
//   GFM_Utils.FindClosestByTag(origin, "Enemy", 50f)
// ============================================================
public static class GFM_Utils
{
    /// <summary>两点距离是否小于设定值（可忽略 Y 轴）</summary>
    public static bool IsInRange(float distance, Vector3 a, Vector3 b, bool includeY)
    {
        Vector3 va = new Vector3(a.x, includeY ? a.y : 0, a.z);
        Vector3 vb = new Vector3(b.x, includeY ? b.y : 0, b.z);
        return Vector3.Distance(va, vb) < distance;
    }

    /// <summary>物体是否在屏幕内</summary>
    public static bool IsOnScreen(Transform obj)
    {
        if (obj == null || Camera.main == null) return false;
        Vector3 sp = Camera.main.WorldToScreenPoint(obj.position);
        return sp.x >= 0 && sp.x <= Screen.width && sp.y >= 0 && sp.y <= Screen.height && sp.z > 0;
    }

    /// <summary>检查 Animator 是否正在播放指定动画</summary>
    public static bool IsPlayingAnim(Animator animator, string name)
    {
        if (animator == null) return false;
        return animator.GetCurrentAnimatorStateInfo(0).IsName(name);
    }

    /// <summary>两个 UI 矩形是否重叠</summary>
    public static bool RectsOverlap(Vector2 min1, Vector2 max1, Vector2 min2, Vector2 max2)
    {
        return !(min1.x > max2.x || max1.x < min2.x || min1.y > max2.y || max1.y < min2.y);
    }

    /// <summary>世界坐标转 UI anchoredPosition（Canvas 需全屏）</summary>
    public static Vector2 WorldToUI(Vector3 worldPos, RectTransform canvasRect)
    {
        if (Camera.main == null) return Vector2.zero;
        Vector3 sp = Camera.main.WorldToScreenPoint(worldPos);
        Vector3 norm = new Vector3(sp.x / Screen.width, sp.y / Screen.height, sp.z);
        return new Vector2(
            norm.x * canvasRect.sizeDelta.x - canvasRect.sizeDelta.x * 0.5f,
            norm.y * canvasRect.sizeDelta.y - canvasRect.sizeDelta.y * 0.5f
        );
    }

    /// <summary>屏幕边缘方向指示器</summary>
    public static void UpdateOffScreenIndicator(Transform target, RectTransform indicator, Camera cam)
    {
        if (target == null || indicator == null || cam == null) return;
        Vector3 sp = cam.WorldToScreenPoint(target.position);
        bool offScreen = sp.x < 0 || sp.x > Screen.width || sp.y < 0 || sp.y > Screen.height || sp.z < 0;
        if (offScreen)
        {
            indicator.gameObject.SetActive(true);
            Vector3 clamped = sp;
            clamped.x = Mathf.Clamp(sp.x, 0, Screen.width);
            clamped.y = Mathf.Clamp(sp.y, 0, Screen.height);
            Vector3 dir = clamped - new Vector3(Screen.width / 2, Screen.height / 2);
            indicator.position = clamped;
            indicator.rotation = Quaternion.Euler(0, 0, Mathf.Atan2(dir.y, dir.x) * Mathf.Rad2Deg);
        }
        else
        {
            indicator.gameObject.SetActive(false);
        }
    }

    /// <summary>根据 Tag 找最近物体</summary>
    public static GameObject FindClosestByTag(Vector3 origin, string tag, float maxDist)
    {
        GameObject[] objs = GameObject.FindGameObjectsWithTag(tag);
        GameObject closest = null;
        float minDist = maxDist * maxDist;
        for (int i = 0; i < objs.Length; i++)
        {
            if (objs[i] == null || !objs[i].activeInHierarchy) continue;
            float d = (objs[i].transform.position - origin).sqrMagnitude;
            if (d < minDist) { minDist = d; closest = objs[i]; }
        }
        return closest;
    }

    /// <summary>在列表中找最近物体</summary>
    public static Transform FindClosestInList(List<Transform> targets, Vector3 origin)
    {
        if (targets == null) return null;
        Transform closest = null;
        float minDist = Mathf.Infinity;
        for (int i = 0; i < targets.Count; i++)
        {
            if (targets[i] == null || !targets[i].gameObject.activeInHierarchy) continue;
            float d = (targets[i].position - origin).sqrMagnitude;
            if (d < minDist) { minDist = d; closest = targets[i]; }
        }
        return closest;
    }

    /// <summary>生成圆环点位信息（原 BasicExtensions.GenerateCircles）</summary>
    public static List<Vector3> GenerateCirclePositions(int rings, int pointsPerRing, float radiusStep, int pointIncrement)
    {
        List<Vector3> points = new List<Vector3>();
        int pts = pointsPerRing;
        for (int i = 0; i < rings; i++)
        {
            float radius = (i + 1) * radiusStep;
            for (int j = 0; j < pts; j++)
            {
                float angle = 2 * Mathf.PI / pts * j;
                points.Add(new Vector3(radius * Mathf.Cos(angle), 0, radius * Mathf.Sin(angle)));
            }
            pts += pointIncrement;
        }
        return points;
    }

    /// <summary>数字精灵显示（原 BasicExtensions.SetUIOrSpriteRenererNum）</summary>
    public static void SetNumberDisplay(Transform parent, List<Sprite> numSprites, int number)
    {
        if (parent == null || numSprites == null) return;
        char[] chars = number.ToString().ToCharArray();
        for (int i = 0; i < parent.childCount; i++)
            parent.GetChild(i).gameObject.SetActive(false);
        for (int i = 0; i < chars.Length && i < parent.childCount; i++)
        {
            int digit = int.Parse(chars[i].ToString());
            if (digit >= numSprites.Count) continue;
            var child = parent.GetChild(i);
            child.gameObject.SetActive(true);
            var img = child.GetComponent<Image>();
            if (img != null)
            {
                img.sprite = numSprites[digit];
                img.rectTransform.sizeDelta = new Vector2(img.sprite.rect.width, img.sprite.rect.height);
            }
            else
            {
                var sr = child.GetComponent<SpriteRenderer>();
                if (sr != null) sr.sprite = numSprites[digit];
            }
        }
    }
}

// ============================================================
// GFM_Joystick — 虚拟摇杆
// ============================================================
// 用法：
//   var joystick = GFM_Joystick.Create(canvas, 200f);
//   // 在 Update 里读取：
//   Vector2 dir = joystick.Direction;      // 归一化方向
//   float h = joystick.Horizontal;         // -1 ~ 1
//   float v = joystick.Vertical;           // -1 ~ 1
//   bool moving = joystick.IsDragging;     // 是否在拖拽
// ============================================================
public class GFM_Joystick : MonoBehaviour, IPointerDownHandler, IDragHandler, IPointerUpHandler
{
    public static GFM_Joystick instance;

    public float Horizontal { get { return _input.x; } }
    public float Vertical { get { return _input.y; } }
    public Vector2 Direction { get { return _input; } }
    public bool IsDragging { get { return _dragging; } }

    private RectTransform _bg;
    private RectTransform _handle;
    private Vector2 _input = Vector2.zero;
    private bool _dragging = false;
    private float _radius;
    private Vector2 _bgStartPos;

    /// <summary>创建虚拟摇杆</summary>
    /// <param name="canvas">父 Canvas</param>
    /// <param name="size">背景大小</param>
    /// <param name="leftHalf">是否只在屏幕左半边激活</param>
    public static GFM_Joystick Create(Canvas canvas, float size)
    {
        if (instance != null) return instance;

        // 背景
        var bgObj = new GameObject("JoystickBG", typeof(RectTransform), typeof(Image));
        bgObj.transform.SetParent(canvas.transform, false);
        var bgRect = bgObj.GetComponent<RectTransform>();
        bgRect.sizeDelta = new Vector2(size, size);
        bgRect.anchorMin = new Vector2(0, 0);
        bgRect.anchorMax = new Vector2(0, 0);
        bgRect.pivot = new Vector2(0.5f, 0.5f);
        bgRect.anchoredPosition = new Vector2(size * 0.8f, size * 0.8f);
        var bgImg = bgObj.GetComponent<Image>();
        bgImg.color = new Color(1f, 1f, 1f, 0.3f);

        // 摇杆
        var handleObj = new GameObject("JoystickHandle", typeof(RectTransform), typeof(Image));
        handleObj.transform.SetParent(bgObj.transform, false);
        var handleRect = handleObj.GetComponent<RectTransform>();
        handleRect.sizeDelta = new Vector2(size * 0.4f, size * 0.4f);
        handleRect.anchoredPosition = Vector2.zero;
        var handleImg = handleObj.GetComponent<Image>();
        handleImg.color = new Color(1f, 1f, 1f, 0.6f);

        instance = bgObj.AddComponent<GFM_Joystick>();
        instance._bg = bgRect;
        instance._handle = handleRect;
        instance._radius = size * 0.5f;
        instance._bgStartPos = bgRect.anchoredPosition;

        return instance;
    }

    public void OnPointerDown(PointerEventData eventData)
    {
        _dragging = true;
        OnDrag(eventData);
    }

    public void OnDrag(PointerEventData eventData)
    {
        Vector2 localPos;
        if (RectTransformUtility.ScreenPointToLocalPointInRectangle(_bg, eventData.position, eventData.pressEventCamera, out localPos))
        {
            if (localPos.magnitude > _radius)
                localPos = localPos.normalized * _radius;
            _handle.anchoredPosition = localPos;
            _input = localPos / _radius;
        }
    }

    public void OnPointerUp(PointerEventData eventData)
    {
        _dragging = false;
        _handle.anchoredPosition = Vector2.zero;
        _input = Vector2.zero;
    }
}

// ============================================================
// GFM_Luna — Luna 生命周期管理
// ============================================================
// 用法：
//   GFM_Luna.Init(gameObject);
//   // 游戏结束时：
//   GFM_Luna.GameOver();
//   // 跳转商店：
//   GFM_Luna.GotoStore();
// ============================================================
public class GFM_Luna : MonoBehaviour
{
    public static GFM_Luna instance;
    private bool _isFirst = true;
    private bool _isGameOver = false;

    public static GFM_Luna Init(GameObject parent)
    {
        if (instance != null) return instance;
        var obj = new GameObject("GFM_Luna");
        obj.transform.SetParent(parent.transform);
        instance = obj.AddComponent<GFM_Luna>();

        // 默认静音，等待首次触摸
        AudioListener.volume = 0;
        return instance;
    }

    void Update()
    {
        if (Input.GetMouseButtonDown(0) && _isFirst)
        {
            AudioListener.volume = 1;
            _isFirst = false;
        }
    }

    public static void GameOver()
    {
        if (instance != null) instance._isGameOver = true;
        Luna.Unity.LifeCycle.GameEnded();
    }

    public static void GotoStore()
    {
        Luna.Unity.Playable.InstallFullGame();
    }

    public static bool IsGameOver()
    {
        return instance != null && instance._isGameOver;
    }
}

// ============================================================
// GFM_UI — UI 创建工具
// ============================================================
// 用法：
//   var canvas = GFM_UI.CreateCanvas(1080, 1920);
//   var btn = GFM_UI.CreateButton(canvas, "Play", new Vector2(0, -200), new Vector2(300, 80), onClick);
//   var label = GFM_UI.CreateText(canvas, "Score: 0", new Vector2(0, 400), 32);
//   GFM_UI.AddWorldLabel(targetObj, "Enemy", 1.5f);
// ============================================================
public static class GFM_UI
{
    /// <summary>创建全屏 Canvas</summary>
    public static Canvas CreateCanvas(int refWidth, int refHeight)
    {
        var obj = new GameObject("Canvas");
        var canvas = obj.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        var scaler = obj.AddComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(refWidth, refHeight);
        obj.AddComponent<GraphicRaycaster>();
        return canvas;
    }

    /// <summary>创建按钮</summary>
    public static Button CreateButton(Canvas canvas, string text, Vector2 pos, Vector2 size, UnityEngine.Events.UnityAction onClick)
    {
        var obj = new GameObject("Btn_" + text, typeof(RectTransform), typeof(Image), typeof(Button));
        obj.transform.SetParent(canvas.transform, false);
        var rect = obj.GetComponent<RectTransform>();
        rect.anchoredPosition = pos;
        rect.sizeDelta = size;
        obj.GetComponent<Image>().color = new Color(0.2f, 0.7f, 0.3f);
        var btn = obj.GetComponent<Button>();
        if (onClick != null) btn.onClick.AddListener(onClick);

        var txtObj = new GameObject("Text").AddComponent<Text>();
        txtObj.transform.SetParent(obj.transform, false);
        txtObj.GetComponent<RectTransform>().sizeDelta = size;
        txtObj.text = text;
        txtObj.font = (Font)Resources.GetBuiltinResource(typeof(Font), "Arial.ttf");
        txtObj.fontSize = (int)(size.y * 0.4f);
        txtObj.color = Color.white;
        txtObj.alignment = TextAnchor.MiddleCenter;

        return btn;
    }

    /// <summary>创建文字标签</summary>
    public static Text CreateText(Canvas canvas, string content, Vector2 pos, int fontSize)
    {
        var obj = new GameObject("Text_" + content, typeof(RectTransform));
        obj.transform.SetParent(canvas.transform, false);
        var rect = obj.GetComponent<RectTransform>();
        rect.anchoredPosition = pos;
        rect.sizeDelta = new Vector2(400, fontSize * 2);
        var txt = obj.AddComponent<Text>();
        txt.text = content;
        txt.font = (Font)Resources.GetBuiltinResource(typeof(Font), "Arial.ttf");
        txt.fontSize = fontSize;
        txt.color = Color.white;
        txt.alignment = TextAnchor.MiddleCenter;
        return txt;
    }

    /// <summary>在 3D 物体上方添加世界空间文字标签</summary>
    public static void AddWorldLabel(GameObject target, string text, float heightOffset)
    {
        var labelObj = new GameObject("Label_" + text);
        var canvas = labelObj.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.WorldSpace;
        canvas.transform.SetParent(target.transform, false);
        canvas.transform.localPosition = new Vector3(0, heightOffset, 0);
        canvas.transform.localScale = new Vector3(0.02f, 0.02f, 0.02f);
        canvas.GetComponent<RectTransform>().sizeDelta = new Vector2(200, 50);

        var txtObj = new GameObject("Text").AddComponent<Text>();
        txtObj.transform.SetParent(canvas.transform, false);
        txtObj.GetComponent<RectTransform>().sizeDelta = new Vector2(200, 50);
        txtObj.text = text;
        txtObj.font = (Font)Resources.GetBuiltinResource(typeof(Font), "Arial.ttf");
        txtObj.fontSize = 24;
        txtObj.color = Color.white;
        txtObj.alignment = TextAnchor.MiddleCenter;
    }

    /// <summary>创建进度条</summary>
    public static Slider CreateProgressBar(Canvas canvas, Vector2 pos, Vector2 size, Color fillColor)
    {
        var obj = new GameObject("ProgressBar", typeof(RectTransform), typeof(Slider));
        obj.transform.SetParent(canvas.transform, false);
        var rect = obj.GetComponent<RectTransform>();
        rect.anchoredPosition = pos;
        rect.sizeDelta = size;

        // Background
        var bgObj = new GameObject("Background", typeof(RectTransform), typeof(Image));
        bgObj.transform.SetParent(obj.transform, false);
        var bgRect = bgObj.GetComponent<RectTransform>();
        bgRect.anchorMin = Vector2.zero;
        bgRect.anchorMax = Vector2.one;
        bgRect.sizeDelta = Vector2.zero;
        bgObj.GetComponent<Image>().color = new Color(0.2f, 0.2f, 0.2f, 0.8f);

        // Fill area
        var fillArea = new GameObject("Fill Area", typeof(RectTransform));
        fillArea.transform.SetParent(obj.transform, false);
        var faRect = fillArea.GetComponent<RectTransform>();
        faRect.anchorMin = Vector2.zero;
        faRect.anchorMax = Vector2.one;
        faRect.sizeDelta = Vector2.zero;

        var fillObj = new GameObject("Fill", typeof(RectTransform), typeof(Image));
        fillObj.transform.SetParent(fillArea.transform, false);
        var fRect = fillObj.GetComponent<RectTransform>();
        fRect.anchorMin = Vector2.zero;
        fRect.anchorMax = Vector2.one;
        fRect.sizeDelta = Vector2.zero;
        fillObj.GetComponent<Image>().color = fillColor;

        var slider = obj.GetComponent<Slider>();
        slider.fillRect = fRect;
        slider.interactable = false;
        slider.value = 1f;

        return slider;
    }
}

// ============================================================
// GFM_Create — 3D 物体快捷创建工具
// ============================================================
// 用法：
//   GFM_Create.SetBaseMaterial(mat);  // 设置基础材质（Start 里调用一次）
//   var cube = GFM_Create.Obj(PrimitiveType.Cube, pos, scale, "Building");
//   var ground = GFM_Create.Ground(50, 50);  // 创建地面
//   GFM_Create.SetColor(obj, new Color(0.5f, 0.5f, 0.5f));
// ============================================================
public static class GFM_Create
{
    private static Material _baseMat;

    // Object pool counters (scene has __Pool_Cube_01..50, __Pool_Sphere_01..20, __Pool_Plane_01..10, __Pool_Cylinder_01..10)
    private static int _cubeIdx = 0;
    private static int _sphereIdx = 0;
    private static int _planeIdx = 0;
    private static int _cylinderIdx = 0;
    private const int MAX_CUBES = 50;
    private const int MAX_SPHERES = 20;
    private const int MAX_PLANES = 10;
    private const int MAX_CYLINDERS = 10;

    /// <summary>设置基础材质（从场景 __MaterialSource 获取）</summary>
    public static void SetBaseMaterial(Material mat)
    {
        _baseMat = mat;
    }

    /// <summary>自动从场景初始化材质</summary>
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
            _baseMat.color = Color.white; // neutral base, Obj() will set per-type colors
        }
        // Auto-set camera: top-down 45° orthographic view
        var cam = Camera.main;
        if (cam != null)
        {
            cam.backgroundColor = new Color(0.6f, 0.8f, 1f); // sky blue
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.orthographic = true;
            cam.orthographicSize = 8f;
            cam.transform.rotation = Quaternion.Euler(45f, 0f, 0f);
            cam.transform.position = new Vector3(0f, 15f, -15f);
        }
        return _baseMat;
    }

    /// <summary>从场景对象池取一个预放的物体，移动到指定位置。Luna 兼容！</summary>
    /// <param name="type">PrimitiveType.Cube/Sphere/Plane/Cylinder</param>
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
            default: // Cube, Capsule → use cube pool
                prefix = "Cube"; idx = ++_cubeIdx; max = MAX_CUBES; break;
        }
        if (idx > max) idx = max; // Clamp to max (reuse last object)
        string name = "__Pool_" + prefix + "_" + idx.ToString("D2");
        var obj = GameObject.Find(name);
        if (obj == null)
        {
            // Fallback: CreatePrimitive (won't render in Luna, but compiles)
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

    /// <summary>重置对象池计数器（在 Start() 开头调用）</summary>
    public static void ResetPool()
    {
        _cubeIdx = 0; _sphereIdx = 0; _planeIdx = 0; _cylinderIdx = 0;
        // Hide all pool objects (move offscreen)
        for (int i = 1; i <= MAX_CUBES; i++) { var o = GameObject.Find("__Pool_Cube_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
        for (int i = 1; i <= MAX_SPHERES; i++) { var o = GameObject.Find("__Pool_Sphere_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
        for (int i = 1; i <= MAX_PLANES; i++) { var o = GameObject.Find("__Pool_Plane_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
        for (int i = 1; i <= MAX_CYLINDERS; i++) { var o = GameObject.Find("__Pool_Cylinder_" + i.ToString("D2")); if (o != null) o.transform.position = new Vector3(0, -9999, 0); }
    }

    /// <summary>创建 3D 原始物体（从对象池取，Luna 兼容 + 可选标签）</summary>
    public static GameObject Obj(PrimitiveType type, Vector3 pos, Vector3 scale, string label)
    {
        var obj = PoolGet(type, pos, scale);
        if (obj != null)
        {
            // Auto-assign distinct base color by primitive type (fallback if AI doesn't SetColor)
            var defaultColor = type == PrimitiveType.Cube ? new Color(0.7f, 0.5f, 0.25f) :     // brown
                               type == PrimitiveType.Sphere ? new Color(0.2f, 0.6f, 0.2f) :    // green
                               type == PrimitiveType.Cylinder ? new Color(0.5f, 0.5f, 0.55f) :  // steel gray
                               type == PrimitiveType.Plane ? new Color(0.35f, 0.25f, 0.15f) :   // dark brown
                               new Color(0.6f, 0.6f, 0.6f);                                     // light gray
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

    /// <summary>创建地面（从对象池取 Plane）</summary>
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
                mat.color = new Color(0.35f, 0.25f, 0.15f); // dark brown ground
                r.material = mat;
            }
        }
        return obj;
    }

    /// <summary>设置物体颜色（支持任意颜色）</summary>
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

// ============================================================
// GFM_Pathfinding — A* 寻路系统
// ============================================================
// 用法：
//   // 1. 创建网格（20列 x 20行，每格 1x1，起点在原点）
//   var grid = new GFM_Grid(20, 20, 1f, Vector3.zero);
//
//   // 2. 设置障碍物
//   grid.SetWalkable(5, 5, false);                    // 单格
//   grid.SetWalkableRect(3, 3, 8, 8, false);          // 矩形区域
//   grid.SetWalkableByWorldPos(new Vector3(5,0,5), false); // 世界坐标
//
//   // 3. 寻路
//   List<Vector3> path = GFM_Pathfinding.FindPath(grid, startPos, endPos);
//   if (path != null) { /* 沿 path 移动 */ }
//
//   // 4. 沿路径移动（在 Update 中调用）
//   transform.position = GFM_Pathfinding.MoveAlongPath(path, ref pathIndex, transform.position, speed * Time.deltaTime);
//
//   // 5. 允许对角线移动（默认开启）
//   GFM_Pathfinding.allowDiagonal = false;  // 只走四方向
// ============================================================

/// <summary>A* 网格节点（内部使用）</summary>
public class GFM_GridNode
{
    public int row;
    public int col;
    public float worldX;
    public float worldZ;
    public bool walkable;
    public int gCost;
    public int hCost;
    public int fCost { get { return gCost + hCost; } }
    public GFM_GridNode parent;

    public GFM_GridNode(int row, int col, float worldX, float worldZ, bool walkable)
    {
        this.row = row;
        this.col = col;
        this.worldX = worldX;
        this.worldZ = worldZ;
        this.walkable = walkable;
    }
}

/// <summary>A* 寻路网格</summary>
public class GFM_Grid
{
    public int width;   // 列数
    public int height;  // 行数
    public float cellSize;
    public Vector3 origin;
    public GFM_GridNode[,] nodes;

    /// <summary>创建网格</summary>
    /// <param name="width">列数（X 方向）</param>
    /// <param name="height">行数（Z 方向）</param>
    /// <param name="cellSize">每格大小</param>
    /// <param name="origin">网格左下角世界坐标</param>
    public GFM_Grid(int width, int height, float cellSize, Vector3 origin)
    {
        this.width = width;
        this.height = height;
        this.cellSize = cellSize;
        this.origin = origin;
        nodes = new GFM_GridNode[width, height];
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                float wx = origin.x + x * cellSize + cellSize * 0.5f;
                float wz = origin.z + y * cellSize + cellSize * 0.5f;
                nodes[x, y] = new GFM_GridNode(x, y, wx, wz, true);
            }
        }
    }

    /// <summary>设置单格是否可通行</summary>
    public void SetWalkable(int x, int y, bool walkable)
    {
        if (x >= 0 && x < width && y >= 0 && y < height)
            nodes[x, y].walkable = walkable;
    }

    /// <summary>设置矩形区域是否可通行</summary>
    public void SetWalkableRect(int xMin, int yMin, int xMax, int yMax, bool walkable)
    {
        for (int x = Mathf.Max(0, xMin); x <= Mathf.Min(width - 1, xMax); x++)
            for (int y = Mathf.Max(0, yMin); y <= Mathf.Min(height - 1, yMax); y++)
                nodes[x, y].walkable = walkable;
    }

    /// <summary>根据世界坐标设置可通行性</summary>
    public void SetWalkableByWorldPos(Vector3 worldPos, bool walkable)
    {
        GFM_GridNode node = GetNodeFromWorldPos(worldPos);
        if (node != null) node.walkable = walkable;
    }

    /// <summary>用 Physics 射线检测自动标记障碍物</summary>
    /// <param name="obstacleLayer">障碍物 LayerMask</param>
    /// <param name="checkHeight">射线发射高度</param>
    public void DetectObstacles(LayerMask obstacleLayer, float checkHeight)
    {
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                Vector3 worldPos = new Vector3(nodes[x, y].worldX, checkHeight, nodes[x, y].worldZ);
                if (Physics.Raycast(worldPos, Vector3.down, checkHeight + 1f, obstacleLayer))
                    nodes[x, y].walkable = false;
            }
        }
    }

    /// <summary>世界坐标转网格节点</summary>
    public GFM_GridNode GetNodeFromWorldPos(Vector3 worldPos)
    {
        int x = Mathf.FloorToInt((worldPos.x - origin.x) / cellSize);
        int z = Mathf.FloorToInt((worldPos.z - origin.z) / cellSize);
        if (x < 0 || x >= width || z < 0 || z >= height) return null;
        return nodes[x, z];
    }

    /// <summary>网格节点转世界坐标</summary>
    public Vector3 NodeToWorldPos(GFM_GridNode node)
    {
        return new Vector3(node.worldX, origin.y, node.worldZ);
    }

    /// <summary>获取相邻节点</summary>
    public List<GFM_GridNode> GetNeighbors(GFM_GridNode node, bool allowDiagonal)
    {
        List<GFM_GridNode> neighbors = new List<GFM_GridNode>();
        // 四方向
        int[] dx = { 0, 0, -1, 1 };
        int[] dz = { -1, 1, 0, 0 };
        for (int i = 0; i < 4; i++)
        {
            int nx = node.row + dx[i];
            int nz = node.col + dz[i];
            if (nx >= 0 && nx < width && nz >= 0 && nz < height)
                neighbors.Add(nodes[nx, nz]);
        }
        // 对角线
        if (allowDiagonal)
        {
            int[] ddx = { -1, -1, 1, 1 };
            int[] ddz = { -1, 1, -1, 1 };
            for (int i = 0; i < 4; i++)
            {
                int nx = node.row + ddx[i];
                int nz = node.col + ddz[i];
                if (nx >= 0 && nx < width && nz >= 0 && nz < height)
                {
                    // 对角线需要两个相邻直角边都可通行（防止穿墙）
                    bool side1 = nodes[node.row + ddx[i], node.col].walkable;
                    bool side2 = nodes[node.row, node.col + ddz[i]].walkable;
                    if (side1 && side2)
                        neighbors.Add(nodes[nx, nz]);
                }
            }
        }
        return neighbors;
    }

    /// <summary>找距指定位置最近的可通行节点</summary>
    public GFM_GridNode FindNearestWalkable(Vector3 worldPos)
    {
        GFM_GridNode node = GetNodeFromWorldPos(worldPos);
        if (node != null && node.walkable) return node;

        // BFS 找最近可通行格
        float minDist = Mathf.Infinity;
        GFM_GridNode nearest = null;
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                if (!nodes[x, y].walkable) continue;
                float dist = (worldPos.x - nodes[x, y].worldX) * (worldPos.x - nodes[x, y].worldX)
                           + (worldPos.z - nodes[x, y].worldZ) * (worldPos.z - nodes[x, y].worldZ);
                if (dist < minDist) { minDist = dist; nearest = nodes[x, y]; }
            }
        }
        return nearest;
    }
}

/// <summary>A* 寻路算法</summary>
public static class GFM_Pathfinding
{
    /// <summary>是否允许对角线移动（默认 true）</summary>
    public static bool allowDiagonal = true;

    /// <summary>最大搜索步数（防止死循环）</summary>
    public static int maxSteps = 6000;

    /// <summary>
    /// A* 寻路：返回从 startPos 到 endPos 的世界坐标路径点列表
    /// 返回 null 表示无法到达
    /// </summary>
    public static List<Vector3> FindPath(GFM_Grid grid, Vector3 startPos, Vector3 endPos)
    {
        GFM_GridNode startNode = grid.GetNodeFromWorldPos(startPos);
        GFM_GridNode endNode = grid.GetNodeFromWorldPos(endPos);

        // 起点或终点不在网格内，找最近可通行节点
        if (startNode == null || !startNode.walkable)
            startNode = grid.FindNearestWalkable(startPos);
        if (endNode == null || !endNode.walkable)
            endNode = grid.FindNearestWalkable(endPos);
        if (startNode == null || endNode == null) return null;

        // 重置所有节点的寻路数据
        for (int x = 0; x < grid.width; x++)
            for (int y = 0; y < grid.height; y++)
            {
                grid.nodes[x, y].gCost = 0;
                grid.nodes[x, y].hCost = 0;
                grid.nodes[x, y].parent = null;
            }

        List<GFM_GridNode> openList = new List<GFM_GridNode>();
        HashSet<GFM_GridNode> closedSet = new HashSet<GFM_GridNode>();
        openList.Add(startNode);

        int steps = 0;
        while (openList.Count > 0 && steps < maxSteps)
        {
            steps++;
            // 找 fCost 最小的节点
            GFM_GridNode current = openList[0];
            for (int i = 1; i < openList.Count; i++)
            {
                if (openList[i].fCost < current.fCost ||
                    (openList[i].fCost == current.fCost && openList[i].hCost < current.hCost))
                    current = openList[i];
            }

            openList.Remove(current);
            closedSet.Add(current);

            // 到达终点
            if (current == endNode)
                return RetracePath(grid, startNode, endNode);

            // 遍历相邻节点
            List<GFM_GridNode> neighbors = grid.GetNeighbors(current, allowDiagonal);
            for (int i = 0; i < neighbors.Count; i++)
            {
                GFM_GridNode neighbor = neighbors[i];
                if (!neighbor.walkable || closedSet.Contains(neighbor)) continue;

                // 计算代价：直线 10，对角线 14
                bool isDiag = (neighbor.row != current.row && neighbor.col != current.col);
                int moveCost = current.gCost + (isDiag ? 14 : 10);

                if (moveCost < neighbor.gCost || !openList.Contains(neighbor))
                {
                    neighbor.gCost = moveCost;
                    neighbor.hCost = GetHeuristic(neighbor, endNode);
                    neighbor.parent = current;
                    if (!openList.Contains(neighbor))
                        openList.Add(neighbor);
                }
            }
        }
        return null; // 无法到达
    }

    /// <summary>曼哈顿距离启发式（带对角线修正）</summary>
    private static int GetHeuristic(GFM_GridNode a, GFM_GridNode b)
    {
        int dx = Mathf.Abs(a.row - b.row);
        int dz = Mathf.Abs(a.col - b.col);
        // 对角线距离公式
        if (dx > dz) return 14 * dz + 10 * (dx - dz);
        return 14 * dx + 10 * (dz - dx);
    }

    /// <summary>回溯路径</summary>
    private static List<Vector3> RetracePath(GFM_Grid grid, GFM_GridNode start, GFM_GridNode end)
    {
        List<Vector3> path = new List<Vector3>();
        GFM_GridNode current = end;
        while (current != start)
        {
            path.Add(grid.NodeToWorldPos(current));
            current = current.parent;
        }
        path.Add(grid.NodeToWorldPos(start));
        path.Reverse();
        return path;
    }

    /// <summary>
    /// 沿路径移动：返回新位置，到达当前路径点后 pathIndex 自增
    /// 在 Update 中调用：pos = GFM_Pathfinding.MoveAlongPath(path, ref idx, pos, speed * dt);
    /// </summary>
    public static Vector3 MoveAlongPath(List<Vector3> path, ref int pathIndex, Vector3 currentPos, float step)
    {
        if (path == null || pathIndex >= path.Count) return currentPos;
        Vector3 target = path[pathIndex];
        Vector3 newPos = Vector3.MoveTowards(currentPos, target, step);
        if (Vector3.Distance(newPos, target) < 0.01f)
            pathIndex++;
        return newPos;
    }

    /// <summary>
    /// 简化路径：去除共线中间点
    /// </summary>
    public static List<Vector3> SimplifyPath(List<Vector3> path)
    {
        if (path == null || path.Count <= 2) return path;
        List<Vector3> simplified = new List<Vector3>();
        simplified.Add(path[0]);
        Vector3 lastDir = Vector3.zero;
        for (int i = 1; i < path.Count; i++)
        {
            Vector3 dir = (path[i] - path[i - 1]).normalized;
            if (dir != lastDir)
            {
                simplified.Add(path[i - 1]);
                lastDir = dir;
            }
        }
        simplified.Add(path[path.Count - 1]);
        return simplified;
    }
}
