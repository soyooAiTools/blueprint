function getTrackedForms(schema) {
  var forms = (schema && schema.forms) || [];
  if (!forms.length) return [];
  return forms.slice(1);
}

function generateUpgradeVariables(schema) {
  var trackedForms = getTrackedForms(schema);
  if (trackedForms.length === 0) return '';

  var lines = [];
  lines.push('    int currentFormIndex = 0; // currently selected form index from schema forms');
  for (var i = 0; i < trackedForms.length; i++) {
    lines.push('    bool ' + trackedForms[i].formId + 'Unlocked = false; // unlock flag for form "' + trackedForms[i].formId + '"');
  }
  return lines.join('\n');
}

function findFormSwitchTriggers(schema) {
  var phases = (schema && schema.phases) || [];
  var triggers = [];

  for (var i = 0; i < phases.length; i++) {
    var actions = phases[i].onComplete || [];
    for (var j = 0; j < actions.length; j++) {
      if (actions[j].action === 'switch_form' && actions[j].formIndex != null) {
        triggers.push({
          phaseId: phases[i].phaseId,
          phaseIndex: i,
          formIndex: actions[j].formIndex
        });
      }
    }
  }

  return triggers;
}

function generateUpgradeUpdate(schema) {
  var trackedForms = getTrackedForms(schema);
  if (trackedForms.length === 0) return '';

  var triggers = findFormSwitchTriggers(schema);
  var lines = [];
  lines.push('        // Form tracking for game state');

  for (var i = 0; i < trackedForms.length; i++) {
    var form = trackedForms[i];
    var formIndex = i + 1;
    var matchingTrigger = null;

    for (var j = 0; j < triggers.length; j++) {
      if (triggers[j].formIndex === formIndex) {
        matchingTrigger = triggers[j];
        break;
      }
    }

    lines.push('        // Check each form unlock based on phase progression');
    if (matchingTrigger) {
      lines.push('        // ' + form.formId + ' unlocks from phase "' + matchingTrigger.phaseId + '" at phase index ' + matchingTrigger.phaseIndex);
    } else {
      lines.push('        // ' + form.formId + ' has no explicit switch_form trigger in phase onComplete actions');
    }
  }

  lines.push('        // The actual SwitchForm is triggered by phase onComplete actions');
  return lines.join('\n');
}

module.exports = {
  generateUpgradeUpdate: generateUpgradeUpdate,
  generateUpgradeVariables: generateUpgradeVariables
};
