// ============================================================================
// AudioManager.cs — 音频 Manager（反馈 01 #8 架构图命名 alias）
// ----------------------------------------------------------------------------
// 客户反馈 #8 的架构图明确把声音管理叫 `AudioManager`(单例基类下挂载)。
// 历史代码用 `GFM_Audio` 静态工具类已经被多处引用,直接改名会全链路炸。
// 因此 AudioManager 是一层零开销 alias:
//   - 调用方写 `AudioManager.Instance.PlayBGM(clip)` / `PlaySFX(clip)`
//   - 内部全部转发到 `GFM_Audio` 已有的静态实现
//   - 旧代码继续用 `GFM_Audio.instance.PlayBGM(clip)` 也能跑
//
// 为什么不用 GFM_SingletonBase<AudioManager>:
//   - GFM_Audio 已经持有真正的 AudioSource 引用,Manager 化等于双重所有权
//   - 这层只做命名统一,不引入新的 MonoBehaviour 实例
//
// 反馈 01 #8 架构图位置:单例基类 → AudioManager(声音管理)。
// ============================================================================

using UnityEngine;

public sealed class AudioManager
{
    // ------------------------------------------------------------------------
    // 【单例入口】懒初始化。本身不挂 GameObject,真正的 AudioSource 在 GFM_Audio。
    // ------------------------------------------------------------------------
    private static AudioManager _instance;
    public static AudioManager Instance
    {
        get
        {
            if (_instance == null) _instance = new AudioManager();
            return _instance;
        }
    }

    private AudioManager() { }

    // ------------------------------------------------------------------------
    // 【初始化】内部转发到 GFM_Audio.Init,创建 BGM + SFX 两个 AudioSource。
    // ------------------------------------------------------------------------
    public void Init(GameObject parent)
    {
        GFM_Audio.Init(parent);
    }

    // 【播放/切换 BGM】循环播放,Mute 状态下不会真的发声。
    public void PlayBGM(AudioClip clip)
    {
        if (GFM_Audio.instance == null) return;
        GFM_Audio.instance.PlayBGM(clip);
    }

    // 【停止 BGM】仅停止当前背景音乐,不影响 SFX。
    public void StopBGM()
    {
        if (GFM_Audio.instance == null) return;
        GFM_Audio.instance.StopBGM();
    }

    // 【一次性音效】PlayOneShot,不打断 BGM,Mute 时跳过。
    public void PlaySFX(AudioClip clip)
    {
        if (GFM_Audio.instance == null) return;
        GFM_Audio.instance.PlaySFX(clip);
    }

    // 【按音高播放音效】index 决定半音偏移,常用于连续点击的音阶反馈。
    public void PlayPitch(AudioClip clip, int index)
    {
        if (GFM_Audio.instance == null) return;
        GFM_Audio.instance.PlayPitch(clip, index);
    }

    // 【全局静音切换】同时影响 BGM 和 SFX,通过 AudioListener.volume 实现。
    public void SetMute(bool mute)
    {
        if (GFM_Audio.instance == null) return;
        GFM_Audio.instance.SetMute(mute);
    }
}
