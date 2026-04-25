var { resourceIdExpr } = require('../resource-ids.cjs');

function escapeString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function generateScoreDisplay(schema) {
  var resources = schema.resources || [];
  if (resources.length === 0) return '';

  var lines = [];
  lines.push('        if (scoreText != null) {');
  lines.push('            string display = "";');
  for (var i = 0; i < resources.length; i++) {
    var r = resources[i];
    lines.push('            display += "' + escapeString(r.name) + ': " + GetResource(' + resourceIdExpr(r.name) + ') + "  ";');
  }
  lines.push('            // Score HUD gate: update Unity UI only when the composed resource text changes.');
  lines.push('            if (_lastScoreText != display) { scoreText.text = display; _lastScoreText = display; }');
  lines.push('        }');
  return lines.join('\n');
}

function generateScoreVariables(schema) {
  return '';
}

module.exports = { generateScoreDisplay: generateScoreDisplay, generateScoreVariables: generateScoreVariables };
