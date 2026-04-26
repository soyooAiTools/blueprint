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
// Luna runtime 中 UI Text 组件创建失败时会返回原生 null；
// 下一行赋值直接抛 "Cannot set properties of null (setting 'font')"。
// 正确写法: new GameObject(name)，确保 RectTransform 后用 AddComponent(typeof(Text))，
// 并用 object.ReferenceEquals 做原生 null 判断。
// ============================================================

using UnityEngine;
using UnityEngine.UI;

public static class GFM_UI
{
    private static Font _cachedFont;
    private static bool _fontLoadAttempted;

    private static bool IsMissing(object value)
    {
        return object.ReferenceEquals(value, null);
    }

    private static RectTransform EnsureRect(GameObject obj)
    {
        if (IsMissing(obj)) return null;
        var rect = (RectTransform)obj.GetComponent(typeof(RectTransform));
        if (IsMissing(rect)) rect = (RectTransform)obj.AddComponent(typeof(RectTransform));
        return rect;
    }

    private static Text EnsureText(GameObject obj)
    {
        var rect = EnsureRect(obj);
        if (IsMissing(rect)) return null;
        var txt = (Text)obj.GetComponent(typeof(Text));
        if (IsMissing(txt)) txt = (Text)obj.AddComponent(typeof(Text));
        return txt;
    }

    private static Image EnsureImage(GameObject obj)
    {
        var rect = EnsureRect(obj);
        if (IsMissing(rect)) return null;
        var img = (Image)obj.GetComponent(typeof(Image));
        if (IsMissing(img)) img = (Image)obj.AddComponent(typeof(Image));
        return img;
    }

    private static Button EnsureButton(GameObject obj)
    {
        var rect = EnsureRect(obj);
        if (IsMissing(rect)) return null;
        var btn = (Button)obj.GetComponent(typeof(Button));
        if (IsMissing(btn)) btn = (Button)obj.AddComponent(typeof(Button));
        return btn;
    }

    private static Slider EnsureSlider(GameObject obj)
    {
        var rect = EnsureRect(obj);
        if (IsMissing(rect)) return null;
        var slider = (Slider)obj.GetComponent(typeof(Slider));
        if (IsMissing(slider)) slider = (Slider)obj.AddComponent(typeof(Slider));
        return slider;
    }

    // 获取运行时 UI 使用的默认字体。
    private static Font GetFont()
    {
        if (_cachedFont != null) return _cachedFont;
        if (_fontLoadAttempted) return null;
        _fontLoadAttempted = true;
        _cachedFont = Resources.Load<Font>("DefaultFont");
        if (_cachedFont == null) Debug.LogWarning("[GFM_UI] DefaultFont 加载失败, Text 将走 UI 内置默认字体");
        return _cachedFont;
    }

    // Text 样式写入在 Luna 7.1.0 中可能早于 element._text 初始化。
    // 这里静默降级，避免 ApplyFontDataChanges 把预览打成 TypeError。
    private static void ApplyTextStyle(Text txt, string content, int fontSize, Color color, TextAnchor align)
    {
        if (IsMissing(txt)) return;
        try { txt.text = content; } catch {}
        try
        {
            var f = GetFont();
            if (!IsMissing(f)) txt.font = f;
            txt.fontSize = fontSize;
            txt.color = color;
            txt.alignment = align;
        }
        catch {}
    }

    // 创建 1920x1080 的运行时 UI 画布。
    public static Canvas CreateCanvas(int refWidth = 1920, int refHeight = 1080)
    {
        var obj = new GameObject("Canvas", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
        if (IsMissing(obj)) return null;
        var canvas = (Canvas)obj.GetComponent(typeof(Canvas));
        if (IsMissing(canvas)) return null;
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        var scaler = (CanvasScaler)obj.GetComponent(typeof(CanvasScaler));
        if (!IsMissing(scaler))
        {
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(refWidth, refHeight);
        }
        return canvas;
    }

    // 创建按钮并设置文案、位置和点击事件。
    public static Button CreateButton(Canvas canvas, string text, Vector2 pos, Vector2 size, UnityEngine.Events.UnityAction onClick)
    {
        if (IsMissing(canvas) || IsMissing(canvas.transform)) return null;
        var obj = new GameObject("Btn_" + text);
        if (IsMissing(obj) || IsMissing(obj.transform)) return null;
        obj.transform.SetParent(canvas.transform, false);
        var rect = EnsureRect(obj);
        if (IsMissing(rect)) return null;
        rect.anchoredPosition = pos;
        rect.sizeDelta = size;
        var image = EnsureImage(obj);
        if (IsMissing(image)) return null;
        image.color = new Color(0.2f, 0.7f, 0.3f);
        var btn = EnsureButton(obj);
        if (IsMissing(btn)) return null;
        if (onClick != null) btn.onClick.AddListener(onClick);

        var txtGO = new GameObject("Text");
        if (IsMissing(txtGO) || IsMissing(txtGO.transform)) return btn;
        txtGO.transform.SetParent(obj.transform, false);
        var txtRect = EnsureRect(txtGO);
        if (!IsMissing(txtRect)) txtRect.sizeDelta = size;
        var txtObj = EnsureText(txtGO);
        ApplyTextStyle(txtObj, text, (int)(size.y * 0.4f), Color.white, TextAnchor.MiddleCenter);

        return btn;
    }

    // 创建 Text 文本控件并应用基础样式。
    public static Text CreateText(Canvas canvas, string content, Vector2 pos, int fontSize)
    {
        if (IsMissing(canvas) || IsMissing(canvas.transform)) return null;
        var obj = new GameObject("Text_" + (content == null ? "" : content));
        if (IsMissing(obj) || IsMissing(obj.transform)) return null;
        obj.transform.SetParent(canvas.transform, false);
        var rect = EnsureRect(obj);
        if (IsMissing(rect)) return null;
        rect.anchoredPosition = pos;
        rect.sizeDelta = new Vector2(400, fontSize * 2);
        var txt = EnsureText(obj);
        if (IsMissing(txt)) return null;
        ApplyTextStyle(txt, content, fontSize, Color.white, TextAnchor.MiddleCenter);
        return txt;
    }

    // 在世界坐标上方创建跟随标签。
    public static void AddWorldLabel(GameObject target, string text, float heightOffset)
    {
        if (IsMissing(target)) return;
        var labelObj = new GameObject("Label_" + text, typeof(RectTransform), typeof(Canvas));
        if (IsMissing(labelObj) || IsMissing(labelObj.transform)) return;
        var canvas = (Canvas)labelObj.GetComponent(typeof(Canvas));
        if (IsMissing(canvas)) return;
        canvas.renderMode = RenderMode.WorldSpace;
        canvas.sortingOrder = 100;
        canvas.transform.SetParent(target.transform, false);
        canvas.transform.localPosition = new Vector3(0, heightOffset, 0);
        canvas.transform.localScale = new Vector3(0.015f, 0.015f, 0.015f);
        var rt = (RectTransform)canvas.GetComponent(typeof(RectTransform));
        if (IsMissing(rt)) return;
        rt.sizeDelta = new Vector2(240, 40);

        var bgObj = new GameObject("LabelBG");
        if (IsMissing(bgObj) || IsMissing(bgObj.transform)) return;
        bgObj.transform.SetParent(canvas.transform, false);
        var bgRect = EnsureRect(bgObj);
        if (IsMissing(bgRect)) return;
        bgRect.sizeDelta = new Vector2(240, 40);
        bgRect.anchoredPosition = Vector2.zero;
        var bgImg = EnsureImage(bgObj);
        if (IsMissing(bgImg)) return;
        bgImg.color = new Color(0f, 0f, 0f, 0.0f);

        var txtGO = new GameObject("Text");
        if (IsMissing(txtGO) || IsMissing(txtGO.transform)) return;
        txtGO.transform.SetParent(canvas.transform, false);
        var txtRect = EnsureRect(txtGO);
        if (IsMissing(txtRect)) return;
        txtRect.sizeDelta = new Vector2(240, 40);
        txtRect.anchoredPosition = Vector2.zero;
        var txtObj = EnsureText(txtGO);
        ApplyTextStyle(txtObj, text, 22, Color.white, TextAnchor.MiddleCenter);
        try { if (!IsMissing(txtObj)) txtObj.horizontalOverflow = HorizontalWrapMode.Overflow; } catch {}

        labelObj.AddComponent<GFM_Billboard>();
    }

    // 创建一个可复用的进度条 UI。
    public static Slider CreateProgressBar(Canvas canvas, Vector2 pos, Vector2 size, Color fillColor)
    {
        if (IsMissing(canvas) || IsMissing(canvas.transform)) return null;
        var obj = new GameObject("ProgressBar");
        if (IsMissing(obj) || IsMissing(obj.transform)) return null;
        obj.transform.SetParent(canvas.transform, false);
        var rect = EnsureRect(obj);
        if (IsMissing(rect)) return null;
        rect.anchoredPosition = pos;
        rect.sizeDelta = size;

        var bgObj = new GameObject("Background");
        if (IsMissing(bgObj) || IsMissing(bgObj.transform)) return null;
        bgObj.transform.SetParent(obj.transform, false);
        var bgRect = EnsureRect(bgObj);
        if (IsMissing(bgRect)) return null;
        bgRect.anchorMin = Vector2.zero;
        bgRect.anchorMax = Vector2.one;
        bgRect.sizeDelta = Vector2.zero;
        var bgImage = EnsureImage(bgObj);
        if (IsMissing(bgImage)) return null;
        bgImage.color = new Color(0.2f, 0.2f, 0.2f, 0.8f);

        var fillArea = new GameObject("Fill Area", typeof(RectTransform));
        if (IsMissing(fillArea) || IsMissing(fillArea.transform)) return null;
        fillArea.transform.SetParent(obj.transform, false);
        var faRect = EnsureRect(fillArea);
        if (IsMissing(faRect)) return null;
        faRect.anchorMin = Vector2.zero;
        faRect.anchorMax = Vector2.one;
        faRect.sizeDelta = Vector2.zero;

        var fillObj = new GameObject("Fill");
        if (IsMissing(fillObj) || IsMissing(fillObj.transform)) return null;
        fillObj.transform.SetParent(fillArea.transform, false);
        var fRect = EnsureRect(fillObj);
        if (IsMissing(fRect)) return null;
        fRect.anchorMin = Vector2.zero;
        fRect.anchorMax = Vector2.one;
        fRect.sizeDelta = Vector2.zero;
        var fillImage = EnsureImage(fillObj);
        if (IsMissing(fillImage)) return null;
        fillImage.color = fillColor;

        var slider = EnsureSlider(obj);
        if (IsMissing(slider)) return null;
        slider.fillRect = fRect;
        slider.interactable = false;
        slider.value = 1f;

        return slider;
    }
}
