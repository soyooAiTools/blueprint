// ============================================================================
// GFM_CameraController.cs — 相机控制器（单例）
// ----------------------------------------------------------------------------
// 职责：封装主相机相关的一切：
//       - 缓存 Camera.main 引用（Luna 规则：绝对不能每帧 Camera.main，必须缓存）
//       - 初始化正交投影 + 等距视角（俯角 50° 高度 12 偏移 -8）
//       - 反馈 01 #3：锁 Y 高度 + XZ 平面 lerp 平移，避免镜头瞬移/Y 漂移
//       - 提供 LookAt(平滑旋转) / MoveTo / ScreenPointToRay 等封装
//
// 设计约束 (Luna 兼容)：
//   - 不修改 Camera.backgroundColor (skeleton 预设)
//   - 只缓存、只读配置，不动 GL 状态
//   - 不调 Destroy()，防重用 enabled=false
//
// 外部调用入口 (示例):
//   Camera cam = GFM_CameraController.Instance.Main;
//   GFM_CameraController.Instance.LookAt(playerTransform.position);
//   GFM_CameraController.Instance.MoveTo(playerTransform.position);
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

    // 反馈 01 #3：相机锁定的 Y 轴高度。LateUpdate 每帧把 transform.position.y 拉回此值，
    // 即使别的代码偶发改了 Y 也能立刻纠正，保证镜头视角稳定不抖。LockedY 可被 SetCameraHeight 改写。
    public float LockedY = 12f;

    // Wave 3：lerp 速率从 5 下调到 1.0，shot 切换时镜头平滑过渡 ~3 秒（exp 衰减 95% @ 3s）。
    // 这是用户硬性要求：每个 shot 之间不能瞬移，要让玩家肉眼看见镜头在动。
    // 改这里前请阅读 lib/handoff-doc-generator.cjs §4.1 镜头规则。
    public float PanLerpRate = 1.0f;
    // LookAt 旋转 lerp 速率（同 PanLerpRate 量级，角速度过快会抖；同步降到 1.0）。
    public float RotateLerpRate = 1.0f;
    // Wave 3：orthographicSize 的 lerp 速率（用于 zoom 平滑过渡）。
    public float ZoomLerpRate = 1.0f;
    // 程序员审阅版镜头范围：保证 zoom 不会过近看不清上下文，也不会过远丢失主体。
    public float MinOrthoSize = 4.5f;
    public float MaxOrthoSize = 12f;
    // 默认等距镜头位于焦点后方 8 个单位。
    public float FollowZOffset = -8f;
    // 距离阈值：targetPosition 与当前位置距离小于此值视为已收敛，停止插值省 GPU。
    public float SettleDistance = 0.005f;

    private bool _inited = false;
    private Vector3 _targetPosition;
    private Quaternion _targetRotation;
    private bool _hasTarget = false;
    // Wave 3：orthographicSize 平滑过渡用的目标值，外部通过 SetOrthographicSize 设置。
    private float _targetOrthoSize = 8f;
    private bool _hasOrthoTarget = false;

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
            _mainCam.transform.position = new Vector3(0, LockedY, -8f);
            _mainCam.transform.rotation = Quaternion.Euler(50f, 0f, 0f);
            _targetPosition = _mainCam.transform.position;
            _targetRotation = _mainCam.transform.rotation;
        }
    }

    private void Awake()
    {
        if (_instance != null && _instance != this) { enabled = false; return; }
        _instance = this;
        Init();
    }

    // ------------------------------------------------------------------------
    // 【让相机看向某个世界点】反馈 01 #3：旋转走 lerp,不再瞬时 LookAt 防镜头抖。
    // AutoPlay 模式每帧调用一次，维持镜头跟随感。
    // ------------------------------------------------------------------------
    public void LookAt(Vector3 worldPos)
    {
        if (_mainCam == null) return;
        Vector3 dir = worldPos - _mainCam.transform.position;
        if (dir.sqrMagnitude < 1e-4f) return;
        _targetRotation = Quaternion.LookRotation(dir);
        _hasTarget = true;
    }

    // ------------------------------------------------------------------------
    // 【平移到目标位置】反馈 01 #3：Y 锁定 LockedY,XZ 平面走 lerp 不瞬移。
    // 调 MoveTo 后 LateUpdate 会按 PanLerpRate 平滑收敛。
    // ------------------------------------------------------------------------
    public void MoveTo(Vector3 worldPosition)
    {
        _targetPosition = new Vector3(worldPosition.x, LockedY, worldPosition.z);
        _hasTarget = true;
    }

    // ------------------------------------------------------------------------
    // 【设置正交尺寸】Wave 3：shot 切换 zoom 时调这个，不要直接写 mainCam.orthographicSize。
    // LateUpdate 按 ZoomLerpRate 平滑收敛到 size，避免画面突然放大/缩小。
    // ------------------------------------------------------------------------
    public void SetOrthographicSize(float size)
    {
        if (size <= 0f) return;
        _targetOrthoSize = Mathf.Clamp(size, MinOrthoSize, MaxOrthoSize);
        _hasOrthoTarget = true;
    }

    // ------------------------------------------------------------------------
    // 【构图到世界点】shot 入口统一调这个，让目标点保持在镜头中心附近，同时 zoom 平滑变化。
    // 不直接改 mainCam.transform.position / LookAt，避免程序员审阅时看见镜头瞬移。
    // ------------------------------------------------------------------------
    public void FramePoint(Vector3 worldPosition, float orthoSize)
    {
        if (_mainCam == null) return;
        SetOrthographicSize(orthoSize);
        _targetPosition = new Vector3(worldPosition.x, LockedY, worldPosition.z + FollowZOffset);
        LookAt(worldPosition);
        _hasTarget = true;
    }

    // ------------------------------------------------------------------------
    // 【设置相机高度 + Z 偏移】Wave 3：shot 切换 lift / 视野俯仰时调这个，不要直接写
    // mainCam.transform.position。会更新 LockedY 并触发 MoveTo lerp 收敛。
    // ------------------------------------------------------------------------
    public void SetCameraHeight(float height, float zOffset)
    {
        LockedY = height;
        Vector3 cur = (_mainCam != null) ? _mainCam.transform.position : _targetPosition;
        _targetPosition = new Vector3(cur.x, height, zOffset);
        _hasTarget = true;
    }

    // ------------------------------------------------------------------------
    // 【每帧应用 lerp】放在 LateUpdate 保证物体先移动、再相机跟随,避免抖。
    // 同时强制锁 Y,即使别处代码意外改了 transform.position.y 也能立即拉回。
    // ------------------------------------------------------------------------
    private void LateUpdate()
    {
        if (_mainCam == null) return;
        Transform t = _mainCam.transform;
        if (_hasTarget)
        {
            t.position = Vector3.Lerp(t.position, _targetPosition, PanLerpRate * Time.deltaTime);
            t.rotation = Quaternion.Slerp(t.rotation, _targetRotation, RotateLerpRate * Time.deltaTime);
            if ((t.position - _targetPosition).sqrMagnitude < SettleDistance * SettleDistance)
            {
                t.position = _targetPosition;
            }
        }
        // Wave 3：orthographicSize 平滑收敛
        if (_hasOrthoTarget)
        {
            float curSize = _mainCam.orthographicSize;
            float nextSize = Mathf.Lerp(curSize, _targetOrthoSize, ZoomLerpRate * Time.deltaTime);
            if (Mathf.Abs(nextSize - _targetOrthoSize) < 0.01f) nextSize = _targetOrthoSize;
            _mainCam.orthographicSize = nextSize;
        }
        if (!Mathf.Approximately(t.position.y, LockedY))
        {
            t.position = new Vector3(t.position.x, LockedY, t.position.z);
        }
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
