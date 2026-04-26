// ============================================================================
// GFM_SingletonBase.cs — 单例基类（反馈 01 #1 架构图）
// ----------------------------------------------------------------------------
// 职责：所有 GFM_*Manager / Controller 走统一的懒加载单例。
//       - 第一次访问 Instance 时自动 new GameObject + AddComponent
//       - Awake 检测重复实例:不是 _instance 时 enabled=false 防抢占(不 Destroy,
//         保留对象方便调试，与 Luna / WebGL 平台兼容)
//       - 单例存活期间 transform 挂到 root 下,场景切换会随场景销毁
//
// 使用方式：
//     public class GFM_FooManager : GFM_SingletonBase<GFM_FooManager>
//     {
//         protected override void OnInit() { /* 初始化逻辑 */ }
//     }
//     调用方:GFM_FooManager.Instance.DoSomething();
//
// ⚠️ 子类如果一定要覆盖 Awake(不推荐),必须先调 base.Awake()——否则
//    _instance 不会注册、OnInit 不会触发、duplicate-disable 也跑不到。
//    99% 的初始化逻辑放 OnInit 就够,不需要碰 Awake。
//
// 反馈 01 #1 架构图明确要求 "代码需要按照这个结构来生成" — 单例基类是树根。
// 所有 Manager 都应继承此类,而不是各自维护一份 static Instance 字段。
// ============================================================================

using UnityEngine;

public abstract class GFM_SingletonBase<T> : MonoBehaviour where T : GFM_SingletonBase<T>
{
    private static T _instance;
    private static bool _quitting = false;

    // 【单例入口】懒初始化。不存在时自动 new GameObject 挂上,首次访问即可用。
    public static T Instance
    {
        get
        {
            if (_quitting) return null; // 应用退出阶段不再创建,避免 GameObject leak
            if (_instance == null)
            {
                var obj = new GameObject(typeof(T).Name);
                _instance = obj.AddComponent<T>();
            }
            return _instance;
        }
    }

    // 子类可以判断是否已初始化,避免在 Awake 顺序未到时触发懒创建。
    public static bool HasInstance { get { return _instance != null; } }

    protected virtual void Awake()
    {
        if (_instance != null && _instance != this)
        {
            // 重复实例:不 Destroy(防 Luna/WebGL 平台问题),仅 disable。
            enabled = false;
            return;
        }
        _instance = (T)this;
        OnInit();
    }

    protected virtual void OnApplicationQuit()
    {
        _quitting = true;
    }

    // 子类覆写做初始化;默认空实现。基类已确保此时 Instance 可用。
    protected virtual void OnInit() { }
}
