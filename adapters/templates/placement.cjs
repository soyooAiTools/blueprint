/**
 * Generates entity initialization code for Start() method.
 * Input: schema.entities[], schema.gameConfig
 * Output: C# lines for TODO_START section
 */
var { toLowerCamel } = require('./trigger-codegen.cjs');

function generatePlacement(schema) {
  var lines = [];
  var entities = schema.entities || [];
  if (entities.length > 0) {
    lines.push('        // Entity refs are already bound by RegisterEntityBindings()/RefreshEntityReferences().');
    lines.push('        HideAllBoundEntities();');
  }
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var varName = toLowerCamel(e.name);
    // Initial position — hide off-screen if not shown at start
    if (e.showInPhase === 'start') {
      lines.push('        PlaceObj(' + varName + ', ' + e.initPos[0] + 'f, ' + e.initPos[1] + 'f, ' + e.initPos[2] + 'f);');
      if (e.scale && e.scale !== 1.0) {
        lines.push('        SetScale(' + varName + ', ' + e.scale + 'f);');
      }
    }
  }
  // NOTE: Camera background and ground color handled via in-place regex
  // replacement in replaceAllTodos() colorOverrides — NOT generated here.
  // This avoids duplicate assignments (skeleton already has hardcoded Color lines).
  return lines.join('\n');
}

/**
 * Returns color overrides for in-place regex replacement by replaceAllTodos().
 */
function getColorOverrides(schema) {
  var overrides = {};
  var bg = schema.gameConfig.cameraBackground;
  if (bg) {
    overrides.cameraBackground = 'new Color(' + bg[0] + 'f, ' + bg[1] + 'f, ' + bg[2] + 'f)';
  }
  var gc = schema.gameConfig.groundColor;
  if (gc) {
    overrides.groundColor = 'new Color(' + gc[0] + 'f, ' + gc[1] + 'f, ' + gc[2] + 'f)';
  }
  return overrides;
}

module.exports = { generatePlacement: generatePlacement, getColorOverrides: getColorOverrides };
