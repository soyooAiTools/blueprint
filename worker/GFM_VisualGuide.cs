// ============================================================================
// GFM_VisualGuide.cs — 玩家锚点 + 当前目标高亮（无字体依赖）
// ----------------------------------------------------------------------------
// 解决问题：玩家打开试玩广告 → 一堆色块散落 → 不知道"我是哪个、要去哪"。
//
// 设计原则：
//   - 复用 GFM_UI 的 WorldSpace Canvas + Image 模式（已验证可在 Luna 渲染）。
//   - 不依赖字体（避免 DefaultFont 缺失导致看不到）。
//   - 不调 GameObject.CreatePrimitive（Luna 已知 fallback 不渲染）。
//   - 不占用对象池槽位。
//   - 幂等：MarkPlayer/HighlightTarget 多次调用不会重复创建。
//
// 调用方：
//   Start()  : GFM_VisualGuide.MarkPlayer(player)            ← 由 skeleton 注入
//   Update() : GFM_VisualGuide.Tick()                         ← 由 skeleton 注入
//   每个 phase enter : GFM_VisualGuide.HighlightTarget(target) ← 由 phase-init 模板注入
// ============================================================================

using UnityEngine;
using UnityEngine.UI;

public static class GFM_VisualGuide
{
    static GameObject _playerCanvas;     // 玩家头顶黄色菱形 + 上下浮动
    static GameObject _highlightCanvas;  // 当前目标头顶青色菱形 + 缩放脉冲
    static GameObject _highlightTarget;  // 当前高亮的目标 (用于幂等判断)
    static float _pulseT;

    static bool IsMissing(object value)
    {
        if (value is UnityEngine.Object u) return u == null;
        return object.ReferenceEquals(value, null);
    }

    // 给玩家挂"头顶黄色菱形"标识。多次调用幂等，目标 player 变化时自动 re-parent。
    public static void MarkPlayer(GameObject player)
    {
        if (IsMissing(player)) return;

        if (_playerCanvas == null)
        {
            _playerCanvas = BuildIndicator("_VG_PlayerMark", new Color(1f, 0.85f, 0.1f, 0.95f), 60f, 200);
        }
        if (_playerCanvas == null) return;

        _playerCanvas.transform.SetParent(player.transform, false);
        _playerCanvas.transform.localPosition = new Vector3(0, 1.6f, 0);
    }

    // 高亮当前 phase 的目标实体。target=null 时清掉高亮。多次调用同一目标无副作用。
    public static void HighlightTarget(GameObject target)
    {
        if (target == _highlightTarget) return;

        // 清旧
        if (_highlightCanvas != null)
        {
            _highlightCanvas.transform.SetParent(null, false);
            _highlightCanvas.transform.position = new Vector3(0f, -999f, 0f);
        }

        _highlightTarget = target;
        if (IsMissing(target)) return;

        if (_highlightCanvas == null)
        {
            _highlightCanvas = BuildIndicator("_VG_Highlight", new Color(0.2f, 0.95f, 0.95f, 0.6f), 90f, 199);
        }
        if (_highlightCanvas == null) return;

        _highlightCanvas.transform.SetParent(target.transform, false);
        _highlightCanvas.transform.localPosition = new Vector3(0, 1.2f, 0);
    }

    // 每帧调用：玩家标识上下浮动 + 高亮缩放脉冲。
    public static void Tick()
    {
        if (_playerCanvas != null)
        {
            float h = 1.6f + Mathf.Sin(Time.time * 3f) * 0.18f;
            var p = _playerCanvas.transform.localPosition;
            _playerCanvas.transform.localPosition = new Vector3(p.x, h, p.z);
        }
        if (_highlightCanvas != null && _highlightTarget != null)
        {
            _pulseT += Time.deltaTime * 4f;
            float s = 0.025f * (1f + Mathf.Sin(_pulseT) * 0.25f);
            _highlightCanvas.transform.localScale = new Vector3(s, s, s);
        }
    }

    // 构建一个 WorldSpace Canvas + 旋转 45° 的 Image (菱形)。
    static GameObject BuildIndicator(string name, Color color, float sizePx, int sortingOrder)
    {
        GameObject canvasObj;
        try
        {
            canvasObj = new GameObject(name, typeof(RectTransform), typeof(Canvas));
        }
        catch
        {
            return null;
        }
        if (IsMissing(canvasObj)) return null;

        var canvas = (Canvas)canvasObj.GetComponent(typeof(Canvas));
        if (IsMissing(canvas)) return null;
        canvas.renderMode = RenderMode.WorldSpace;
        canvas.sortingOrder = sortingOrder;

        var rt = (RectTransform)canvasObj.GetComponent(typeof(RectTransform));
        if (!IsMissing(rt)) rt.sizeDelta = new Vector2(sizePx * 1.5f, sizePx * 1.5f);
        canvasObj.transform.localScale = new Vector3(0.025f, 0.025f, 0.025f);

        // 内部菱形 Image
        var imgObj = new GameObject("Diamond", typeof(RectTransform), typeof(Image));
        if (IsMissing(imgObj)) return canvasObj;
        imgObj.transform.SetParent(canvasObj.transform, false);
        var imgRt = (RectTransform)imgObj.GetComponent(typeof(RectTransform));
        if (!IsMissing(imgRt))
        {
            imgRt.sizeDelta = new Vector2(sizePx, sizePx);
            imgRt.localRotation = Quaternion.Euler(0, 0, 45f);
        }
        var img = (Image)imgObj.GetComponent(typeof(Image));
        if (!IsMissing(img)) img.color = color;

        // Billboard 朝相机
        canvasObj.AddComponent<GFM_Billboard>();
        return canvasObj;
    }
}
