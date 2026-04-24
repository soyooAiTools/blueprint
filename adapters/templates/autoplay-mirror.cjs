/**
 * Auto-generates OnAutoPlayArrive() body from phases + triggers.
 *
 * [2026-04-20] Phase-exit gate now binds to EntityAdvanced() which reads real
 * transform.position + activeSelf. Direct variable writes no longer satisfy
 * conditions — each trigger must produce an observable GameObject change.
 */
var { toLowerCamel, resolveSpawnEntityName } = require('./trigger-codegen.cjs');
var { TriggerType, ActionType } = require('./phase-enums.cjs');

function generateAutoPlay(schema) {
  var lines = [];
  var phases = schema.phases || [];

  lines.push('        // Auto-play interaction simulation (moves/toggles GameObjects for CUA to observe)');
  lines.push('        switch (currentPhaseName) {');
  for (var i = 0; i < phases.length; i++) {
    var phase = phases[i];
    var mirror = triggerToMirror(phase.trigger, schema, i);
    lines.push('            case "' + phase.phaseId + '": {');
    if (mirror) {
      var mirrorLines = mirror.split('\n');
      for (var j = 0; j < mirrorLines.length; j++) {
        lines.push('                ' + mirrorLines[j]);
      }
    }
    var actions = phase.onComplete || [];
    for (var k = 0; k < actions.length; k++) {
      lines.push('                ' + actionToMirror(actions[k], schema));
    }
    lines.push('                break;');
    lines.push('            }');
  }
  lines.push('        }');
  return lines.join('\n');
}

// Produce OBSERVABLE position changes for each trigger type.
// No more direct xxxState / xxxDone assignment — those are read-only for phase gate.
// SetActive is forbidden in Luna — use PlaceObj/HideObj/transform.position only.
function triggerToMirror(trigger, schema, phaseIdx) {
  if (!trigger) return null;
  var idx = phaseIdx || 0;
  var offX = (idx % 4) * 2 - 3; // vary position so successive phases are distinct moves
  switch (trigger.type) {
    case TriggerType.RESOURCE_COLLECTED: {
      // Mirror the move emitted by collect-interaction.cjs (HideObj) so the autoPlay
      // path also satisfies EntityAdvanced(source, _snap) > 1.5. If the trigger names
      // a source entity we hide it; otherwise fall back to AddResource + comment.
      var src = trigger.entity ? toLowerCamel(trigger.entity) : null;
      return 'AddResource("' + trigger.resource + '", ' + trigger.amount + ');' +
             (src ? '\nif (' + src + ' != null) HideObj(' + src + '); // observable — required by EntityAdvanced' : '');
    }
    case TriggerType.ENTITY_STATE_REACHED:
      return 'PlaceObj(' + toLowerCamel(trigger.entity) + ', ' + offX + 'f, 0.5f, 0f);';
    case TriggerType.NEAR_ENTITY:
      return toLowerCamel(trigger.entity) + '.transform.position = player.transform.position;';
    case TriggerType.CLICK_ENTITY:
      return 'PlaceObj(' + toLowerCamel(trigger.entity) + ', ' + offX + 'f, 0.5f, 0f);';
    case TriggerType.ENEMY_DEFEATED:
      return 'enemiesDefeated = ' + trigger.count + ';\n' +
             'HideObj(' + toLowerCamel(trigger.entity || 'enemy') + ');';
    case TriggerType.ALL_BUILT:
      var tracked = (schema.entities || []).filter(function(e) { return e.terminalState === 2; });
      return tracked.map(function(e, i) {
        return 'PlaceObj(' + toLowerCamel(e.name) + ', ' + (i * 2 - 4) + 'f, 0.5f, 0f);';
      }).join('\n');
    case TriggerType.COMPOUND:
      var parts = (trigger.triggers || []).map(function(t) { return triggerToMirror(t, schema, phaseIdx); }).filter(Boolean);
      return parts.join('\n');
    case TriggerType.TIMER:
      return null;
    default:
      return null;
  }
}

function actionToMirror(action, schema) {
  switch (action.action) {
    case ActionType.SET_ENTITY_STATE:
      // State field is now read-only for phase gate — emit an observable move instead.
      return 'PlaceObj(' + toLowerCamel(action.entity) + ', ' + ((action.state || 1) * 2) + 'f, 0.5f, 0f); // observable — required by EntityAdvanced';
    case ActionType.ADD_RESOURCE:
      return 'AddResource("' + action.resource + '", ' + action.amount + ');';
    case ActionType.SWITCH_FORM:
      return 'SwitchForm(' + action.formIndex + ');';
    case ActionType.SPAWN_ENEMIES:
      var target = resolveSpawnEntityName(action, schema);
      return 'Spawn' + target + '(' + (action.count != null ? action.count : 1) + ');';
    default:
      return '// autoplay: ' + action.action;
  }
}

module.exports = { generateAutoPlay: generateAutoPlay };
