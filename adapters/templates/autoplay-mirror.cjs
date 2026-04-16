/**
 * Auto-generates OnAutoPlayArrive() body from phases + triggers.
 * Each phase's interactive trigger gets an autoplay equivalent that
 * directly sets state/resources instead of requiring player input.
 */
var { toLowerCamel } = require('./trigger-codegen.cjs');

function generateAutoPlay(schema) {
  var lines = [];
  var phases = schema.phases || [];

  lines.push('        // Auto-play interaction simulation');
  for (var i = 0; i < phases.length; i++) {
    var phase = phases[i];
    var mirror = triggerToMirror(phase.trigger, schema);
    if (!mirror) continue;
    // OnAutoPlayArrive context: simulate interaction for this phase
    lines.push('        if (currentPhaseName == "' + phase.phaseId + '") {');
    var mirrorLines = mirror.split('\n');
    for (var j = 0; j < mirrorLines.length; j++) {
      lines.push('            ' + mirrorLines[j]);
    }
    // Set interaction done flags
    lines.push('            ' + phase.phaseId + 'InteractionDone = true;');
    lines.push('            ' + phase.phaseId + 'PlayerActed = true;');
    // onComplete actions
    var actions = phase.onComplete || [];
    for (var k = 0; k < actions.length; k++) {
      lines.push('            ' + actionToMirror(actions[k]));
    }
    lines.push('        }');
  }
  return lines.join('\n');
}

function triggerToMirror(trigger, schema) {
  if (!trigger) return null;
  switch (trigger.type) {
    case 'resource_collected':
      return 'AddResource("' + trigger.resource + '", ' + trigger.amount + ');';
    case 'entity_state_reached':
      return toLowerCamel(trigger.entity) + 'State = ' + trigger.state + ';';
    case 'near_entity':
      return toLowerCamel(trigger.entity) + '.transform.position = player.transform.position;';
    case 'click_entity':
      return toLowerCamel(trigger.entity) + 'Done = true;\n' +
             toLowerCamel(trigger.entity) + 'State++;';
    case 'enemy_defeated':
      return 'enemiesDefeated = ' + trigger.count + ';\n' +
             'HideObj(' + toLowerCamel(trigger.entity || 'enemy') + ');';
    case 'all_built':
      var tracked = (schema.entities || []).filter(function(e) { return e.terminalState === 2; });
      return tracked.map(function(e) { return toLowerCamel(e.name) + 'State = 2;'; }).join('\n');
    case 'compound':
      var parts = (trigger.triggers || []).map(function(t) { return triggerToMirror(t, schema); }).filter(Boolean);
      return parts.join('\n');
    case 'timer':
      return null; // Skeleton safety net handles timeout
    default:
      return null;
  }
}

function actionToMirror(action) {
  switch (action.action) {
    case 'set_entity_state':
      return toLowerCamel(action.entity) + 'State = ' + action.state + ';';
    case 'add_resource':
      return 'AddResource("' + action.resource + '", ' + action.amount + ');';
    case 'switch_form':
      return 'SwitchForm(' + action.formIndex + ');';
    case 'spawn_enemies':
      return 'Spawn' + action.entity + '(' + action.count + ');';
    default:
      return '// autoplay: ' + action.action;
  }
}

module.exports = { generateAutoPlay: generateAutoPlay };
