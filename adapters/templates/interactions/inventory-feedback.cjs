function escapeString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function generateInventoryFeedback(schema) {
  var resources = schema.resources || [];
  var gc = schema.gameConfig || {};
  var maxCarry = gc.maxCarry || 10;
  if (resources.length === 0) return '';

  var lines = [];
  for (var i = 0; i < resources.length; i++) {
    var r = resources[i];
    var cap = r.maxStock || maxCarry;
    lines.push('        // Full-inventory gate: show delivery guidance when the carried resource reaches capacity.');
    lines.push('        if (GetResource("' + escapeString(r.name) + '") >= ' + cap + ') {');
    lines.push('            if (guideText != null) guideText.text = "' + escapeString(r.name) + ' full! Deliver to continue.";');
    lines.push('        }');
    if (i < resources.length - 1) lines.push('');
  }
  return lines.join('\n');
}

function generateInventoryVariables(schema) {
  return '';
}

module.exports = { generateInventoryFeedback: generateInventoryFeedback, generateInventoryVariables: generateInventoryVariables };
