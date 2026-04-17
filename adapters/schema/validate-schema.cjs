var Ajv = require('ajv');
var fs = require('fs');
var path = require('path');

var schemaPath = path.join(__dirname, 'game-schema.json');
var schemaDef = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
var ajv = new Ajv({ allErrors: true });
var validate = ajv.compile(schemaDef);

/**
 * Validate a game schema against the JSON Schema (structural validation).
 * @param {object} schema - The game schema object to validate.
 * @returns {string[]} Array of error messages, empty if valid.
 */
function validateGameSchema(schema) {
  var valid = validate(schema);
  if (valid) return [];
  return validate.errors.map(function (e) {
    return (e.dataPath || '') + ' ' + e.message;
  });
}

/**
 * Check whether a trigger (possibly compound) contains a click_entity trigger.
 * @param {object} trigger - Trigger object to inspect.
 * @returns {boolean}
 */
function hasClickEntityTrigger(trigger) {
  if (!trigger) return false;
  if (trigger.type === 'click_entity') return true;
  if (trigger.type === 'compound' && Array.isArray(trigger.triggers)) {
    for (var i = 0; i < trigger.triggers.length; i++) {
      if (hasClickEntityTrigger(trigger.triggers[i])) return true;
    }
  }
  return false;
}

/**
 * Validate semantic constraints that cannot be expressed in JSON Schema alone.
 * Assumes the schema has already passed structural validation (validateGameSchema).
 * @param {object} schema - The game schema object to validate.
 * @returns {string[]} Array of semantic error messages, empty if valid.
 */
function validateSemantics(schema) {
  var errors = [];

  if (!schema || typeof schema !== 'object') {
    errors.push('schema must be a non-null object');
    return errors;
  }

  if (!Array.isArray(schema.entities) || schema.entities.length === 0) {
    errors.push('entities array must not be empty');
    return errors;
  }

  if (!Array.isArray(schema.phases) || schema.phases.length === 0) {
    errors.push('phases array must not be empty');
    return errors;
  }

  // Last phase must have click_entity trigger (CTA button)
  var lastPhase = schema.phases[schema.phases.length - 1];
  if (!hasClickEntityTrigger(lastPhase.trigger)) {
    errors.push('Last phase trigger must include click_entity (CTA button)');
  }

  // timer cannot be a standalone trigger (must be inside compound)
  for (var i = 0; i < schema.phases.length; i++) {
    var phase = schema.phases[i];
    if (phase.trigger && phase.trigger.type === 'timer') {
      errors.push('Phase ' + phase.phaseId + ': timer trigger must be inside compound');
    }
  }

  // Build entity name lookup
  var entityNames = {};
  var seen = {};
  for (var j = 0; j < schema.entities.length; j++) {
    var eName = schema.entities[j].name;
    // No duplicate entity names
    if (seen[eName]) {
      errors.push('Duplicate entity name: ' + eName);
    }
    seen[eName] = true;
    entityNames[eName] = true;
  }

  // NPC entity references must exist
  var npcs = schema.npcs || [];
  for (var k = 0; k < npcs.length; k++) {
    if (!entityNames[npcs[k].entity]) {
      errors.push('NPC references non-existent entity: ' + npcs[k].entity);
    }
  }

  // showEntities / hideEntities references must exist
  for (var p = 0; p < schema.phases.length; p++) {
    var ph = schema.phases[p];
    var showEnts = ph.showEntities || [];
    for (var s = 0; s < showEnts.length; s++) {
      if (!entityNames[showEnts[s]]) {
        errors.push('Phase ' + ph.phaseId + ' showEntities references non-existent entity: ' + showEnts[s]);
      }
    }
    var hideEnts = ph.hideEntities || [];
    for (var h = 0; h < hideEnts.length; h++) {
      if (!entityNames[hideEnts[h]]) {
        errors.push('Phase ' + ph.phaseId + ' hideEntities references non-existent entity: ' + hideEnts[h]);
      }
    }
  }

  // Resource entity references must exist
  var resources = schema.resources || [];
  for (var r = 0; r < resources.length; r++) {
    if (resources[r].entity && !entityNames[resources[r].entity]) {
      errors.push('Resource ' + resources[r].name + ' references non-existent entity: ' + resources[r].entity);
    }
  }

  return errors;
}

module.exports = {
  validateGameSchema: validateGameSchema,
  validateSemantics: validateSemantics,
  hasClickEntityTrigger: hasClickEntityTrigger
};