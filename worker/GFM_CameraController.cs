// ============================================================================
// GFM_CameraController.cs — 相机控制器（单例）
// ----------------------------------------------------------------------------
// 职责：封装主相机相关的一切：
//       - 缓存 Camera.main 引用（Luna 规则：绝对不能每帧 Camera.main，必须缓存）
//       - 初始化正交投影 + 等距视角（俯角 50° 高度 12 偏移 -8）
//       - 提供 LookAt / ScreenPointToRay 等封装
//
// 设计约束 (Luna 兼容)：
//   - 不修改 Camera.backgroundColor (skeleton 预设)
//   - 只缓存、只读配置，不动 GL 状态
//   - 不调 Destroy()，防重用 enabled=false
//
// 外部调用入口 (示例):
//   Camera cam = GFM_CameraController.Instance.Main;
//   GFM_CameraController.Instance.LookAtPlayer(playerTransform);
//   Ray r = GFM_CameraController.Instance.ScreenPointToRay(mousePos);
// ============================================================================

using UnityEngine;

public class GFM_CameraController : MonoBehaviour
{
    // ------------------------------------------------------------------------
    // 【单例入口】懒初始化。Awake 自动调 Init()。
    // ------------------------------------------------------------------------
    private static GFM_CameraController _instance;
    public static GFM_CameraController Instance
    {
        get
        {
            if (_instance == null)
            {
                var obj = new GameObject("GFM_CameraController");
                _instance = obj.AddComponent<GFM_CameraController>();
            }
            return _instance;
        }
    }

    // 【主相机引用】供外部读取，避免每帧调 Camera.main。
    public Camera Main { get { return _mainCam; } }
    private Camera _mainCam;

    private bool _inited = false;

    // ------------------------------------------------------------------------
    // 【初始化】缓存 Camera.main + 设置等距视角。
    // ------------------------------------------------------------------------
    public void Init()
    {
        if (_inited) return;
        _inited = true;
        _mainCam = Camera.main; // 只读缓存；不修改 backgroundColor (skeleton 预设)
        if (_mainCam != null)
        {
            _mainCam.orthographic = true;
            _mainCam.orthographicSize = 8f;
            _mainCam.transform.position = new Vector3(0, 12f, -8f);
            _mainCam.transform.rotation = Quaternion.Euler(50f, 0f, 0f);
        }
    }

    private void Awake()
    {
        if (_instance != null && _instance != this) { enabled = false; return; }
        _instance = this;
        Init();
    }

    // ------------------------------------------------------------------------
    // 【让相机看向玩家】AutoPlay 模式每帧调用一次，维持镜头跟随感。
    // ------------------------------------------------------------------------
    public void LookAt(Vector3 worldPos)
    {
        if (_mainCam != null) _mainCam.transform.LookAt(worldPos);
    }

    // 【屏幕点转射线】Tap-to-move 用。封装起来避免外部直接拿 Camera 引用。
    public Ray ScreenPointToRay(Vector2 screenPoint)
    {
        if (_mainCam == null) return new Ray();
        return _mainCam.ScreenPointToRay(screenPoint);
    }

    // 【相机是否就绪】有些早期阶段 Camera.main 还没准备好；外部可探测。
    public bool IsReady { get { return _mainCam != null; } }
}
