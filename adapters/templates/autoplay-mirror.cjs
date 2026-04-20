/**
 * Auto-generates OnAutoPlayArrive() body from phases + triggers.
 * Each phase's interactive trigger gets an autoplay equivalent that
 * directly sets state/resources instead of requiring player input.
 */
var { toLowerCamel } = require('./trigger-codegen.cjs');
var { TriggerType, ActionType } = require('./phase-enums.cjs');

function generateAutoPlay(schema) {
  var lines = [];
  var phases = schema.phases || [];

  lines.push('        // Auto-play interaction simulation');
  lines.push('        switch (currentPhaseName) {');
  for (var i = 0; i < phases.length; i++) {
    var phase = phases[i];
    var mirror = triggerToMirror(phase.trigger, schema);
    lines.push('            case "' + phase.phaseId + '": {');
    if (mirror) {
      var mirrorLines = mirror.split('\n');
      for (var j = 0; j < mirrorLines.length; j++) {
        lines.push('                ' + mirrorLines[j]);
      }
    }
    lines.push('                ' + phase.phaseId + 'InteractionDone = true;');
    lines.push('                ' + phase.phaseId + 'PlayerActed = true;');
    var actions = phase.onComplete || [];
    for (var k = 0; k < actions.length; k++) {
      lines.push('                ' + actionToMirror(actions[k]));
    }
    lines.push('                break;');
    lines.push('            }');
  }
  lines.push('        }');
  return lines.join('\n');
}

function triggerToMirror(trigger, schema) {
  if (!trigger) return null;
  switch (trigger.type) {
    case TriggerType.RESOURCE_COLLECTED:
      return 'AddResource("' + trigger.resource + '", ' + trigger.amount + ');';
    case TriggerType.ENTITY_STATE_REACHED:
      return toLowerCamel(trigger.entity) + 'State = ' + trigger.state + ';';
    case TriggerType.NEAR_ENTITY:
      return toLowerCamel(trigger.entity) + '.transform.position = player.transform.position;';
    case TriggerType.CLICK_ENTITY:
      return toLowerCamel(trigger.entity) + 'Done = true;\n' +
             toLowerCamel(trigger.entity) + 'State++;';
    case TriggerType.ENEMY_DEFEATED:
      return 'enemiesDefeated = ' + trigger.count + ';\n' +
             'HideObj(' + toLowerCamel(trigger.entity || 'enemy') + ');';
    case TriggerType.ALL_BUILT:
      var tracked = (schema.entities || []).filter(function(e) { return e.terminalState === 2; });
      return tracked.map(function(e) { return toLowerCamel(e.name) + 'State = 2;'; }).join('\n');
    case TriggerType.COMPOUND:
      var parts = (trigger.triggers || []).map(function(t) { return triggerToMirror(t, schema); }).filter(Boolean);
      return parts.join('\n');
    case TriggerType.TIMER:
      return null; // Skeleton safety net handles timeout
    default:
      return null;
  }
}

function actionToMirror(action) {
  switch (action.action) {
    case ActionType.SET_ENTITY_STATE:
      return toLowerCamel(action.entity) + 'State = ' + action.state + ';';
    case ActionType.ADD_RESOURCE:
      return 'AddResource("' + action.resource + '", ' + action.amount + ');';
    case ActionType.SWITCH_FORM:
      return 'SwitchForm(' + action.formIndex + ');';
    case ActionType.SPAWN_ENEMIES:
      return 'Spawn' + action.entity + '(' + action.count + ');';
    default:
      return '// autoplay: ' + action.action;
  }
}

module.exports = { generateAutoPlay: generateAutoPlay };
