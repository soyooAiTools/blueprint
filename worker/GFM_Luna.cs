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

    // 初始化 Luna 交互桥接状态。
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

    // 触发试玩结束并上报 Luna 生命周期。
    public static void GameOver()
    {
        if (instance != null) instance._isGameOver = true;
        Luna.Unity.LifeCycle.GameEnded();
    }

    // 跳转到安装或商店入口。
    public static void GotoStore()
    {
        Luna.Unity.Playable.InstallFullGame();
    }

    // 返回当前是否已经触发游戏结束。
    public static bool IsGameOver()
    {
        return instance != null && instance._isGameOver;
    }
}
