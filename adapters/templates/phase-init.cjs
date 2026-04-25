var { toLowerCamel, resolveSpawnEntityName } = require('./trigger-codegen.cjs');
var { ActionType } = require('./phase-enums.cjs');
var { resourceIdExpr, escapeCsString } = require('./resource-ids.cjs');

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
    lines.push('                SetGuideText("' + escapeCsString(phase.guideText) + '");');
  }
  // onEnter actions
  var actions = phase.onEnter || [];
  for (var k = 0; k < actions.length; k++) {
    lines.push('                ' + actionToCode(actions[k], schema));
  }
  return lines.join('\n');
}

function actionToCode(action, schema) {
  switch (action.action) {
    case ActionType.SET_ENTITY_STATE:
      if (!action.entity || /^Enemy$/i.test(String(action.entity)) || /^Unknown$/i.test(String(action.entity))) {
        return '// skipped unresolved set_entity_state';
      }
      return toLowerCamel(action.entity) + 'State = ' + (action.state != null ? action.state : 1) + ';';
    case ActionType.ADD_RESOURCE:
      if (!action.resource || /^default$/i.test(String(action.resource))) {
        return '// skipped unresolved add_resource';
      }
      return 'AddResource(' + resourceIdExpr(action.resource) + ', ' + action.amount + ');';
    case ActionType.SWITCH_FORM:
      return 'SwitchForm(' + (action.formIndex != null ? action.formIndex : 0) + ');';
    case ActionType.SHOW_FLOATING_TEXT:
      if (action.text == null || String(action.text) === 'undefined') {
        return '// skipped unresolved floating_text';
      }
      return 'ShowFloatingText(player.transform.position, "' + action.text + '", Color.' + (action.color || 'yellow') + ');';
    case ActionType.SET_GUIDE:
      return 'SetGuideText("' + escapeCsString(action.text || '') + '");';
    case ActionType.SPAWN_ENEMIES:
      var target = resolveSpawnEntityName(action, schema);
      return 'Spawn' + target + '(' + (action.count != null ? action.count : 1) + ');';
    default:
      return '// TODO: Unknown action ' + action.action;
  }
}

function findEntity(schema, name) {
  return (schema.entities || []).filter(function(e) { return e.name === name; })[0] || null;
}

module.exports = { generatePhaseInit: generatePhaseInit, actionToCode: actionToCode };
