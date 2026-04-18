// ============================================================
// GFM_Billboard.cs — 世界标签始终面向相机
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;

public class GFM_Billboard : MonoBehaviour
{
    Camera cam;
    void Start() { cam = Camera.main; }
    void LateUpdate()
    {
        if (cam == null) { cam = Camera.main; if (cam == null) return; }
        transform.rotation = cam.transform.rotation;
    }
}
