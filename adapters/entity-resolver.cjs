/**
 * Entity Resolver — Map spec entity names to pool objects before skeleton generation
 *
 * Bridges the gap between abstract entity names in specs (e.g. "bulletMaker")
 * and physical pool objects in the scene (e.g. "__Pool_Cube_Brown_03").
 *
 * Must run after spec-extract and before skeleton-gen / codegen.
 */

var promptV5 = require('../worker/prompt-v5-basetemplate.js');

/**
 * Resolve entity names from specs to pool object names
 * @param {Array} specs - Phase specs from spec-extractor
 * @param {Array} blueprintEntities - blueprint.entities array (if exists)
 * @returns {object} { entityPoolMap: {name: poolName}, resolvedSpecs: specs with poolName added }
 */
function resolveEntities(specs, blueprintEntities) {
  // Collect all unique entity names from specs
  var specEntities = {};
  for (var i = 0; i < specs.length; i++) {
    var ents = specs[i].entitiesRequired || [];
    for (var j = 0; j < ents.length; j++) {
      if (ents[j].name && !specEntities[ents[j].name]) {
        specEntities[ents[j].name] = {
          name: ents[j].name,
          terminalState: ents[j].terminalState || 2,
          description: ents[j].description || '',
        };
      }
    }
  }

  // Also include interaction targets as potential entities
  for (var i = 0; i < specs.length; i++) {
    var interactions = specs[i].requiredInteractions || [];
    for (var k = 0; k < interactions.length; k++) {
      var parts = interactions[k].split(':');
      var verb = parts[0];
      var target = parts[1];
      if (target && !specEntities[target] && verb !== 'wait' && verb !== 'defend') {
        specEntities[target] = {
          name: target,
          terminalState: 1,
          description: 'interaction target for ' + verb,
        };
      }
    }
  }

  // Build entity list compatible with matchPrefabs format
  var entityList = [];
  var specEntityNames = Object.keys(specEntities);
  for (var i = 0; i < specEntityNames.length; i++) {
    var se = specEntities[specEntityNames[i]];
    // Check if blueprint.entities has a matching entry with template info
    var bpEntity = null;
    if (blueprintEntities) {
      for (var bi = 0; bi < blueprintEntities.length; bi++) {
        if (blueprintEntities[bi].name === se.name) {
          bpEntity = blueprintEntities[bi];
          break;
        }
      }
    }
    entityList.push({
      name: se.name,
      template: bpEntity ? (bpEntity.template || '') : '',
    });
  }

  // Use prompt-v5's matchPrefabs to get pool mapping
  var entityPoolMap = {};
  if (promptV5.matchPrefabs && entityList.length > 0) {
    entityPoolMap = promptV5.matchPrefabs(entityList);
  }

  // Enrich specs with resolved pool names
  var resolvedSpecs = specs.map(function(spec) {
    var resolved = JSON.parse(JSON.stringify(spec)); // deep clone
    if (resolved.entitiesRequired) {
      resolved.entitiesRequired = resolved.entitiesRequired.map(function(ent) {
        return {
          name: ent.name,
          terminalState: ent.terminalState,
          description: ent.description,
          poolName: entityPoolMap[ent.name] || null,
          stateVar: ent.name + 'State',
        };
      });
    }
    return resolved;
  });

  return {
    entityPoolMap: entityPoolMap,
    resolvedSpecs: resolvedSpecs,
    allEntities: specEntities,
  };
}

module.exports = { resolveEntities: resolveEntities };
