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
// 再用 GetComponent<Text>() 拿引用。
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
        var obj = new GameObject("Canvas");
        var canvas = obj.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        var scaler = obj.AddComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(refWidth, refHeight);
        obj.AddComponent<GraphicRaycaster>();
        return canvas;
    }

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

        var txtGO = new GameObject("Text", typeof(RectTransform), typeof(Text));
        txtGO.transform.SetParent(obj.transform, false);
        txtGO.GetComponent<RectTransform>().sizeDelta = size;
        var txtObj = txtGO.GetComponent<Text>();
        ApplyTextStyle(txtObj, text, (int)(size.y * 0.4f), Color.white, TextAnchor.MiddleCenter);

        return btn;
    }

    public static Text CreateText(Canvas canvas, string content, Vector2 pos, int fontSize)
    {
        var obj = new GameObject("Text_" + content, typeof(RectTransform));
        obj.transform.SetParent(canvas.transform, false);
        var rect = obj.GetComponent<RectTransform>();
        rect.anchoredPosition = pos;
        rect.sizeDelta = new Vector2(400, fontSize * 2);
        var txt = obj.AddComponent<Text>();
        ApplyTextStyle(txt, content, fontSize, Color.white, TextAnchor.MiddleCenter);
        return txt;
    }

    public static void AddWorldLabel(GameObject target, string text, float heightOffset)
    {
        if (target == null) return;
        var labelObj = new GameObject("Label_" + text);
        var canvas = labelObj.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.WorldSpace;
        canvas.sortingOrder = 100;
        canvas.transform.SetParent(target.transform, false);
        canvas.transform.localPosition = new Vector3(0, heightOffset, 0);
        canvas.transform.localScale = new Vector3(0.015f, 0.015f, 0.015f);
        var rt = canvas.GetComponent<RectTransform>();
        rt.sizeDelta = new Vector2(240, 40);

        var bgObj = new GameObject("LabelBG", typeof(RectTransform), typeof(Image));
        bgObj.transform.SetParent(canvas.transform, false);
        var bgRect = bgObj.GetComponent<RectTransform>();
        bgRect.sizeDelta = new Vector2(240, 40);
        bgRect.anchoredPosition = Vector2.zero;
        var bgImg = bgObj.GetComponent<Image>();
        bgImg.color = new Color(0f, 0f, 0f, 0.0f);

        var txtGO = new GameObject("Text", typeof(RectTransform), typeof(Text));
        txtGO.transform.SetParent(canvas.transform, false);
        var txtRect = txtGO.GetComponent<RectTransform>();
        txtRect.sizeDelta = new Vector2(240, 40);
        txtRect.anchoredPosition = Vector2.zero;
        var txtObj = txtGO.GetComponent<Text>();
        ApplyTextStyle(txtObj, text, 22, Color.white, TextAnchor.MiddleCenter);
        if (txtObj != null) txtObj.horizontalOverflow = HorizontalWrapMode.Overflow;

        labelObj.AddComponent<GFM_Billboard>();
    }

    public static Slider CreateProgressBar(Canvas canvas, Vector2 pos, Vector2 size, Color fillColor)
    {
        var obj = new GameObject("ProgressBar", typeof(RectTransform), typeof(Slider));
        obj.transform.SetParent(canvas.transform, false);
        var rect = obj.GetComponent<RectTransform>();
        rect.anchoredPosition = pos;
        rect.sizeDelta = size;

        var bgObj = new GameObject("Background", typeof(RectTransform), typeof(Image));
        bgObj.transform.SetParent(obj.transform, false);
        var bgRect = bgObj.GetComponent<RectTransform>();
        bgRect.anchorMin = Vector2.zero;
        bgRect.anchorMax = Vector2.one;
        bgRect.sizeDelta = Vector2.zero;
        bgObj.GetComponent<Image>().color = new Color(0.2f, 0.2f, 0.2f, 0.8f);

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
