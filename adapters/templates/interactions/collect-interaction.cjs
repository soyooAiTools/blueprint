var { toLowerCamel } = require('../trigger-codegen.cjs');

function escapeString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function generateCollectUpdate(schema) {
  var resources = schema.resources || [];
  var gc = schema.gameConfig || {};
  var collectRange = gc.collectRange || 2;
  var maxCarry = gc.maxCarry || 10;
  if (resources.length === 0) return '';

  var lines = [];
  for (var i = 0; i < resources.length; i++) {
    var r = resources[i];
    var entity = toLowerCamel(r.entity);
    var cap = r.maxStock || maxCarry;
    lines.push('        if (_collectCooldown <= 0f && ' + entity + ' != null && IsNear(' + entity + ', ' + collectRange + 'f)) {');
    lines.push('            if (GetResource("' + escapeString(r.name) + '") < ' + cap + ') {');
    lines.push('                AddResource("' + escapeString(r.name) + '", 1);');
    lines.push('                _collectCooldown = collectCooldownInterval;');
    lines.push('                ' + entity + 'Done = true;');
    lines.push('            }');
    lines.push('        }');
    if (i < resources.length - 1) lines.push('');
  }
  return lines.join('\n');
}

function generateCollectVariables(schema) {
  return '';
}

module.exports = { generateCollectUpdate: generateCollectUpdate, generateCollectVariables: generateCollectVariables };
