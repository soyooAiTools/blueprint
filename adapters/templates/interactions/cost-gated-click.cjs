var { toLowerCamel } = require('../trigger-codegen.cjs');
var { resourceIdExpr } = require('../resource-ids.cjs');

function escapeString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findCostClicks(schema) {
  var phases = schema.phases || [];
  var clicks = [];
  for (var i = 0; i < phases.length; i++) {
    var trigger = phases[i].trigger;
    var cost = phases[i].cost;
    if (trigger && trigger.type === 'click_entity' && trigger.entity) {
      clicks.push({
        entity: trigger.entity,
        cost: cost ? cost.amount : 0,
        costResource: cost ? cost.resource : 'gold'
      });
    }
  }
  return clicks;
}

function generateCostClickUpdate(schema) {
  var clicks = findCostClicks(schema);
  if (clicks.length === 0) return '';

  var lines = [];
  for (var i = 0; i < clicks.length; i++) {
    var c = clicks[i];
    var entity = toLowerCamel(c.entity);
    if (c.cost > 0) {
      lines.push('        // Paid-click gate: entity must be reachable and tapped before spending the resource cost.');
      lines.push('        if (' + entity + ' != null && IsNear(' + entity + ', 2f) && Input.GetMouseButtonDown(0)) {');
      lines.push('            int cost = ' + c.cost + ';');
      lines.push('            // Cost gate: spend only when the canonical economy manager has enough resource.');
      lines.push('            if (TrySpend(' + resourceIdExpr(c.costResource || 'gold') + ', cost)) {');
      lines.push('                if (scoreText != null) scoreText.text = "' + escapeString(c.costResource || 'gold') + ': " + GetResource(' + resourceIdExpr(c.costResource || 'gold') + ');');
      lines.push('                ' + entity + 'Done = true;');
      lines.push('                ' + entity + 'State = 2;');
      lines.push('                var ' + entity + 'Pos = ' + entity + '.transform.position;');
      lines.push('                ' + entity + 'Pos.y += 2f; // observable move — satisfies EntityAdvanced() phase-exit gate');
      lines.push('                ' + entity + '.transform.position = ' + entity + 'Pos;');
      lines.push('            }');
      lines.push('        }');
    } else {
      lines.push('        // Free-click gate: entity must be reachable and tapped before advancing its state.');
      lines.push('        if (' + entity + ' != null && IsNear(' + entity + ', 2f) && Input.GetMouseButtonDown(0)) {');
      lines.push('            ' + entity + 'Done = true;');
      lines.push('            ' + entity + 'State = 2;');
      lines.push('            var ' + entity + 'Pos = ' + entity + '.transform.position;');
      lines.push('            ' + entity + 'Pos.y += 2f; // observable move — satisfies EntityAdvanced() phase-exit gate');
      lines.push('            ' + entity + '.transform.position = ' + entity + 'Pos;');
      lines.push('        }');
    }
    if (i < clicks.length - 1) lines.push('');
  }
  return lines.join('\n');
}

function generateCostClickVariables(schema) {
  return '';
}

module.exports = { generateCostClickUpdate: generateCostClickUpdate, generateCostClickVariables: generateCostClickVariables };
