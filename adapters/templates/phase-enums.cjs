/**
 * Single source of truth for phase Trigger/Action enum values.
 * Consumed by trigger-codegen / phase-init / autoplay-mirror.
 * String values match the JSON schema in spec-extract output and must stay stable
 * (schema JSON is external contract). Extend here first, then propagate to
 * switch-case consumers.
 */

var TriggerType = Object.freeze({
  RESOURCE_COLLECTED: 'resource_collected',
  ENTITY_STATE_REACHED: 'entity_state_reached',
  NEAR_ENTITY: 'near_entity',
  CLICK_ENTITY: 'click_entity',
  ALL_BUILT: 'all_built',
  ENEMY_DEFEATED: 'enemy_defeated',
  TIMER: 'timer',
  COMPOUND: 'compound',
});

var ActionType = Object.freeze({
  SET_ENTITY_STATE: 'set_entity_state',
  ADD_RESOURCE: 'add_resource',
  SWITCH_FORM: 'switch_form',
  SHOW_FLOATING_TEXT: 'show_floating_text',
  SET_GUIDE: 'set_guide',
  SPAWN_ENEMIES: 'spawn_enemies',
});

var TRIGGER_VALUES = Object.freeze(Object.keys(TriggerType).map(function(k) { return TriggerType[k]; }));
var ACTION_VALUES = Object.freeze(Object.keys(ActionType).map(function(k) { return ActionType[k]; }));

function isKnownTrigger(s) { return TRIGGER_VALUES.indexOf(s) >= 0; }
function isKnownAction(s) { return ACTION_VALUES.indexOf(s) >= 0; }

module.exports = {
  TriggerType: TriggerType,
  ActionType: ActionType,
  TRIGGER_VALUES: TRIGGER_VALUES,
  ACTION_VALUES: ACTION_VALUES,
  isKnownTrigger: isKnownTrigger,
  isKnownAction: isKnownAction,
};
