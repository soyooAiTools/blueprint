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

function hasEntityRef(name) {
  return String(name || '').trim().length > 0;
}

function isGenericEnemyName(name) {
  var text = String(name || '');
  return text === '' || /^Enemy$/i.test(text) || /^Unknown$/i.test(text);
}

function pickDefaultEnemyEntity(schema) {
  var seen = {};
  var candidates = [];

  function scoreEnemyName(name) {
    var text = String(name || '');
    var score = 0;
    if (/Enemy/i.test(text)) score += 40;
    if (/Astronaut|Soldier|Unit|Troop|Mob|Minion|Bot|Drone|Walker/i.test(text)) score += 30;
    if (/Base|Button|CTA|Recycler|Gold|Tower|Belt|Debris|Bullet/i.test(text)) score -= 80;
    return score;
  }

  function pushName(name) {
    if (!name || seen[name]) return;
    seen[name] = true;
    candidates.push(name);
  }

  (schema && schema.npcs || []).forEach(function(npc) {
    if (npc && npc.entity) pushName(npc.entity);
  });
  (schema && schema.entities || []).forEach(function(entity) {
    if (entity && entity.name) pushName(entity.name);
  });

  candidates.sort(function(a, b) {
    return scoreEnemyName(b) - scoreEnemyName(a);
  });

  return candidates.length > 0 && scoreEnemyName(candidates[0]) > 0 ? candidates[0] : null;
}

function resolveSpawnEntityName(action, schema) {
  var raw = action && action.entity;
  if (!isGenericEnemyName(raw)) return raw;
  return pickDefaultEnemyEntity(schema) || raw || 'Enemy';
}

function triggerToCondition(trigger, allEntities) {
  if (!trigger || !trigger.type) return 'true /* MISSING TRIGGER */';
  switch (trigger.type) {
    case TriggerType.RESOURCE_COLLECTED:
      return 'GetResource("' + trigger.resource + '") >= ' + trigger.amount;
    case TriggerType.ENTITY_STATE_REACHED:
      if (!hasEntityRef(trigger.entity)) return 'false /* unresolved entity_state_reached */';
      return toLowerCamel(trigger.entity) + 'State >= ' + trigger.state;
    case TriggerType.NEAR_ENTITY:
      if (!hasEntityRef(trigger.entity)) return 'false /* unresolved near_entity */';
      return 'IsNear(' + toLowerCamel(trigger.entity) + ', ' + trigger.range + 'f)';
    case TriggerType.CLICK_ENTITY:
      if (!hasEntityRef(trigger.entity)) return 'false /* unresolved click_entity */';
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

module.exports = {
  triggerToCondition: triggerToCondition,
  toLowerCamel: toLowerCamel,
  hasEntityRef: hasEntityRef,
  resolveSpawnEntityName: resolveSpawnEntityName,
};
