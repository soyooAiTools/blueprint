var { toLowerCamel } = require('../trigger-codegen.cjs');

function findFormTriggers(schema) {
  var phases = schema.phases || [];
  var triggers = [];
  for (var i = 0; i < phases.length; i++) {
    var actions = phases[i].onComplete || [];
    for (var j = 0; j < actions.length; j++) {
      if (actions[j].action === 'switch_form' && actions[j].formIndex != null) {
        var triggerEntity = null;
        var phaseTrigger = phases[i].trigger;
        if (phaseTrigger && phaseTrigger.entity) {
          triggerEntity = phaseTrigger.entity;
        }
        if (triggerEntity) {
          triggers.push({
            entity: triggerEntity,
            formIndex: actions[j].formIndex
          });
        }
      }
    }
  }
  return triggers;
}

function generateFormSwitchUpdate(schema) {
  var forms = schema.forms || [];
  if (forms.length <= 1) return '';

  var triggers = findFormTriggers(schema);
  if (triggers.length === 0) return '';

  var lines = [];
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    var entity = toLowerCamel(t.entity);
    lines.push('        if (' + entity + 'State == 2 && _currentFormIndex < ' + t.formIndex + ' && _forms != null && _forms.Length > ' + t.formIndex + ') {');
    lines.push('            SwitchForm(' + t.formIndex + ');');
    lines.push('        }');
    if (i < triggers.length - 1) lines.push('');
  }
  return lines.join('\n');
}

function generateFormSwitchVariables(schema) {
  return '';
}

module.exports = { generateFormSwitchUpdate: generateFormSwitchUpdate, generateFormSwitchVariables: generateFormSwitchVariables };
