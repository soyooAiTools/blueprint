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
      // 2026-05-03: Player 在 Start() 摆放后由摇杆驱动；任何 phase showEntities 列出 Player
      // 都不能调 PlaceObj，否则进入新 phase 时会把玩家拽回 initPos，体感如瞬移。
      if (/^player$/i.test(ent.name)) {
        lines.push('                // Player 由摇杆持续移动，phase 切换不重置位置');
        continue;
      }
      // 2026-05-04: 仅当实体处于 HideObj 隐藏态(y<-100)时才 PlaceObj 把它"放出来"。
      // 已可见的实体保持当前位置，不再每个 phase 切换硬拽回 initPos。
      // 根因：旧逻辑 phase 1→2→3 重叠 showEntities 时,每次 init 都 SetPosition,
      // 让玩家眼看到「粉碎机/锻造间」在 phase 切换时跳一下。
      // 2026-05-05: 隐藏态→可见态时同步走 GFM_PhaseTransition.PopIn 缩放缓动,
      // 不再让实体一帧"啪"出现。PlaceObj 仍同步落位(EntityAdvanced 看 position)。
      lines.push('                if (' + v + ' != null && ' + v + '.transform.position.y < -100f) {');
      lines.push('                    PlaceObj(' + v + ', ' + ent.initPos[0] + 'f, ' + ent.initPos[1] + 'f, ' + ent.initPos[2] + 'f);');
      if (ent.scale && ent.scale !== 1.0) {
        lines.push('                    SetScale(' + v + ', ' + ent.scale + 'f);');
      }
      lines.push('                    GFM_PhaseTransition.PopIn(' + v + ', 0.3f);');
      lines.push('                }');
    }
  }
  // Hide entities
  // 2026-05-05: 走 GFM_PhaseTransition.PopOut 缩放缓动 + 完成后 y=-1000,
  // 替代过去 HideObj 一帧 y=-1000 的"瞬移"突变。EntityAdvanced 仍看 transform.position,
  // 动画期间位置不变,300ms 后才落到 -1000,远早于 autoplay 12s 守护。
  var hide = phase.hideEntities || [];
  for (var j = 0; j < hide.length; j++) {
    if (findEntity(schema, hide[j])) {
      lines.push('                GFM_PhaseTransition.PopOut(' + toLowerCamel(hide[j]) + ', 0.3f);');
    }
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
  // [L1] 高亮当前 phase 目标实体（青色菱形 + 缩放脉冲）
  var hiTarget = pickHighlightTarget(phase, schema);
  if (hiTarget) {
    lines.push('                GFM_VisualGuide.HighlightTarget(' + toLowerCamel(hiTarget) + ');');
  } else {
    lines.push('                GFM_VisualGuide.HighlightTarget(null);');
  }
  return lines.join('\n');
}

function pickHighlightTarget(phase, schema) {
  var trigger = phase && phase.trigger;
  if (trigger && trigger.entity && findEntity(schema, trigger.entity) && !/^player$/i.test(trigger.entity)) {
    return trigger.entity;
  }
  var show = phase.showEntities || [];
  for (var i = 0; i < show.length; i++) {
    var name = show[i];
    if (!findEntity(schema, name)) continue;
    if (/^player$/i.test(name)) continue;
    return name;
  }
  return null;
}

function actionToCode(action, schema) {
  switch (action.action) {
    case ActionType.SET_ENTITY_STATE:
      if (!action.entity || !findEntity(schema, action.entity) || /^Enemy$/i.test(String(action.entity)) || /^Unknown$/i.test(String(action.entity))) {
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
