// ============================================================
// GFM_PhaseTransition — Phase 切换实体显隐缓动 (2026-05-05)
// ============================================================
// 目的：phase 切换时实体不再瞬间出现/消失（PlaceObj 一帧出现 + HideObj
//      一帧 y=-1000）造成的「跳闪/瞬移/突变」感官，改为 scale 0↔orig 的
//      300ms 缓动。
//
// 不动 transform.position：PlaceObj 仍同步落位（EntityAdvanced 看 position
// 不看 scale），gate 行为不变；动画结束后 PopOut 再把 y 拍到 -1000，让
// 后续 phase-init 的 y<-100 守卫继续生效。
//
// 用法（codegen 端）：
//   PlaceObj(forge, 1f, 0.5f, 0f);   // 已有
//   GFM_PhaseTransition.PopIn(forge, 0.3f);   // 0→orig 缩放 ease-out 显示
//   GFM_PhaseTransition.PopOut(forge, 0.3f);  // orig→0 ease-out + y=-1000
// ============================================================
using UnityEngine;

public class GFM_PhaseTransition : MonoBehaviour
{
    Vector3 _origScale;
    bool _origCaptured;
    Vector3 _fromScale;
    Vector3 _toScale;
    float _dur;
    float _elapsed;
    int _mode; // 1 = pop-in (scale lerp), 2 = pop-out (scale lerp + y=-1000 after)
    bool _active;

    static GFM_PhaseTransition GetOrAdd(GameObject go)
    {
        var c = (GFM_PhaseTransition)go.GetComponent(typeof(GFM_PhaseTransition));
        if (c == null) c = (GFM_PhaseTransition)go.AddComponent(typeof(GFM_PhaseTransition));
        return c;
    }

    public static void PopIn(GameObject go, float duration)
    {
        if (go == null) return;
        var c = GetOrAdd(go);
        // refresh origScale snapshot when current localScale looks valid
        // (phase-init 在 PlaceObj+SetScale 之后才调 PopIn,所以此刻 localScale 是目标尺寸)
        Vector3 ls = go.transform.localScale;
        if (ls.sqrMagnitude > 0.0001f)
        {
            c._origScale = ls;
            c._origCaptured = true;
        }
        Vector3 target = c._origCaptured ? c._origScale : Vector3.one;
        // 立刻置零,避免一帧的「全尺寸闪现」
        go.transform.localScale = Vector3.zero;
        c._fromScale = Vector3.zero;
        c._toScale = target;
        c._dur = Mathf.Max(0.05f, duration);
        c._elapsed = 0f;
        c._mode = 1;
        c._active = true;
    }

    public static void PopOut(GameObject go, float duration)
    {
        if (go == null) return;
        var c = GetOrAdd(go);
        // 已经在 hidden 状态(y<<0)就直接收尾,不再播动画
        if (go.transform.position.y < -100f)
        {
            go.transform.localScale = Vector3.zero;
            c._active = false;
            return;
        }
        Vector3 ls = go.transform.localScale;
        if (ls.sqrMagnitude > 0.0001f)
        {
            c._origScale = ls;
            c._origCaptured = true;
        }
        c._fromScale = ls;
        c._toScale = Vector3.zero;
        c._dur = Mathf.Max(0.05f, duration);
        c._elapsed = 0f;
        c._mode = 2;
        c._active = true;
    }

    void Update()
    {
        if (!_active) return;
        _elapsed += Time.deltaTime;
        float t = Mathf.Clamp01(_elapsed / _dur);
        // ease-out cubic
        float k = 1f - Mathf.Pow(1f - t, 3f);
        transform.localScale = Vector3.Lerp(_fromScale, _toScale, k);
        if (t >= 1f)
        {
            transform.localScale = _toScale;
            if (_mode == 2)
            {
                // PopOut 完成 → 把 y 拍到 -1000,保持 phase-init y<-100 守卫继续工作
                Vector3 p = transform.position;
                p.y = -1000f;
                transform.position = p;
            }
            _active = false;
        }
    }
}
