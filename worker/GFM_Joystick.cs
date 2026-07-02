// ============================================================
// GFM_Joystick.cs — 虚拟摇杆
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;

public class GFM_Joystick : MonoBehaviour, IPointerDownHandler, IDragHandler, IPointerUpHandler
{
    public static GFM_Joystick instance;

    public float Horizontal { get { return _input.x; } }
    public float Vertical { get { return _input.y; } }
    public Vector2 Direction { get { return _input; } }
    public bool IsDragging { get { return _dragging; } }

    private RectTransform _bg;
    private RectTransform _handle;
    private Image _bgImage;
    private Image _handleImage;
    private Vector2 _input = Vector2.zero;
    private Vector2 _originScreenPosition = Vector2.zero;
    private bool _dragging = false;
    private float _radius;
    private const float InputDeadZone = 4f;

    // 场景里预挂的 JoystickBG 也要注册为 instance，否则 probe 首帧只能看到壳。
    private void Awake()
    {
        if (instance != null && instance != this) { enabled = false; return; }
        instance = this;
        _bg = (RectTransform)GetComponent(typeof(RectTransform));
        _bgImage = (Image)GetComponent(typeof(Image));
        if (_bgImage != null) _bgImage.raycastTarget = true;
        if (transform.childCount > 0)
        {
            var child = transform.GetChild(0);
            _handle = (RectTransform)child.GetComponent(typeof(RectTransform));
            _handleImage = (Image)child.GetComponent(typeof(Image));
            if (_handleImage != null) _handleImage.raycastTarget = true;
        }
        _radius = _bg != null ? Mathf.Max(_bg.sizeDelta.x, _bg.sizeDelta.y) * 0.5f : 67f;
        SetVisible(false);
    }

    // 创建运行时摇杆 UI 并绑定输入事件。
    public static GFM_Joystick Create(Canvas canvas, float size)
    {
        if (instance != null)
        {
            instance.Bind(canvas, size);
            return instance;
        }

        var bgObj = new GameObject("JoystickBG", typeof(RectTransform), typeof(Image));
        bgObj.transform.SetParent(canvas.transform, false);
        var bgRect = (RectTransform)bgObj.GetComponent(typeof(RectTransform));
        bgRect.sizeDelta = new Vector2(size, size);
        bgRect.anchorMin = new Vector2(0.5f, 0.5f);
        bgRect.anchorMax = new Vector2(0.5f, 0.5f);
        bgRect.pivot = new Vector2(0.5f, 0.5f);
        bgRect.anchoredPosition = new Vector2(-550f, -260f);
        var bgImg = (Image)bgObj.GetComponent(typeof(Image));
        bgImg.color = new Color(1f, 1f, 1f, 0.45f);
        bgImg.raycastTarget = true;

        var handleObj = new GameObject("JoystickHandle", typeof(RectTransform), typeof(Image));
        handleObj.transform.SetParent(bgObj.transform, false);
        var handleRect = (RectTransform)handleObj.GetComponent(typeof(RectTransform));
        handleRect.sizeDelta = new Vector2(size * 0.4f, size * 0.4f);
        handleRect.anchoredPosition = Vector2.zero;
        var handleImg = (Image)handleObj.GetComponent(typeof(Image));
        handleImg.color = new Color(1f, 1f, 1f, 0.72f);
        handleImg.raycastTarget = true;

        instance = bgObj.AddComponent<GFM_Joystick>();
        instance._bg = bgRect;
        instance._handle = handleRect;
        instance._bgImage = bgImg;
        instance._handleImage = handleImg;
        instance._radius = size * 0.5f;
        instance.SetVisible(false);

        return instance;
    }

    private void Bind(Canvas canvas, float size)
    {
        if (_bg == null) _bg = (RectTransform)GetComponent(typeof(RectTransform));
        if (_bgImage == null) _bgImage = (Image)GetComponent(typeof(Image));
        if (_bgImage != null) _bgImage.raycastTarget = true;
        if (_handle == null && transform.childCount > 0)
        {
            var child = transform.GetChild(0);
            _handle = (RectTransform)child.GetComponent(typeof(RectTransform));
            _handleImage = (Image)child.GetComponent(typeof(Image));
            if (_handleImage != null) _handleImage.raycastTarget = true;
        }
        if (canvas != null && _bg != null && _bg.parent != canvas.transform)
        {
            _bg.SetParent(canvas.transform, false);
        }
        _radius = _bg != null ? Mathf.Max(_bg.sizeDelta.x, _bg.sizeDelta.y) * 0.5f : size * 0.5f;
        SetVisible(_dragging);
    }

    // 处理摇杆按下，开始记录拖拽方向。
    public void OnPointerDown(PointerEventData eventData)
    {
        BeginDragAt(eventData.position);
    }

    // 处理摇杆拖拽并更新方向向量。
    public void OnDrag(PointerEventData eventData)
    {
        UpdateDrag(eventData.position, eventData.pressEventCamera);
    }

    // 处理摇杆松开并重置方向。
    public void OnPointerUp(PointerEventData eventData)
    {
        EndDrag();
    }

    // 支持源 HTML 的任意非 HUD 位置摇杆:用户按在屏幕任意位置后,摇杆原点移动到触点。
    private void Update()
    {
        PollInput();
    }

    // Luna bridge 只调度 GameFlowManagerMain.Update();Player 在主循环中显式 tick widget,
    // 保持"真实 pointer -> joystick widget -> widget 状态 -> Player 输入"链路。
    public void PollInput()
    {
        if (Input.touchCount > 0)
        {
            Touch touch = Input.GetTouch(0);
            if (touch.phase == TouchPhase.Began) BeginDragAt(touch.position);
            if (_dragging && (touch.phase == TouchPhase.Moved || touch.phase == TouchPhase.Stationary)) UpdateDrag(touch.position, null);
            if (_dragging && (touch.phase == TouchPhase.Ended || touch.phase == TouchPhase.Canceled)) EndDrag();
            return;
        }
        if (Input.GetMouseButtonDown(0)) BeginDragAt(Input.mousePosition);
        if (_dragging && Input.GetMouseButton(0)) UpdateDrag(Input.mousePosition, null);
        if (_dragging && Input.GetMouseButtonUp(0)) EndDrag();
    }

    private void BeginDragAt(Vector2 screenPosition)
    {
        _dragging = true;
        _originScreenPosition = screenPosition;
        _input = Vector2.zero;
        if (_handle != null) _handle.anchoredPosition = Vector2.zero;
        if (_bg != null)
        {
            Vector2 localPoint;
            var parentRect = _bg.parent as RectTransform;
            var canvas = _bg.GetComponentInParent<Canvas>();
            Camera eventCamera = canvas != null && canvas.renderMode != RenderMode.ScreenSpaceOverlay
                ? (canvas.worldCamera != null ? canvas.worldCamera : Camera.main)
                : null;
            if (parentRect != null && RectTransformUtility.ScreenPointToLocalPointInRectangle(parentRect, screenPosition, eventCamera, out localPoint))
                _bg.anchoredPosition = localPoint;
            else
                _bg.position = screenPosition;
        }
        SetVisible(true);
    }

    private void UpdateDrag(Vector2 screenPosition, Camera eventCamera)
    {
        if (_bg == null || _handle == null) return;
        Vector2 localPos = screenPosition - _originScreenPosition;
        if (localPos.magnitude < InputDeadZone)
        {
            _handle.anchoredPosition = Vector2.zero;
            _input = Vector2.zero;
            return;
        }
        if (localPos.magnitude > _radius)
            localPos = localPos.normalized * _radius;
        _handle.anchoredPosition = localPos;
        _input = localPos / _radius;
    }

    private void EndDrag()
    {
        _dragging = false;
        if (_handle != null) _handle.anchoredPosition = Vector2.zero;
        _input = Vector2.zero;
        SetVisible(false);
    }

    // 根据拖拽状态调整摇杆强度；idle 状态仍保留 source HTML 的常驻摇杆提示。
    private void SetVisible(bool visible)
    {
        if (_bgImage != null) _bgImage.color = new Color(1f, 1f, 1f, visible ? 0.55f : 0.45f);
        if (_handleImage != null) _handleImage.color = new Color(1f, 1f, 1f, visible ? 0.9f : 0.72f);
    }
}
