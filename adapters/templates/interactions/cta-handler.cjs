var { toLowerCamel } = require('../trigger-codegen.cjs');

function findCTAEntity(schema) {
  var entities = schema.entities || [];
  for (var i = 0; i < entities.length; i++) {
    if (entities[i].name.toUpperCase().indexOf('CTA') !== -1) {
      return entities[i].name;
    }
  }
  return null;
}

function generateCTAHandler(schema) {
  var ctaName = findCTAEntity(schema);
  if (!ctaName) return '';

  var entity = toLowerCamel(ctaName);
  var lines = [];
  lines.push('        if (' + entity + ' != null && IsNear(' + entity + ', 3f) && Input.GetMouseButtonDown(0)) {');
  lines.push('            ' + entity + 'Done = true;');
  lines.push('            ' + entity + 'State = 2;');
  lines.push('            ShowCTA();');
  lines.push('        }');
  return lines.join('\n');
}

function generateCTAVariables(schema) {
  return '';
}

module.exports = { generateCTAHandler: generateCTAHandler, generateCTAVariables: generateCTAVariables };
