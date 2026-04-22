/**
 * Converts a trigger definition from game schema → C# condition expression.
 * Used by phase-init.cjs to fill skeleton CheckEventRules conditions,
 * and by autoplay-mirror.cjs to generate simulation equivalents.
 */

var { TriggerType } = require('./phase-enums.cjs');

function toLowerCamel(name) {
  // Identity: skeleton declares PascalCase variables matching entity names as-is
  // (e.g. "GameObject TreeSource;", "int HouseState;"), so templates must NOT lowercase.
  return name || '';
}

function triggerToCondition(trigger, allEntities) {
  if (!trigger || !trigger.type) return 'true /* MISSING TRIGGER */';
  switch (trigger.type) {
    case TriggerType.RESOURCE_COLLECTED:
      return 'GetResource("' + trigger.resource + '") >= ' + trigger.amount;
    case TriggerType.ENTITY_STATE_REACHED:
      return toLowerCamel(trigger.entity) + 'State >= ' + trigger.state;
    case TriggerType.NEAR_ENTITY:
      return 'IsNear(' + toLowerCamel(trigger.entity) + ', ' + trigger.range + 'f)';
    case TriggerType.CLICK_ENTITY:
      return 'IsNear(' + toLowerCamel(trigger.entity) + ', 2f) && Input.GetMouseButtonDown(0)';
    case TriggerType.ALL_BUILT:
      return allBuiltCondition(allEntities);
    case TriggerType.ENEMY_DEFEATED:
      return 'enemiesDefeated >= ' + trigger.count;
    case TriggerType.TIMER:
      return 'phaseTimer >= ' + trigger.seconds + 'f';
    case TriggerType.COMPOUND:
      var op = trigger.operator === 'or' ? ' || ' : ' && ';
      var parts = (trigger.triggers || []).map(function(t) {
        return '(' + triggerToCondition(t, allEntities) + ')';
      });
      return parts.join(op);
    default:
      return 'true /* UNKNOWN TRIGGER: ' + trigger.type + ' */';
  }
}

function allBuiltCondition(entities) {
  var tracked = (entities || []).filter(function(e) { return e.terminalState === 2; });
  if (tracked.length === 0) return 'true';
  return tracked.map(function(e) {
    return toLowerCamel(e.name) + 'State >= 2';
  }).join(' && ');
}

module.exports = { triggerToCondition: triggerToCondition, toLowerCamel: toLowerCamel };
