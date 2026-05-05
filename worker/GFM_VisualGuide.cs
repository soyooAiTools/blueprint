// ============================================================================
// GFM_VisualGuide.cs — phase 目标提示 (2026-05-05 简化版)
// ----------------------------------------------------------------------------
// 历史：2026-05-04 引入黄色菱形(player) + 青色菱形(target) + 上下浮动 + 缩放脉冲;
//      2026-05-05 用户反馈"菱形/三角形玩家标识噪音过大、目的地虚线引导分散注意力",
//      改为 no-op stub —— 由 GFM_UI.AddWorldLabel(entity, 中文名, 0f) 在实体中心
//      渲染文字标签,玩家通过文字 + entity 颜色 + phase guideText 提示就够了。
//
// 保留这份文件而不是删除,是为了向下兼容 phase-init.cjs 和 skeleton-generator.cjs
// 已经 emit 的 GFM_VisualGuide.MarkPlayer / HighlightTarget / Tick 调用,这样老项目
// 重新打包不需要改 codegen,新项目也不会因找不到符号 build 失败。
//
// 调用方:
//   Start()  : GFM_VisualGuide.MarkPlayer(player)            ← skeleton 注入,no-op
//   Update() : GFM_VisualGuide.Tick()                         ← skeleton 注入,no-op
//   每个 phase enter : GFM_VisualGuide.HighlightTarget(target) ← phase-init 注入,no-op
// ============================================================================

using UnityEngine;

public static class GFM_VisualGuide
{
    public static void MarkPlayer(GameObject player) { }
    public static void HighlightTarget(GameObject target) { }
    public static void Tick() { }
}
