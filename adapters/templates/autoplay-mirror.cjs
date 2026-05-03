/**
 * Auto-generates OnAutoPlayArrive() body from phases + triggers.
 *
 * [2026-04-20] Phase-exit gate now binds to EntityAdvanced() which reads real
 * transform.position + activeSelf. Direct variable writes no longer satisfy
 * conditions — each trigger must produce an observable GameObject change.
 */
var { toLowerCamel, resolveSpawnEntityName } = require('./trigger-codegen.cjs');
var { TriggerType, ActionType } = require('./phase-enums.cjs');
var { resourceIdExpr } = require('./resource-ids.cjs');

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
//
// 2026-05-04 根因修复：原实现 PlaceObj(entity, offX, 0.5, 0) 把目标实体硬性 SetPosition
// 到 (-3/-1/+1/+3) 之间随 phase 反复跳，玩家肉眼看到的就是「锻造间/粉碎机每个 phase
// 瞬移到一个新位置」。改用 GFM_SmoothMover.Bobble，实体在原位 +2y 半正弦上下浮动，
// 峰值穿过 EntityAdvanced 1.5 单位阈值即触发 phase-exit，浮动结束后回原位。
function triggerToMirror(trigger, schema, phaseIdx) {
  if (!trigger) return null;
  switch (trigger.type) {
    case TriggerType.RESOURCE_COLLECTED: {
      // Mirror the move emitted by collect-interaction.cjs (HideObj) so the autoPlay
      // path also satisfies EntityAdvanced(source, _snap) > 1.5. If the trigger names
      // a source entity we hide it; otherwise fall back to AddResource + comment.
      var src = trigger.entity ? toLowerCamel(trigger.entity) : null;
      return 'AddResource(' + resourceIdExpr(trigger.resource) + ', ' + trigger.amount + ');' +
             (src ? '\nif (' + src + ' != null) HideObj(' + src + '); // observable — required by EntityAdvanced' : '');
    }
    case TriggerType.ENTITY_STATE_REACHED:
      return 'GFM_SmoothMover.Bobble(' + toLowerCamel(trigger.entity) + ', 2f, 0.6f);';
    case TriggerType.NEAR_ENTITY:
      return toLowerCamel(trigger.entity) + '.transform.position = player.transform.position;';
    case TriggerType.CLICK_ENTITY:
      return 'GFM_SmoothMover.Bobble(' + toLowerCamel(trigger.entity) + ', 2f, 0.6f);';
    case TriggerType.ENEMY_DEFEATED:
      return 'enemiesDefeated = ' + trigger.count + ';\n' +
             'HideObj(' + toLowerCamel(trigger.entity || 'enemy') + ');';
    case TriggerType.ALL_BUILT:
      var tracked = (schema.entities || []).filter(function(e) { return e.terminalState === 2; });
      return tracked.map(function(e) {
        return 'GFM_SmoothMover.Bobble(' + toLowerCamel(e.name) + ', 2f, 0.6f);';
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
      // State field is now read-only for phase gate — emit an observable bobble instead.
      // 2026-05-04: 不再 PlaceObj 到 (state*2, 0.5, 0) 这种硬位置,改 Bobble 让实体原地上跳。
      return 'GFM_SmoothMover.Bobble(' + toLowerCamel(action.entity) + ', 2f, 0.6f); // observable — required by EntityAdvanced';
    case ActionType.ADD_RESOURCE:
      return 'AddResource(' + resourceIdExpr(action.resource) + ', ' + action.amount + ');';
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
