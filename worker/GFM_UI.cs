// ============================================================
// GFM_UI.cs — UI 创建工具
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================
// 字体加载: 只用 Resources/DefaultFont
// ⛔ 不要用 Resources.GetBuiltinResource — Luna runtime 不实现,抛 "not implemented"
// ⛔ 不要用 Font.CreateDynamicFontFromOSFont — Luna WebGL 无系统字体
// 模板工程必须在 Assets/Resources/ 放一个 DefaultFont.ttf (模板已内置)
// ============================================================

using UnityEngine;
using UnityEngine.UI;

public static class GFM_UI
{
    private static Font _cachedFont;

    private static Font GetFont()
    {
        if (_cachedFont != null) return _cachedFont;
        _cachedFont = Resources.Load<Font>("DefaultFont");
        // 不做 GetBuiltinResource fallback — Luna 不支持会抛错
        // 如果 DefaultFont 加载失败,返回 null,Text.font=null 会用 UI 默认字体,不崩溃
        return _cachedFont;
    }

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
        txtObj.font = GetFont();
        txtObj.fontSize = (int)(size.y * 0.4f);
        txtObj.color = Color.white;
        txtObj.alignment = TextAnchor.MiddleCenter;

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
        txt.text = content;
        txt.font = GetFont();
        txt.fontSize = fontSize;
        txt.color = Color.white;
        txt.alignment = TextAnchor.MiddleCenter;
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

        var txtObj = new GameObject("Text", typeof(RectTransform)).AddComponent<Text>();
        txtObj.transform.SetParent(canvas.transform, false);
        var txtRect = txtObj.GetComponent<RectTransform>();
        txtRect.sizeDelta = new Vector2(240, 40);
        txtRect.anchoredPosition = Vector2.zero;
        txtObj.text = text;
        txtObj.font = GetFont();
        txtObj.fontSize = 22;
        txtObj.color = Color.white;
        txtObj.alignment = TextAnchor.MiddleCenter;
        txtObj.horizontalOverflow = HorizontalWrapMode.Overflow;

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
