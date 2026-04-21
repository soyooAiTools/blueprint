var { toLowerCamel } = require('../trigger-codegen.cjs');

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
      lines.push('        if (' + entity + ' != null && IsNear(' + entity + ', 2f) && Input.GetMouseButtonDown(0)) {');
      lines.push('            int cost = ' + c.cost + ';');
      lines.push('            if (gold >= cost) {');
      lines.push('                gold -= cost;');
      lines.push('                if (scoreText != null) scoreText.text = "gold: " + gold;');
      lines.push('                ' + entity + 'Done = true;');
      lines.push('                ' + entity + 'State = 2;');
      lines.push('                ' + entity + '.transform.position = new Vector3(' + entity + '.transform.position.x, ' + entity + '.transform.position.y + 2f, ' + entity + '.transform.position.z); // observable move — satisfies EntityAdvanced() phase-exit gate');
      lines.push('            }');
      lines.push('        }');
    } else {
      lines.push('        if (' + entity + ' != null && IsNear(' + entity + ', 2f) && Input.GetMouseButtonDown(0)) {');
      lines.push('            ' + entity + 'Done = true;');
      lines.push('            ' + entity + 'State = 2;');
      lines.push('            ' + entity + '.transform.position = new Vector3(' + entity + '.transform.position.x, ' + entity + '.transform.position.y + 2f, ' + entity + '.transform.position.z); // observable move — satisfies EntityAdvanced() phase-exit gate');
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
