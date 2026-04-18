// ============================================================
// GFM_Luna.cs — Luna 生命周期管理
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;

public class GFM_Luna : MonoBehaviour
{
    public static GFM_Luna instance;
    private bool _isFirst = true;
    private bool _isGameOver = false;

    public static GFM_Luna Init(GameObject parent)
    {
        if (instance != null) return instance;
        var obj = new GameObject("GFM_Luna");
        obj.transform.SetParent(parent.transform);
        instance = obj.AddComponent<GFM_Luna>();

        AudioListener.volume = 0;
        return instance;
    }

    void Update()
    {
        if (Input.GetMouseButtonDown(0) && _isFirst)
        {
            AudioListener.volume = 1;
            _isFirst = false;
        }
    }

    public static void GameOver()
    {
        if (instance != null) instance._isGameOver = true;
        Luna.Unity.LifeCycle.GameEnded();
    }

    public static void GotoStore()
    {
        Luna.Unity.Playable.InstallFullGame();
    }

    public static bool IsGameOver()
    {
        return instance != null && instance._isGameOver;
    }
}
