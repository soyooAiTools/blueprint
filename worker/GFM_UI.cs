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
using UnityEngine.EventSystems;

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

    private static GraphicRaycaster EnsureGraphicRaycaster(GameObject obj)
    {
        if (IsMissing(obj)) return null;
        var raycaster = (GraphicRaycaster)obj.GetComponent(typeof(GraphicRaycaster));
        if (IsMissing(raycaster)) raycaster = (GraphicRaycaster)obj.AddComponent(typeof(GraphicRaycaster));
        return raycaster;
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
        EnsureEventSystem();
        var canvas = (Canvas)obj.GetComponent(typeof(Canvas));
        if (IsMissing(canvas)) return null;
        EnsureGraphicRaycaster(obj);
        ConfigureCanvasForCamera(canvas);
        var scaler = (CanvasScaler)obj.GetComponent(typeof(CanvasScaler));
        if (!IsMissing(scaler))
        {
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(refWidth, refHeight);
        }
        return canvas;
    }

    private static void EnsureEventSystem()
    {
        var existing = GameObject.Find("EventSystem");
        if (!IsMissing(existing))
        {
            if (IsMissing(existing.GetComponent<EventSystem>())) existing.AddComponent<EventSystem>();
            if (IsMissing(existing.GetComponent<StandaloneInputModule>())) existing.AddComponent<StandaloneInputModule>();
            return;
        }
        var obj = new GameObject("EventSystem", typeof(EventSystem), typeof(StandaloneInputModule));
    }

    // 使用 Overlay Canvas,避免 Camera-space 画布平面在镜头翻到 -Z 侧时覆盖 3D 画面。
    // 取证脚本需要同时验证 3D 和 UI 时,应分别采样世界层与 UI 层后合成截图。
    public static void ConfigureCanvasForCamera(Canvas canvas)
    {
        if (IsMissing(canvas)) return;
        EnsureGraphicRaycaster(canvas.gameObject);
        var cam = Camera.main;
        if (IsMissing(cam))
        {
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            return;
        }
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.worldCamera = cam;
        canvas.planeDistance = 8f;
        canvas.sortingOrder = 100;
        ConfigureSourceHudLayout(canvas);
    }

    // 程序员交付版用 1280x720 横屏取证，Screen-space Canvas 需要显式重排，
    // 否则竖屏/大画布锚点会把 HUD 推到截图外。
    public static void ConfigureSourceHudLayout(Canvas canvas)
    {
        ConfigureSourceHudLayout(canvas, true);
    }

    public static void ConfigureSourceHudLayout(Canvas canvas, bool includeJoystick)
    {
        if (IsMissing(canvas)) return;
        var canvasRect = (RectTransform)canvas.GetComponent(typeof(RectTransform));
        if (!IsMissing(canvasRect))
        {
            canvasRect.anchorMin = new Vector2(0.5f, 0.5f);
            canvasRect.anchorMax = new Vector2(0.5f, 0.5f);
            canvasRect.pivot = new Vector2(0.5f, 0.5f);
            canvasRect.anchoredPosition = Vector2.zero;
            canvasRect.sizeDelta = new Vector2(1280f, 720f);
            canvasRect.localScale = Vector3.one;
        }
        var scaler = (CanvasScaler)canvas.GetComponent(typeof(CanvasScaler));
        if (!IsMissing(scaler))
        {
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1280f, 720f);
            scaler.matchWidthOrHeight = 0f;
        }

        LayoutText("Text_Phase", new Vector2(-592f, 322f), new Vector2(92f, 34f), 15);
        LayoutText("Text_Ice", new Vector2(-515f, 322f), new Vector2(62f, 34f), 15);
        LayoutText("Text_Oxygen", new Vector2(-445f, 322f), new Vector2(72f, 34f), 15);
        LayoutText("Text_Scrap", new Vector2(-367f, 322f), new Vector2(78f, 34f), 15);
        LayoutText("Text_Coin", new Vector2(-287f, 322f), new Vector2(78f, 34f), 15);
        LayoutText("Text_Pickaxe", new Vector2(-160f, 322f), new Vector2(150f, 34f), 15);
        LayoutText("Text_Tip", new Vector2(0f, 270f), new Vector2(640f, 42f), 18);
        LayoutText("Text_TargetHint", new Vector2(0f, -308f), new Vector2(330f, 48f), 18);
        LayoutText("Text_StepToast", new Vector2(0f, 220f), new Vector2(420f, 46f), 20);
        if (includeJoystick && !IsJoystickDragging()) LayoutJoystick("JoystickBG", "JoystickHandle");
    }

    private static bool IsJoystickDragging()
    {
        var joystick = GFM_Joystick.instance;
        return joystick != null && joystick.IsDragging;
    }

    private static void LayoutText(string name, Vector2 anchoredPos, Vector2 size, int fontSize)
    {
        var obj = GameObject.Find(name);
        if (IsMissing(obj)) return;
        var rect = EnsureRect(obj);
        if (IsMissing(rect)) return;
        rect.anchorMin = new Vector2(0.5f, 0.5f);
        rect.anchorMax = new Vector2(0.5f, 0.5f);
        rect.pivot = new Vector2(0.5f, 0.5f);
        rect.anchoredPosition = anchoredPos;
        rect.sizeDelta = size;
        var txt = EnsureText(obj);
        if (!IsMissing(txt))
        {
            txt.fontSize = fontSize;
            txt.alignment = TextAnchor.MiddleCenter;
            txt.horizontalOverflow = name == "Text_Tip" ? HorizontalWrapMode.Wrap : HorizontalWrapMode.Overflow;
            txt.verticalOverflow = VerticalWrapMode.Overflow;
            txt.color = Color.white;
            txt.enabled = true;
        }
    }

    private static void LayoutJoystick(string bgName, string handleName)
    {
        var bg = GameObject.Find(bgName);
        if (!IsMissing(bg))
        {
            var bgRect = EnsureRect(bg);
            if (!IsMissing(bgRect))
            {
                bgRect.anchorMin = new Vector2(0.5f, 0.5f);
                bgRect.anchorMax = new Vector2(0.5f, 0.5f);
                bgRect.pivot = new Vector2(0.5f, 0.5f);
                bgRect.anchoredPosition = new Vector2(-550f, -260f);
                bgRect.sizeDelta = new Vector2(134f, 134f);
            }
            var bgImage = (Image)bg.GetComponent(typeof(Image));
            if (!IsMissing(bgImage)) bgImage.color = new Color(0f, 0f, 0f, 0f);
        }
        var handle = GameObject.Find(handleName);
        if (!IsMissing(handle))
        {
            var handleRect = EnsureRect(handle);
            if (!IsMissing(handleRect))
            {
                handleRect.anchorMin = new Vector2(0.5f, 0.5f);
                handleRect.anchorMax = new Vector2(0.5f, 0.5f);
                handleRect.pivot = new Vector2(0.5f, 0.5f);
                handleRect.anchoredPosition = Vector2.zero;
                handleRect.sizeDelta = new Vector2(56f, 56f);
            }
            var handleImage = (Image)handle.GetComponent(typeof(Image));
            if (!IsMissing(handleImage)) handleImage.color = new Color(1f, 1f, 1f, 0f);
        }
    }

    // 让 screen-space 文本跟随实体头顶，对齐源 HTML 的 DOM label 行为。
    public static void PositionTextOverEntity(Canvas canvas, string textName, string entityName, float heightOffset)
    {
        if (IsMissing(canvas)) return;
        var textObj = GameObject.Find(textName);
        var target = GameObject.Find(entityName);
        if (IsMissing(textObj)) return;
        if (IsMissing(target) || !target.activeInHierarchy)
        {
            var missingText = EnsureText(textObj);
            if (!IsMissing(missingText)) missingText.enabled = false;
            return;
        }
        var rect = EnsureRect(textObj);
        var text = EnsureText(textObj);
        var cam = canvas.worldCamera != null ? canvas.worldCamera : Camera.main;
        var canvasRect = (RectTransform)canvas.GetComponent(typeof(RectTransform));
        if (IsMissing(rect) || IsMissing(cam) || IsMissing(canvasRect)) return;
        Vector3 screen = cam.WorldToScreenPoint(target.transform.position + Vector3.up * heightOffset);
        bool visible = screen.z > 0f && screen.x >= 0f && screen.x <= Screen.width && screen.y >= 0f && screen.y <= Screen.height;
        if (!IsMissing(text)) text.enabled = visible;
        if (!visible) return;
        float logicalWidth = Mathf.Max(1f, (float)Screen.width);
        float logicalHeight = Mathf.Max(1f, (float)Screen.height);
        float screenWidth = Mathf.Max(logicalWidth, canvasRect.sizeDelta.x);
        float screenHeight = Mathf.Max(logicalHeight, canvasRect.sizeDelta.y);
        float scaledX = screen.x * screenWidth / logicalWidth;
        float scaledY = screen.y * screenHeight / logicalHeight;
        rect.anchorMin = new Vector2(0.5f, 0.5f);
        rect.anchorMax = new Vector2(0.5f, 0.5f);
        rect.pivot = new Vector2(0.5f, 0.5f);
        rect.anchoredPosition = new Vector2(scaledX - screenWidth * 0.5f, scaledY - screenHeight * 0.5f);
        rect.sizeDelta = new Vector2(180f, 34f);
        if (!IsMissing(text))
        {
            text.fontSize = 18;
            text.alignment = TextAnchor.MiddleCenter;
            text.horizontalOverflow = HorizontalWrapMode.Overflow;
            text.verticalOverflow = VerticalWrapMode.Overflow;
        }
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
        if (target.transform.Find("Label_" + text) != null) return;
        var labelObj = new GameObject("Label_" + text, typeof(RectTransform), typeof(Canvas));
        if (IsMissing(labelObj) || IsMissing(labelObj.transform)) return;
        var canvas = (Canvas)labelObj.GetComponent(typeof(Canvas));
        if (IsMissing(canvas)) return;
        canvas.renderMode = RenderMode.WorldSpace;
        canvas.sortingOrder = 100;
        canvas.transform.SetParent(target.transform, false);
        canvas.transform.localPosition = new Vector3(0, heightOffset, 0);
        canvas.transform.localScale = new Vector3(0.018f, 0.018f, 0.018f);
        var rt = (RectTransform)canvas.GetComponent(typeof(RectTransform));
        if (IsMissing(rt)) return;
        rt.sizeDelta = new Vector2(260, 46);

        var bgObj = new GameObject("LabelBG");
        if (IsMissing(bgObj) || IsMissing(bgObj.transform)) return;
        bgObj.transform.SetParent(canvas.transform, false);
        var bgRect = EnsureRect(bgObj);
        if (IsMissing(bgRect)) return;
        bgRect.sizeDelta = new Vector2(260, 46);
        bgRect.anchoredPosition = Vector2.zero;
        var bgImg = EnsureImage(bgObj);
        if (IsMissing(bgImg)) return;
        bgImg.color = new Color(0f, 0f, 0f, 0f);

        var txtGO = new GameObject("Text");
        if (IsMissing(txtGO) || IsMissing(txtGO.transform)) return;
        txtGO.transform.SetParent(canvas.transform, false);
        var txtRect = EnsureRect(txtGO);
        if (IsMissing(txtRect)) return;
        txtRect.sizeDelta = new Vector2(260, 46);
        txtRect.anchoredPosition = Vector2.zero;
        var txtObj = EnsureText(txtGO);
        ApplyTextStyle(txtObj, text, 22, Color.white, TextAnchor.MiddleCenter);
        try { if (!IsMissing(txtObj)) txtObj.horizontalOverflow = HorizontalWrapMode.Overflow; } catch {}
        var outline = (Outline)txtGO.GetComponent(typeof(Outline));
        if (IsMissing(outline)) outline = (Outline)txtGO.AddComponent(typeof(Outline));
        if (!IsMissing(outline))
        {
            outline.effectColor = new Color(0f, 0f, 0f, 0.95f);
            outline.effectDistance = new Vector2(2f, -2f);
        }

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
