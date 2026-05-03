var { toLowerCamel } = require('../trigger-codegen.cjs');
var { resourceIdExpr } = require('../resource-ids.cjs');

function escapeString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findDeliveryTargets(schema) {
  var phases = schema.phases || [];
  var targets = [];
  for (var i = 0; i < phases.length; i++) {
    var trigger = phases[i].trigger;
    if (trigger && trigger.type === 'entity_state_reached' && trigger.entity) {
      targets.push({
        entity: trigger.entity,
        goldPerUnit: trigger.goldPerUnit || 10
      });
    }
  }
  return targets;
}

function generateDeliverUpdate(schema) {
  var resources = schema.resources || [];
  var targets = findDeliveryTargets(schema);
  if (resources.length === 0 || targets.length === 0) return '';

  var lines = [];
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var entity = toLowerCamel(t.entity);
    var resName = resources.length > 0 ? resources[0].name : 'resource';
    lines.push('        // Delivery gate: player must stand near the target before inventory can be exchanged.');
    lines.push('        if (' + entity + ' != null && IsNear(' + entity + ', 2f)) {');
    lines.push('            int count = GetResource(' + resourceIdExpr(resName) + ');');
    lines.push('            // Sell gate: only convert resources after confirming a positive count and successful spend.');
    lines.push('            if (count > 0 && TrySpend(' + resourceIdExpr(resName) + ', count)) {');
    lines.push('                AddGold(' + t.goldPerUnit + ' * count);');
    lines.push('                ' + entity + 'Done = true;');
    lines.push('                ' + entity + 'State = 2;');
    lines.push('                // 2026-05-04: Bobble 替代直接 +2y SetPosition,目标实体短暂上跳再落回,');
    lines.push('                // 不再永久挂在天上。EntityAdvanced 在峰值瞬间触发即可。');
    lines.push('                GFM_SmoothMover.Bobble(' + entity + ', 2f, 0.6f); // observable move — satisfies EntityAdvanced() phase-exit gate');
    lines.push('                ShowFloatingText(player != null ? player.transform.position : Vector3.zero, "+" + (' + t.goldPerUnit + ' * count) + " coins", Color.yellow);');
    lines.push('            }');
    lines.push('        }');
    if (i < targets.length - 1) lines.push('');
  }
  return lines.join('\n');
}

function generateDeliverVariables(schema) {
  return '';
}

module.exports = { generateDeliverUpdate: generateDeliverUpdate, generateDeliverVariables: generateDeliverVariables };
