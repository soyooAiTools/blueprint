// ============================================================================
// GFM_TipsManager.cs — 即时提示管理器（单例，反馈 01 #1 架构图）
// ----------------------------------------------------------------------------
// 职责：屏幕中央的临时 toast/tip 提示文本。与 GFM_UIManager.guideText 不同——
//       guideText 长期驻留指导玩家;tips 一闪而过给即时反馈
//       (例如 "已采集" / "资源不足" / "升级完成")。
//
// 设计约束 (Luna 兼容)：
//   - 复用同一个 Text 实例,过期靠 alpha 渐隐 + GameObject.SetActive(false)
//   - 不 Destroy 任何 GameObject (Luna/WebGL 重启不可重建)
//   - 字体走系统默认 Arial.ttf,避免引用资产 GUID
//
// 外部调用入口 (示例):
//   GFM_TipsManager.Instance.Show("资源已采集");
//   GFM_TipsManager.Instance.Show("升级完成", 1.5f, Color.yellow);
//   GFM_TipsManager.Instance.HideImmediate();
// ============================================================================

using UnityEngine;
using UnityEngine.UI;

public class GFM_TipsManager : GFM_SingletonBase<GFM_TipsManager>
{
    private Canvas _canvas;
    private Text _tipText;
    private float _hideAt = 0f;
    private Color _baseColor = Color.white;

    // 【初始化】基类 Awake 已确保 Instance 可用,这里只做 UI 资产搭建。
    protected override void OnInit()
    {
        // 优先复用 UIManager 的 Canvas；程序员交付要求 Canvas 预创建，不在 tips 里临时创建。
        // 拿一个配置正确的 Canvas (含 ScaleWithScreenSize)。不要在这里手搓——
        // 漏配 scaler.uiScaleMode 时默认 ConstantPixelSize,referenceResolution
        // 会被忽略,文字尺寸跟屏幕脱钩。
        if (GFM_UIManager.Instance != null && GFM_UIManager.Instance.Canvas != null)
        {
            _canvas = GFM_UIManager.Instance.Canvas;
        }
        else
        {
            Debug.LogError("GFM_TipsManager 缺少预创建 Canvas，请在场景中绑定 UIManager.Canvas。");
            return;
        }

        _tipText = GFM_UI.CreateText(_canvas, "", new Vector2(0f, 80f), 32);
        if (_tipText == null) return;
        _tipText.name = "GFM_TipText";
        _tipText.text = string.Empty;

        var rt = _tipText.rectTransform;
        if (rt != null)
        {
            rt.anchorMin = new Vector2(0.5f, 0.5f);
            rt.anchorMax = new Vector2(0.5f, 0.5f);
            rt.anchoredPosition = new Vector2(0f, 80f);
            rt.sizeDelta = new Vector2(600f, 60f);
        }

        Color hidden = _baseColor;
        hidden.a = 0f;
        _tipText.color = hidden;
    }

    // 【显示提示】duration 秒后自动隐藏。color 缺省走 baseColor (白色)。
    public void Show(string message, float duration = 1.2f, Color? color = null)
    {
        if (_tipText == null) return;
        _tipText.text = message == null ? string.Empty : message;
        _baseColor = color.HasValue ? color.Value : Color.white;
        _tipText.color = _baseColor;
        _hideAt = Time.unscaledTime + Mathf.Max(0.1f, duration);
    }

    // 【立即隐藏】跳过渐隐,常用于 phase 切换前清屏。
    public void HideImmediate()
    {
        if (_tipText == null) return;
        _tipText.text = string.Empty;
        Color hidden = _baseColor;
        hidden.a = 0f;
        _tipText.color = hidden;
        _hideAt = 0f;
    }

    // 【每帧渐隐】最后 0.3s 走 alpha 渐变,然后关掉 GameObject (不 Destroy)。
    private void Update()
    {
        if (_tipText == null || string.IsNullOrEmpty(_tipText.text)) return;
        var remain = _hideAt - Time.unscaledTime;
        if (remain <= 0f) { HideImmediate(); return; }
        if (remain < 0.3f)
        {
            var c = _baseColor;
            c.a = Mathf.Clamp01(remain / 0.3f);
            _tipText.color = c;
        }
    }
}
