// GFM_ResourceIds.cs — canonical resource id helpers.
// Resource ids are runtime state keys; normalize before inventory reads/writes.

public static class GFM_ResourceIds
{
    public const string Gold = "Gold";
    public const string RocketDebris = "RocketDebris";

    // 把外部传入的资源名统一映射为规范资源 ID。
    public static string Normalize(string id)
    {
        if (id == null) return "";
        string trimmed = id.Trim();
        string lower = trimmed.ToLower();
        if (lower == "gold") return Gold;
        if (lower == "rocketdebris") return RocketDebris;
        return trimmed;
    }
}
