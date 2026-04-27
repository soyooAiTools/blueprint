/**
 * Converts customLogic[] entries → TODO comment blocks for Claude Code to fill.
 *
 * 2026-04-27 finding-#1 fix: per-item semantic suppression. Pre-existing
 * suppressCustomLogicWhenAssemblyCovered() in codegen-schema.cjs is all-or-nothing:
 * either every item is dropped (full assembly coverage) or every item is kept
 * (any gap). In practice that left TODO_CUSTOM noise full of items that overlap
 * 1:1 with templated coverage (collect/deliver/cost-click/form-switch/score/cta,
 * NPC behaviors, economy resource flow, skeleton phase evidence). The AI then
 * either re-implements them — duplicating skeleton behavior — or wastes tokens
 * deciding to skip. Filter these out *per item* before emitting TODOs.
 */

// Keyword groups: when ALL keywords in a group appear in a customLogic item,
// the item is presumed covered by the listed template. Conservative — false
// negatives (item kept that could have been suppressed) are safe; false
// positives (suppressing an item that has unique logic) are NOT, so each group
// requires multiple co-occurring keywords to fire.
var TEMPLATE_COVERAGE = [
  // form-auto-switch.cjs handles entity-state-driven model swaps
  { template: 'form-auto-switch', any: [['形态', '切换'], ['形态', '升级'], ['形态', '隐藏', '显示'], ['升级序列']] },
  // collect-interaction.cjs / multi-source-collect.cjs handle proximity collection
  { template: 'collect-interaction', any: [['接近', '采集'], ['接近', '收集'], ['吸附', '资源'], ['碰撞', '收集'], ['碰撞', '采集']] },
  // cost-gated-click.cjs handles tap+cost gates
  { template: 'cost-gated-click', any: [['点击', '消耗'], ['点击', '金币', '建造'], ['点击', '金币', '升级'], ['消耗', '金币', '建造'], ['消耗', '金币', '升级']] },
  // deliver-sell.cjs handles inventory→reward conversion
  { template: 'deliver-sell', any: [['售卖', '金币'], ['交付', '资源'], ['转换', '金币']] },
  // economy.cjs / resource-flow.cjs handle resource accumulation
  { template: 'economy', any: [['初始资源', '为0'], ['资源', '累积']] },
  // skeleton's RecordPhaseEvidenceFlag emits CUA evidence automatically
  { template: 'skeleton-phase-evidence', any: [['CUA证据'], ['phaseEvidence'], ['variables.evidence'], ['证据信号']] },
  // NPC chase_attack/static_target behaviors handle enemy combat
  { template: 'npc-behavior', any: [['敌人', '攻击', '移动'], ['敌方', '移动', '攻击'], ['敌人', '靠近', '攻击']] },
  // spawner template handles enemy/resource drops
  { template: 'npc-spawner', any: [['击杀', '掉落'], ['击败', '掉落'], ['死亡', '掉落']] },
];

function isCoveredByTemplate(text) {
  var s = String(text || '');
  if (!s) return null;
  for (var i = 0; i < TEMPLATE_COVERAGE.length; i++) {
    var entry = TEMPLATE_COVERAGE[i];
    for (var j = 0; j < entry.any.length; j++) {
      var kws = entry.any[j];
      var allHit = true;
      for (var k = 0; k < kws.length; k++) {
        if (s.indexOf(kws[k]) < 0) { allHit = false; break; }
      }
      if (allHit) return entry.template;
    }
  }
  return null;
}

function generateCustomTodos(schema) {
  var custom = schema && Array.isArray(schema.customLogic) ? schema.customLogic : [];
  if (custom.length === 0) return '';

  var kept = [];
  var suppressed = [];
  for (var i = 0; i < custom.length; i++) {
    var item = custom[i];
    var coveredBy = isCoveredByTemplate(item);
    if (coveredBy) {
      suppressed.push({ item: item, by: coveredBy });
    } else {
      kept.push(item);
    }
  }

  // Annotate schema so codegen-schema.cjs metric/log can report per-item suppression
  // alongside the existing all-or-nothing suppression metric.
  if (suppressed.length > 0) {
    schema._customLogicPerItemSuppressed = suppressed;
  }

  if (kept.length === 0) return '';
  var lines = [];
  for (var n = 0; n < kept.length; n++) {
    lines.push('        // TODO_CUSTOM_' + (n + 1) + ': ' + kept[n]);
  }
  return lines.join('\n');
}

module.exports = {
  generateCustomTodos: generateCustomTodos,
  isCoveredByTemplate: isCoveredByTemplate,
};
