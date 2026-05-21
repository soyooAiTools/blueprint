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

function hasNamedRef(value) {
  return String(value || '').trim().length > 0;
}

/**
 * Well-known always-on global counters that are never declared in schema.resources[]
 * but are valid targets for resource_collected triggers. Mirrors the exemption list
 * in spec-validate.cjs.
 */
var GLOBAL_COUNTER_RE = /^(Gold|Score|Money|Cash|Coin|Currency|Time)$/i;

function validateTriggerRefs(trigger, phaseId, entityNames, resourceNames, errors) {
  if (!trigger || typeof trigger !== 'object') return;
  if (trigger.type === 'compound' && Array.isArray(trigger.triggers)) {
    for (var i = 0; i < trigger.triggers.length; i++) {
      validateTriggerRefs(trigger.triggers[i], phaseId, entityNames, resourceNames, errors);
    }
    return;
  }
  if (trigger.type === 'entity_state_reached' || trigger.type === 'near_entity' || trigger.type === 'click_entity') {
    if (!hasNamedRef(trigger.entity)) {
      errors.push('Phase ' + phaseId + ' trigger ' + trigger.type + ' missing entity');
      return;
    }
    if (!entityNames[trigger.entity]) {
      errors.push('Phase ' + phaseId + ' trigger ' + trigger.type + ' references non-existent entity: ' + trigger.entity);
    }
    return;
  }
  if (trigger.type === 'resource_collected') {
    if (!hasNamedRef(trigger.resource)) {
      errors.push('Phase ' + phaseId + ' trigger resource_collected missing resource');
      return;
    }
    // Exempt well-known always-on global counters (Gold, Score, Coin, etc.) — these
    // are never declared in schema.resources[] but are valid trigger targets.
    if (GLOBAL_COUNTER_RE.test(trigger.resource)) {
      return;
    }
    if (!resourceNames[trigger.resource]) {
      errors.push('Phase ' + phaseId + ' trigger resource_collected references non-existent resource: ' + trigger.resource);
    }
  }
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
  var resourceNames = {};
  for (var r = 0; r < resources.length; r++) {
    if (resources[r] && resources[r].name) resourceNames[resources[r].name] = true;
    if (resources[r].entity && !entityNames[resources[r].entity]) {
      errors.push('Resource ' + resources[r].name + ' references non-existent entity: ' + resources[r].entity);
    }
  }

  for (var t = 0; t < schema.phases.length; t++) {
    var phaseForTrigger = schema.phases[t];
    validateTriggerRefs(phaseForTrigger && phaseForTrigger.trigger, phaseForTrigger && phaseForTrigger.phaseId, entityNames, resourceNames, errors);
  }

  return errors;
}

module.exports = {
  validateGameSchema: validateGameSchema,
  validateSemantics: validateSemantics,
  hasClickEntityTrigger: hasClickEntityTrigger
};