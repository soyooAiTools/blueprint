// ============================================================
// GFM_UI.cs — UI 创建工具
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================
// 字体加载: 只用 Resources/DefaultFont
// ⛔ 不要用 Resources.GetBuiltinResource — Luna runtime 不实现,抛 "not implemented"
// ⛔ 不要用 Font.CreateDynamicFontFromOSFont — Luna WebGL 无系统字体
// 模板工程必须在 Assets/Resources/ 放一个 DefaultFont.ttf (模板已内置)
// ------------------------------------------------------------
// ⛔⛔ 千万不要用链式 new GameObject(...).AddComponent<Text>()
// Luna runtime 中未带 RectTransform 的 GameObject 链式 AddComponent 会返回 null,
// 下一行赋值直接抛 "Cannot set properties of null (setting 'font')"。
// 正确写法: new GameObject(name, typeof(RectTransform), typeof(Text)),
// 再用 (Text)GetComponent(typeof(Text)) 拿引用。
// ============================================================

using UnityEngine;
using UnityEngine.UI;

public static class GFM_UI
{
    private static Font _cachedFont;
    private static bool _fontLoadAttempted;

    private static Font GetFont()
    {
        if (_cachedFont != null) return _cachedFont;
        if (_fontLoadAttempted) return null;
        _fontLoadAttempted = true;
        _cachedFont = Resources.Load<Font>("DefaultFont");
        if (_cachedFont == null) Debug.LogWarning("[GFM_UI] DefaultFont 加载失败, Text 将走 UI 内置默认字体");
        return _cachedFont;
    }

    // null-safe Text 字段设置，避免 .font = null 在某些 Luna 版本上炸引用链
    private static void ApplyTextStyle(Text txt, string content, int fontSize, Color color, TextAnchor align)
    {
        if (txt == null) return;
        txt.text = content;
        var f = GetFont();
        if (f != null) txt.font = f;
        txt.fontSize = fontSize;
        txt.color = color;
        txt.alignment = align;
    }

    public static Canvas CreateCanvas(int refWidth = 1920, int refHeight = 1080)
    {
        var obj = new GameObject("Canvas", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        if (obj == null) return null;
        var canvas = (Canvas)obj.GetComponent(typeof(Canvas));
        if (canvas == null) return null;
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        var scaler = (CanvasScaler)obj.GetComponent(typeof(CanvasScaler));
        if (scaler != null)
        {
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(refWidth, refHeight);
        }
        return canvas;
    }

    public static Button CreateButton(Canvas canvas, string text, Vector2 pos, Vector2 size, UnityEngine.Events.UnityAction onClick)
    {
        if (canvas == null || canvas.transform == null) return null;
        var obj = new GameObject("Btn_" + text, typeof(RectTransform), typeof(Image), typeof(Button));
        if (obj == null || obj.transform == null) return null;
        obj.transform.SetParent(canvas.transform, false);
        var rect = (RectTransform)obj.GetComponent(typeof(RectTransform));
        rect.anchoredPosition = pos;
        rect.sizeDelta = size;
        ((Image)obj.GetComponent(typeof(Image))).color = new Color(0.2f, 0.7f, 0.3f);
        var btn = (Button)obj.GetComponent(typeof(Button));
        if (onClick != null) btn.onClick.AddListener(onClick);

        var txtGO = new GameObject("Text", typeof(RectTransform), typeof(Text));
        txtGO.transform.SetParent(obj.transform, false);
        ((RectTransform)txtGO.GetComponent(typeof(RectTransform))).sizeDelta = size;
        var txtObj = (Text)txtGO.GetComponent(typeof(Text));
        ApplyTextStyle(txtObj, text, (int)(size.y * 0.4f), Color.white, TextAnchor.MiddleCenter);

        return btn;
    }

    public static Text CreateText(Canvas canvas, string content, Vector2 pos, int fontSize)
    {
        if (canvas == null || canvas.transform == null) return null;
        var obj = new GameObject("Text_" + (content == null ? "" : content), typeof(RectTransform), typeof(Text));
        if (obj == null || obj.transform == null) return null;
        obj.transform.SetParent(canvas.transform, false);
        var rect = (RectTransform)obj.GetComponent(typeof(RectTransform));
        if (rect == null) return null;
        rect.anchoredPosition = pos;
        rect.sizeDelta = new Vector2(400, fontSize * 2);
        var txt = (Text)obj.GetComponent(typeof(Text));
        if (txt == null) return null;
        ApplyTextStyle(txt, content, fontSize, Color.white, TextAnchor.MiddleCenter);
        return txt;
    }

    public static void AddWorldLabel(GameObject target, string text, float heightOffset)
    {
        if (target == null) return;
        var labelObj = new GameObject("Label_" + text, typeof(RectTransform), typeof(Canvas));
        if (labelObj == null || labelObj.transform == null) return;
        var canvas = (Canvas)labelObj.GetComponent(typeof(Canvas));
        if (canvas == null) return;
        canvas.renderMode = RenderMode.WorldSpace;
        canvas.sortingOrder = 100;
        canvas.transform.SetParent(target.transform, false);
        canvas.transform.localPosition = new Vector3(0, heightOffset, 0);
        canvas.transform.localScale = new Vector3(0.015f, 0.015f, 0.015f);
        var rt = (RectTransform)canvas.GetComponent(typeof(RectTransform));
        if (rt == null) return;
        rt.sizeDelta = new Vector2(240, 40);

        var bgObj = new GameObject("LabelBG", typeof(RectTransform), typeof(Image));
        bgObj.transform.SetParent(canvas.transform, false);
        var bgRect = (RectTransform)bgObj.GetComponent(typeof(RectTransform));
        bgRect.sizeDelta = new Vector2(240, 40);
        bgRect.anchoredPosition = Vector2.zero;
        var bgImg = (Image)bgObj.GetComponent(typeof(Image));
        bgImg.color = new Color(0f, 0f, 0f, 0.0f);

        var txtGO = new GameObject("Text", typeof(RectTransform), typeof(Text));
        txtGO.transform.SetParent(canvas.transform, false);
        var txtRect = (RectTransform)txtGO.GetComponent(typeof(RectTransform));
        txtRect.sizeDelta = new Vector2(240, 40);
        txtRect.anchoredPosition = Vector2.zero;
        var txtObj = (Text)txtGO.GetComponent(typeof(Text));
        ApplyTextStyle(txtObj, text, 22, Color.white, TextAnchor.MiddleCenter);
        if (txtObj != null) txtObj.horizontalOverflow = HorizontalWrapMode.Overflow;

        labelObj.AddComponent<GFM_Billboard>();
    }

    public static Slider CreateProgressBar(Canvas canvas, Vector2 pos, Vector2 size, Color fillColor)
    {
        var obj = new GameObject("ProgressBar", typeof(RectTransform), typeof(Slider));
        obj.transform.SetParent(canvas.transform, false);
        var rect = (RectTransform)obj.GetComponent(typeof(RectTransform));
        rect.anchoredPosition = pos;
        rect.sizeDelta = size;

        var bgObj = new GameObject("Background", typeof(RectTransform), typeof(Image));
        bgObj.transform.SetParent(obj.transform, false);
        var bgRect = (RectTransform)bgObj.GetComponent(typeof(RectTransform));
        bgRect.anchorMin = Vector2.zero;
        bgRect.anchorMax = Vector2.one;
        bgRect.sizeDelta = Vector2.zero;
        ((Image)bgObj.GetComponent(typeof(Image))).color = new Color(0.2f, 0.2f, 0.2f, 0.8f);

        var fillArea = new GameObject("Fill Area", typeof(RectTransform));
        fillArea.transform.SetParent(obj.transform, false);
        var faRect = (RectTransform)fillArea.GetComponent(typeof(RectTransform));
        faRect.anchorMin = Vector2.zero;
        faRect.anchorMax = Vector2.one;
        faRect.sizeDelta = Vector2.zero;

        var fillObj = new GameObject("Fill", typeof(RectTransform), typeof(Image));
        fillObj.transform.SetParent(fillArea.transform, false);
        var fRect = (RectTransform)fillObj.GetComponent(typeof(RectTransform));
        fRect.anchorMin = Vector2.zero;
        fRect.anchorMax = Vector2.one;
        fRect.sizeDelta = Vector2.zero;
        ((Image)fillObj.GetComponent(typeof(Image))).color = fillColor;

        var slider = (Slider)obj.GetComponent(typeof(Slider));
        slider.fillRect = fRect;
        slider.interactable = false;
        slider.value = 1f;

        return slider;
    }
}
