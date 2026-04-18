// ============================================================
// GFM_Audio.cs — 音频管理器
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;

public class GFM_Audio : MonoBehaviour
{
    public static GFM_Audio instance;

    private AudioSource _bgmSource;
    private AudioSource _sfxSource;
    private bool _muted = false;

    public static GFM_Audio Init(GameObject parent)
    {
        if (instance != null) return instance;
        var obj = new GameObject("GFM_Audio");
        obj.transform.SetParent(parent.transform);
        instance = obj.AddComponent<GFM_Audio>();

        instance._bgmSource = obj.AddComponent<AudioSource>();
        instance._bgmSource.loop = true;
        instance._bgmSource.playOnAwake = false;

        instance._sfxSource = obj.AddComponent<AudioSource>();
        instance._sfxSource.loop = false;
        instance._sfxSource.playOnAwake = false;

        return instance;
    }

    public void PlayBGM(AudioClip clip)
    {
        if (clip == null || _bgmSource == null) return;
        _bgmSource.clip = clip;
        if (!_muted) _bgmSource.Play();
    }

    public void StopBGM()
    {
        if (_bgmSource != null) _bgmSource.Stop();
    }

    public void PlaySFX(AudioClip clip)
    {
        if (clip == null || _sfxSource == null || _muted) return;
        _sfxSource.PlayOneShot(clip);
    }

    public void PlayPitch(AudioClip clip, int index)
    {
        if (clip == null || _sfxSource == null || _muted) return;
        float[] offset = new float[] { 2f, 2f, 1f, 2f, 2f, 2f, 1f, 2f, 2f, 1f };
        if (index >= offset.Length) index = index % offset.Length;
        float add = 0;
        for (int i = 0; i < index; i++) add += offset[i];
        _sfxSource.pitch = Mathf.Pow(2f, add / 12f);
        _sfxSource.clip = clip;
        _sfxSource.Play();
    }

    public void SetMute(bool mute)
    {
        _muted = mute;
        AudioListener.volume = mute ? 0f : 1f;
    }
}
