var { toLowerCamel, hasEntityRef } = require('../trigger-codegen.cjs');
var { resourceIdExpr } = require('../resource-ids.cjs');

function escapeString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findExtraSources(schema) {
  var resources = schema.resources || [];
  var entities = schema.entities || [];
  var groups = [];

  for (var i = 0; i < resources.length; i++) {
    var baseName = resources[i].entity;
    if (!hasEntityRef(baseName)) continue;
    var extras = [];
    for (var j = 0; j < entities.length; j++) {
      var eName = entities[j].name;
      if (!hasEntityRef(eName)) continue;
      if (eName !== baseName && eName.indexOf(baseName) === 0) {
        extras.push(eName);
      }
    }
    if (extras.length > 0) {
      groups.push({
        resourceName: resources[i].name,
        primaryEntity: baseName,
        extraEntities: extras
      });
    }
  }
  return groups;
}

function generateMultiSourceCollect(schema) {
  var groups = findExtraSources(schema);
  if (groups.length === 0) return '';

  var gc = schema.gameConfig || {};
  var collectRange = gc.collectRange || 2;
  var maxCarry = gc.maxCarry || 10;

  var lines = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    for (var j = 0; j < g.extraEntities.length; j++) {
      if (!hasEntityRef(g.primaryEntity) || !hasEntityRef(g.extraEntities[j])) continue;
      var entity = toLowerCamel(g.extraEntities[j]);
      var primary = toLowerCamel(g.primaryEntity);
      lines.push('        // Collect from alternate source only when it is visible and within range.');
      lines.push('        if (' + entity + ' != null && IsNear(' + entity + ', ' + collectRange + 'f)) {');
      lines.push('            // Keep total "' + escapeString(g.resourceName) + '" below maxCarry before adding one unit.');
      lines.push('            if (GetResource(' + resourceIdExpr(g.resourceName) + ') < ' + maxCarry + ') {');
      lines.push('                AddResource(' + resourceIdExpr(g.resourceName) + ', 1);');
      lines.push('                ' + primary + 'Done = true;');
      lines.push('            }');
      lines.push('        }');
      if (j < g.extraEntities.length - 1 || i < groups.length - 1) lines.push('');
    }
  }
  return lines.join('\n');
}

function hasGameObjectDeclaration(skeleton, entityName) {
  if (!skeleton || !entityName) return false;
  var escaped = String(entityName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\bGameObject\\s+' + escaped + '\\s*;').test(String(skeleton));
}

function generateMultiSourceVariables(schema, skeleton) {
  var groups = findExtraSources(schema);
  if (groups.length === 0) return '';

  var lines = [];
  for (var i = 0; i < groups.length; i++) {
    var extras = groups[i].extraEntities;
    for (var j = 0; j < extras.length; j++) {
      if (!hasEntityRef(extras[j])) continue;
      var variableName = toLowerCamel(extras[j]);
      if (hasGameObjectDeclaration(skeleton, variableName)) continue;
      lines.push('    GameObject ' + variableName + '; // alternate collect source mapped from entity "' + extras[j] + '"');
    }
  }
  return lines.join('\n');
}

module.exports = {
  generateMultiSourceCollect: generateMultiSourceCollect,
  generateMultiSourceVariables: generateMultiSourceVariables,
  _internals: {
    findExtraSources: findExtraSources,
    hasGameObjectDeclaration: hasGameObjectDeclaration
  }
};
