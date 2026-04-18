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
    private Vector2 _input = Vector2.zero;
    private bool _dragging = false;
    private float _radius;
    private Vector2 _bgStartPos;

    public static GFM_Joystick Create(Canvas canvas, float size)
    {
        if (instance != null) return instance;

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
