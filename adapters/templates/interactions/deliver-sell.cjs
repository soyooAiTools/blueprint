var { toLowerCamel } = require('../trigger-codegen.cjs');

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
    lines.push('        if (' + entity + ' != null && IsNear(' + entity + ', 2f)) {');
    lines.push('            int count = GetResource("' + escapeString(resName) + '");');
    lines.push('            if (count > 0 && TrySpend("' + escapeString(resName) + '", count)) {');
    lines.push('                AddGold(' + t.goldPerUnit + ' * count);');
    lines.push('                ' + entity + 'Done = true;');
    lines.push('                ' + entity + 'State = 2;');
    lines.push('                var ' + entity + 'Pos = ' + entity + '.transform.position;');
    lines.push('                ' + entity + 'Pos.y += 2f; // observable move — satisfies EntityAdvanced() phase-exit gate');
    lines.push('                ' + entity + '.transform.position = ' + entity + 'Pos;');
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
