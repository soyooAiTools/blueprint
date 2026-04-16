/**
 * Converts a trigger definition from game schema → C# condition expression.
 * Used by phase-init.cjs to fill skeleton CheckEventRules conditions,
 * and by autoplay-mirror.cjs to generate simulation equivalents.
 */

function toLowerCamel(name) {
  if (!name || name.length === 0) return name;
  return name[0].toLowerCase() + name.slice(1);
}

function triggerToCondition(trigger, allEntities) {
  if (!trigger || !trigger.type) return 'true /* MISSING TRIGGER */';
  switch (trigger.type) {
    case 'resource_collected':
      return 'GetResource("' + trigger.resource + '") >= ' + trigger.amount;
    case 'entity_state_reached':
      return toLowerCamel(trigger.entity) + 'State >= ' + trigger.state;
    case 'near_entity':
      return 'IsNear(' + toLowerCamel(trigger.entity) + ', ' + trigger.range + 'f)';
    case 'click_entity':
      return toLowerCamel(trigger.entity) + 'Done == true';
    case 'all_built':
      return allBuiltCondition(allEntities);
    case 'enemy_defeated':
      return 'enemiesDefeated >= ' + trigger.count;
    case 'timer':
      return 'phaseTimer >= ' + trigger.seconds + 'f';
    case 'compound':
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
