var { toLowerCamel } = require('./trigger-codegen.cjs');

function generatePhaseInit(phase, schema) {
  var lines = [];
  // Show entities for this phase
  var show = phase.showEntities || [];
  for (var i = 0; i < show.length; i++) {
    var ent = findEntity(schema, show[i]);
    if (ent) {
      var v = toLowerCamel(ent.name);
      lines.push('                PlaceObj(' + v + ', ' + ent.initPos[0] + 'f, ' + ent.initPos[1] + 'f, ' + ent.initPos[2] + 'f);');
      if (ent.scale && ent.scale !== 1.0) {
        lines.push('                SetScale(' + v + ', ' + ent.scale + 'f);');
      }
    }
  }
  // Hide entities
  var hide = phase.hideEntities || [];
  for (var j = 0; j < hide.length; j++) {
    lines.push('                HideObj(' + toLowerCamel(hide[j]) + ');');
  }
  // Guide text
  if (phase.guideText) {
    lines.push('                guideText.text = "' + phase.guideText.replace(/"/g, '\\"') + '";');
  }
  // onEnter actions
  var actions = phase.onEnter || [];
  for (var k = 0; k < actions.length; k++) {
    lines.push('                ' + actionToCode(actions[k]));
  }
  return lines.join('\n');
}

function actionToCode(action) {
  switch (action.action) {
    case 'set_entity_state':
      return toLowerCamel(action.entity || 'Unknown') + 'State = ' + (action.state != null ? action.state : 1) + ';';
    case 'add_resource':
      return 'AddResource("' + action.resource + '", ' + action.amount + ');';
    case 'switch_form':
      return 'SwitchForm(' + (action.formIndex != null ? action.formIndex : 0) + ');';
    case 'show_floating_text':
      return 'ShowFloatingText(player.transform.position, "' + action.text + '", Color.' + (action.color || 'yellow') + ');';
    case 'set_guide':
      return 'guideText.text = "' + (action.text || '').replace(/"/g, '\\"') + '";';
    case 'spawn_enemies':
      return 'Spawn' + action.entity + '(' + action.count + ');';
    default:
      return '// TODO: Unknown action ' + action.action;
  }
}

function findEntity(schema, name) {
  return (schema.entities || []).filter(function(e) { return e.name === name; })[0] || null;
}

module.exports = { generatePhaseInit: generatePhaseInit, actionToCode: actionToCode };
