// ============================================================================
// GFM_AutoPlay.cs — 自动播放控制器（单例）
// ----------------------------------------------------------------------------
// 职责：CUA (视觉自动化验证) 模式下代替真实玩家操控游戏。
//       - 检测 __AUTOPLAY_ON__ 标志实体 → 等待 __CUA_OBSERVER_READY__ 握手后激活
//       - 激活后沿 _autoTargets 列表逐个导航到目标实体
//       - 到达目标时回调 GameFlowManagerMain.HandleAutoPlayArrive(targetName)
//         触发该阶段对应的 autoplay 交互副作用（由主文件按 phase 分发）
//
// 关键数值 (与 skeleton 约束绑定 — 修改会导致 CUA 失败)：
//   - autoPlay 仅在 observer-ready 握手后激活，避免观察窗口前偷跑
//   - 每个目标到达后等待 1.5 秒才切换下一个 (给 CUA observer 时间截图)
//   - 导航速度 = Player.MoveSpeed × 1.2
//
// 设计约束 (Luna 兼容):
//   - 不用 Destroy()，防重用 enabled=false
//   - delegate 回调用 System.Action<string> (Bridge.NET 支持)
//
// 外部调用入口 (主文件 Update):
//   GFM_AutoPlay.Instance.CheckActivation(gameTimer);
//   if (GFM_AutoPlay.Instance.IsActive) GFM_AutoPlay.Instance.Tick();
//   int s = GFM_AutoPlay.Instance.Steps;  // 给 CheckEventRules 做 gate
// ============================================================================

using UnityEngine;

public class GFM_AutoPlay : MonoBehaviour
{
    // ========================================================================
    // 【单例入口】
    // ========================================================================
    private static GFM_AutoPlay _instance;
    public static GFM_AutoPlay Instance
    {
        get
        {
            if (_instance == null)
            {
                var obj = new GameObject("GFM_AutoPlay");
                _instance = obj.AddComponent<GFM_AutoPlay>();
            }
            return _instance;
        }
    }

    // ========================================================================
    // 【状态字段】
    //   _isActive: 是否已激活 autoPlay 模式 (激活后主 Update 走 Tick 而非玩家输入)
    //   _checked: 是否已检测过 __AUTOPLAY_ON__ 标志 (避免每帧 Find)
    //   _detectRealTime: 检测到标志的 wall-clock 时间戳
    //   _steps: 已完成的自动交互步数 (CheckEventRules 读它做 phase gate)
    //   _observerReady: CUA observer 是否已明确发出“开始观察”信号
    //   _autoPlayRequested: URL 已明确要求 autoplay=1；即使标志实体漏检也不能退回交互模式
    // ========================================================================
    private bool _isActive = false;
    private bool _checked = false;
    private float _detectRealTime = -1f;
    private int _steps = 0;
    private bool _observerReady = false;
    private bool _requestChecked = false;
    private bool _autoPlayRequested = false;

    public bool IsActive { get { return _isActive; } }
    public int Steps { get { return _steps; } }
    public float DetectRealTime { get { return _detectRealTime; } }
    public bool Checked { get { return _checked; } }
    public bool AutoPlayRequested { get { return _autoPlayRequested; } }
    public bool ManualPreviewReady
    {
        get
        {
            return _requestChecked && !_autoPlayRequested && _detectRealTime < 0f;
        }
    }

    // 【Warmup 完成信号】skeleton 的 phase 0 入口用它做门,防止第 1 帧 fire
    // 导致 CUA PRE-CONTAMINATION。
    //   - _checked=false(前 3s 或标志刚找到前): false, 等检测完成
    //   - _checked=true 且 _detectRealTime<0 (未开 autoPlay): true, 立即放行
    //   - _checked=true 且 autoPlay 已激活 (_isActive=true): true
    //   - _checked=true 且 autoPlay 检测到但 CUA 尚未 ready: false
    public bool WarmupReady
    {
        get
        {
            if (!_checked) return false;
            if (_autoPlayRequested && !_isActive) return false;
            if (_detectRealTime < 0f) return true;
            return _isActive;
        }
    }

    // 【外部 incremenet 接口】CheckEventRules 在各 phase 入口里需要手动 +1
    public void IncrementSteps() { _steps++; }

    // ========================================================================
    // 【目标循环】
    //   _autoTargets: autoPlay 遍历的实体名列表（主文件在 Start 里 SetTargets 覆盖）
    //   _autoTargetIdx: 当前目标下标
    //   _autoTargetWait: 到达后的等待计时 (给 CUA observer 截图时间)
    // ========================================================================
    private string[] _autoTargets = new string[] { "CTAButton" }; // 保底：至少有 CTA
    private int _autoTargetIdx = 0;
    private float _autoTargetWait = 0f;
    private bool _awaitingPhaseProgress = false;
    private bool _progressObserved = false;
    private float _awaitProgressRealTime = -1f;
    private string _lastProgressPhase = "";

    // 【外部注入目标列表】主文件 Start 按 phase 顺序填入要路过的实体名。
    public void SetTargets(string[] targets)
    {
        if (targets != null && targets.Length > 0) _autoTargets = targets;
    }

    // 【到达回调】主文件注册一个处理器，AutoPlay 到达目标时调它分发 phase 副作用
    public System.Action<string> OnArrive;

    // 【phase 推进通知】skeleton 的 AddCompletedPhase() 在真实完成时调用它。
    // AutoPlay 只有看到阶段推进后才切下一个目标，避免一个轮询窗口吞掉多个 phase。
    public void NotifyPhaseProgress(string phaseId)
    {
        if (string.IsNullOrEmpty(phaseId)) return;
        if (_lastProgressPhase == phaseId) return;
        _lastProgressPhase = phaseId;
        if (!_awaitingPhaseProgress) return;
        _progressObserved = true;
    }

    private bool _inited = false;
    // 初始化自动播放目标列表、到达回调和阶段运行状态。
    public void Init()
    {
        if (_inited) return;
        _inited = true;
    }

    private void Awake()
    {
        if (_instance != null && _instance != this) { enabled = false; return; }
        _instance = this;
        Init();
    }

    // ========================================================================
    // 【激活检测】— 与 skeleton 契约绑死
    // Stage 1: 每帧 Find "__AUTOPLAY_ON__"，同时读取 WebGL URL 的 autoplay=1。
    //          URL 请求优先级高：只要明确请求 autoplay，就不能在 5s 后退回 interactive。
    //          realtime 5s 后仍未找到请求 → 放弃探测 (interactive 模式)
    //          注意用 Time.realtimeSinceStartup 不能用 gameTimer: CUA 2x/5x speed patch
    //          会让 gameTimer>3f 在 real t≈1.5s 就触发,此时 PlayCanvas 还没建好
    //          __AUTOPLAY_ON__ 实体 → 误判为 interactive → WarmupReady 立即放行 →
    //          Phase 0 在 CUA observer 开前就 fire → PRE-CONTAMINATION 永死。
    //          (2026-04-20 w7113b 烧了 3 次 CUA 就是这个根因)
    // Stage 2: 检测到后等待 "__CUA_OBSERVER_READY__" 握手，再激活 autoplay
    // Stage 1b: 即使 Stage 1 超时也继续轻探测 (up to realtime 15s),防止慢速
    //           WebGL init 导致错过 flag。late detect 依旧走 Stage 2 握手激活。
    // ========================================================================
    public void CheckActivation(float gameTimer)
    {
        DetectAutoPlayRequestFromUrl();

        // Stage 1：标志探测 (real time, 不受 speed patch 影响)
        if (!_isActive && !_checked)
        {
            if (_autoPlayRequested || GameObject.Find("__AUTOPLAY_ON__") != null)
            {
                _detectRealTime = Time.realtimeSinceStartup;
                _checked = true;
            }
            else if (Time.realtimeSinceStartup > 5.0f) _checked = true;
        }

        // Stage 1b: late-detect — 给 PlayCanvas 慢 init 留余量 (real 5-15s 仍探测)
        if (!_isActive && _checked && _detectRealTime < 0f && Time.realtimeSinceStartup < 15.0f)
        {
            if (_autoPlayRequested || GameObject.Find("__AUTOPLAY_ON__") != null)
            {
                _detectRealTime = Time.realtimeSinceStartup;
            }
        }

        // Stage 2：CUA 明确发出 observer-ready 后才允许 autoplay 起跑
        if (!_observerReady && _detectRealTime > 0f && GameObject.Find("__CUA_OBSERVER_READY__") != null)
        {
            _observerReady = true;
        }

        if (!_isActive && _detectRealTime > 0f && _observerReady)
        {
            _isActive = true;
        }
    }

    private void DetectAutoPlayRequestFromUrl()
    {
        if (_requestChecked) return;
        string url = Application.absoluteURL;
        if (string.IsNullOrEmpty(url)) return;
        _requestChecked = true;
        _autoPlayRequested = UrlHasQueryFlag(url, "autoplay=1")
            || UrlHasQueryFlag(url, "cuaAutoplay=1")
            || UrlHasQueryFlag(url, "cuaAutoPlay=1");
    }

    private bool UrlHasQueryFlag(string url, string flag)
    {
        if (string.IsNullOrEmpty(url) || string.IsNullOrEmpty(flag)) return false;
        return url.IndexOf("?" + flag) >= 0
            || url.IndexOf("&" + flag) >= 0
            || url.IndexOf("#" + flag) >= 0;
    }

    // ========================================================================
    // 【主循环】IsActive=true 时主 Update 每帧调一次。
    //   - 到达目标前：沿直线朝目标移动 + 相机 LookAt
    //   - 到达目标后：等 1.5s，切换下一个目标，调 OnArrive 触发副作用
    // ========================================================================
    public void Tick()
    {
        if (!_isActive) return;
        var player = GFM_Player.Instance;
        if (player == null || player.Go == null) return;

        // 到达后进入“等待 phase 推进”窗口：先留最短可视时长，再等 AddCompletedPhase 通知。
        if (_awaitingPhaseProgress)
        {
            FollowPlayerCamera();
            if (_autoTargetWait > 0f) { _autoTargetWait -= Time.deltaTime; return; }
            if (_progressObserved || (_awaitProgressRealTime > 0f && (Time.realtimeSinceStartup - _awaitProgressRealTime) >= 8f))
            {
                _awaitingPhaseProgress = false;
                _progressObserved = false;
                _awaitProgressRealTime = -1f;
                _autoTargetIdx++;
                _steps++;
            }
            return;
        }

        if (_autoTargetIdx >= _autoTargets.Length) _autoTargetIdx = 0;

        GameObject target = ResolveTarget(_autoTargets[_autoTargetIdx]);
        if (target == null || target.transform.position.y < -900f) { _autoTargetIdx++; return; }

        Vector3 dir = target.transform.position - player.Trans.position;
        dir.y = 0f;

        if (dir.magnitude > 1.0f)
        {
            // 还没到：直线移动 + 转向 + 相机跟随
            float speed = player.MoveSpeed * 1.2f;
            player.Trans.position = Vector3.MoveTowards(
                player.Trans.position, target.transform.position, speed * Time.deltaTime);
            FollowPlayerCamera();
            if (dir.magnitude > 0.1f)
            {
                player.Trans.rotation = Quaternion.Lerp(
                    player.Trans.rotation, Quaternion.LookRotation(dir), 5f * Time.deltaTime);
            }
            if (GFM_CameraController.Instance != null && GFM_CameraController.Instance.IsReady)
            {
                GFM_CameraController.Instance.LookAt(player.Trans.position);
            }
        }
        else
        {
            // 到了：先触发 phase 副作用，再等待真实 phase 推进信号切目标。
            _autoTargetWait = 1.5f;
            _awaitingPhaseProgress = true;
            _progressObserved = false;
            _awaitProgressRealTime = Time.realtimeSinceStartup;
            string arrivedTarget = _autoTargets[_autoTargetIdx];
            if (OnArrive != null) OnArrive(arrivedTarget);
        }
    }

    // 根据目标名解析当前可导航的场景物体。
    private GameObject ResolveTarget(string targetName)
    {
        if (string.IsNullOrEmpty(targetName)) return null;

        if (GameSceneCtrl.instance != null)
        {
            var mapped = GameSceneCtrl.instance.Get(targetName);
            if (mapped != null) return mapped;
        }

        return GameObject.Find(targetName);
    }

    private void FollowPlayerCamera()
    {
        if (GFM_CameraController.Instance == null || !GFM_CameraController.Instance.IsReady) return;
        var cam = GFM_CameraController.Instance.Main;
        float size = cam != null ? cam.orthographicSize : 8f;
        GFM_CameraController.Instance.FramePoint(GFM_Player.Instance.Trans.position, size);
    }
}
