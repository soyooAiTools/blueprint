// ============================================================
// GFM_Utils.cs — 通用工具方法
// 由 GFM_Tools.cs 拆分，AI 编码时直接调用，不要重定义
// Luna 兼容：无泛型、无 coroutine、无 C#7.0+ 语法、无 LINQ
// ============================================================

using UnityEngine;
using UnityEngine.UI;
using System.Collections.Generic;

public static class GFM_Utils
{
    public static bool IsInRange(float distance, Vector3 a, Vector3 b, bool includeY)
    {
        Vector3 va = new Vector3(a.x, includeY ? a.y : 0, a.z);
        Vector3 vb = new Vector3(b.x, includeY ? b.y : 0, b.z);
        return Vector3.Distance(va, vb) < distance;
    }

    public static bool IsOnScreen(Transform obj)
    {
        if (obj == null || Camera.main == null) return false;
        Vector3 sp = Camera.main.WorldToScreenPoint(obj.position);
        return sp.x >= 0 && sp.x <= Screen.width && sp.y >= 0 && sp.y <= Screen.height && sp.z > 0;
    }

    public static bool IsPlayingAnim(Animator animator, string name)
    {
        if (animator == null) return false;
        return animator.GetCurrentAnimatorStateInfo(0).IsName(name);
    }

    public static bool RectsOverlap(Vector2 min1, Vector2 max1, Vector2 min2, Vector2 max2)
    {
        return !(min1.x > max2.x || max1.x < min2.x || min1.y > max2.y || max1.y < min2.y);
    }

    public static Vector2 WorldToUI(Vector3 worldPos, RectTransform canvasRect)
    {
        if (Camera.main == null) return Vector2.zero;
        Vector3 sp = Camera.main.WorldToScreenPoint(worldPos);
        Vector3 norm = new Vector3(sp.x / Screen.width, sp.y / Screen.height, sp.z);
        return new Vector2(
            norm.x * canvasRect.sizeDelta.x - canvasRect.sizeDelta.x * 0.5f,
            norm.y * canvasRect.sizeDelta.y - canvasRect.sizeDelta.y * 0.5f
        );
    }

    public static void UpdateOffScreenIndicator(Transform target, RectTransform indicator, Camera cam)
    {
        if (target == null || indicator == null || cam == null) return;
        Vector3 sp = cam.WorldToScreenPoint(target.position);
        bool offScreen = sp.x < 0 || sp.x > Screen.width || sp.y < 0 || sp.y > Screen.height || sp.z < 0;
        if (offScreen)
        {
            indicator.gameObject.SetActive(true);
            Vector3 clamped = sp;
            clamped.x = Mathf.Clamp(sp.x, 0, Screen.width);
            clamped.y = Mathf.Clamp(sp.y, 0, Screen.height);
            Vector3 dir = clamped - new Vector3(Screen.width / 2, Screen.height / 2);
            indicator.position = clamped;
            indicator.rotation = Quaternion.Euler(0, 0, Mathf.Atan2(dir.y, dir.x) * Mathf.Rad2Deg);
        }
        else
        {
            indicator.gameObject.SetActive(false);
        }
    }

    public static GameObject FindClosestByTag(Vector3 origin, string tag, float maxDist)
    {
        GameObject[] objs = GameObject.FindGameObjectsWithTag(tag);
        GameObject closest = null;
        float minDist = maxDist * maxDist;
        for (int i = 0; i < objs.Length; i++)
        {
            if (objs[i] == null || !objs[i].activeInHierarchy) continue;
            float d = (objs[i].transform.position - origin).sqrMagnitude;
            if (d < minDist) { minDist = d; closest = objs[i]; }
        }
        return closest;
    }

    public static Transform FindClosestInList(List<Transform> targets, Vector3 origin)
    {
        if (targets == null) return null;
        Transform closest = null;
        float minDist = Mathf.Infinity;
        for (int i = 0; i < targets.Count; i++)
        {
            if (targets[i] == null || !targets[i].gameObject.activeInHierarchy) continue;
            float d = (targets[i].position - origin).sqrMagnitude;
            if (d < minDist) { minDist = d; closest = targets[i]; }
        }
        return closest;
    }

    public static List<Vector3> GenerateCirclePositions(int rings, int pointsPerRing, float radiusStep, int pointIncrement)
    {
        List<Vector3> points = new List<Vector3>();
        int pts = pointsPerRing;
        for (int i = 0; i < rings; i++)
        {
            float radius = (i + 1) * radiusStep;
            for (int j = 0; j < pts; j++)
            {
                float angle = 2 * Mathf.PI / pts * j;
                points.Add(new Vector3(radius * Mathf.Cos(angle), 0, radius * Mathf.Sin(angle)));
            }
            pts += pointIncrement;
        }
        return points;
    }

    public static void SetNumberDisplay(Transform parent, List<Sprite> numSprites, int number)
    {
        if (parent == null || numSprites == null) return;
        char[] chars = number.ToString().ToCharArray();
        for (int i = 0; i < parent.childCount; i++)
            parent.GetChild(i).gameObject.SetActive(false);
        for (int i = 0; i < chars.Length && i < parent.childCount; i++)
        {
            int digit = int.Parse(chars[i].ToString());
            if (digit >= numSprites.Count) continue;
            var child = parent.GetChild(i);
            child.gameObject.SetActive(true);
            var img = child.GetComponent<Image>();
            if (img != null)
            {
                img.sprite = numSprites[digit];
                img.rectTransform.sizeDelta = new Vector2(img.sprite.rect.width, img.sprite.rect.height);
            }
            else
            {
                var sr = child.GetComponent<SpriteRenderer>();
                if (sr != null) sr.sprite = numSprites[digit];
            }
        }
    }
}
