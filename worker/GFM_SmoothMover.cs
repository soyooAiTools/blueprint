// ============================================================
// GFM_SmoothMover — 实体平滑位移与"上下浮动"组件 (2026-05-04)
// ============================================================
// 目的：所有 codegen/skeleton 里"为了过 EntityAdvanced 而瞬间 +2y"
//      或"PlaceObj 到 (offX, 0.5, 0)"的硬性 SetPosition 全部走这里，
//      消除玩家肉眼可见的"实体跳来跳去"。
//
// 两种模式：
//   1. MoveTo(go, target, duration) — 一次性滑到 target 后停在那里
//   2. Bobble(go, amplitude, duration) — 上抬 amplitude 米后滑回原位
//      (用于一次性触发的 phase-exit 信号：峰值瞬间通过 EntityAdvanced
//       的 1.5 单位距离阈值，然后回落，原位不偏移)
//
// 用法 (codegen 端)：
//   GFM_SmoothMover.Bobble(forgeWorkshop, 2f, 0.6f);
//
// 2026-05-12: 从 GFM_Tools.cs 抽离为独立文件 (历史 split 时漏掉,导致 build
// 时 GFM_SmoothMover 不存在,触发 ~55× CS0103 / Codex compile fix-loop ~5.5h
// LLM 时间烧光)。修复路径:加进 gfm-files.cjs manifest 让 build 复制。
// ============================================================

using UnityEngine;

public class GFM_SmoothMover : MonoBehaviour
{
    Vector3 _origin;
    Vector3 _target;
    float _duration;
    float _elapsed;
    int _mode; // 1 = MoveTo, 2 = Bobble
    bool _active;

    public static void MoveTo(GameObject go, Vector3 target, float duration)
    {
        if (go == null) return;
        var mover = (GFM_SmoothMover)go.GetComponent(typeof(GFM_SmoothMover));
        if (mover == null) mover = (GFM_SmoothMover)go.AddComponent(typeof(GFM_SmoothMover));
        mover._origin = go.transform.position;
        mover._target = target;
        mover._duration = Mathf.Max(0.05f, duration);
        mover._elapsed = 0f;
        mover._mode = 1;
        mover._active = true;
    }

    public static void Bobble(GameObject go, float amplitude, float duration)
    {
        if (go == null) return;
        var mover = (GFM_SmoothMover)go.GetComponent(typeof(GFM_SmoothMover));
        if (mover == null) mover = (GFM_SmoothMover)go.AddComponent(typeof(GFM_SmoothMover));
        mover._origin = go.transform.position;
        mover._target = mover._origin + new Vector3(0f, amplitude, 0f);
        mover._duration = Mathf.Max(0.1f, duration);
        mover._elapsed = 0f;
        mover._mode = 2;
        mover._active = true;
    }

    void Update()
    {
        if (!_active) return;
        _elapsed += Time.deltaTime;
        float t = Mathf.Clamp01(_elapsed / _duration);
        if (_mode == 1)
        {
            // ease-out cubic
            float eased = 1f - Mathf.Pow(1f - t, 3f);
            transform.position = Vector3.Lerp(_origin, _target, eased);
            if (t >= 1f) _active = false;
        }
        else
        {
            // half-sine bobble: 0 → 1 → 0 over duration
            float wave = Mathf.Sin(t * Mathf.PI);
            transform.position = Vector3.Lerp(_origin, _target, wave);
            if (t >= 1f) { transform.position = _origin; _active = false; }
        }
    }
}
