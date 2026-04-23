function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function uniq(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var value = list[i];
    if (value == null || value === '') continue;
    var key = JSON.stringify(value);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(value);
  }
  return out;
}

function formatActionLabel(action) {
  if (!action || typeof action !== 'object') return '';
  var kind = String(action.kind || action.type || '').trim();
  if (!kind) return '';
  if (kind === 'move_to') return 'move_to:' + (action.target || '');
  if (kind === 'tap') return 'tap:' + (action.target || '');
  if (kind === 'drag') return 'drag:' + (action.from || '') + '->' + (action.to || '');
  if (kind === 'hold') return 'hold:' + (action.target || '');
  if (kind === 'approach_collect') return 'collect:' + (action.item || action.target || '');
  if (kind === 'deliver') return 'deliver:' + (action.item || '') + '->' + (action.target || '');
  if (kind === 'build') return 'build:' + (action.target || '');
  if (kind === 'upgrade') return 'upgrade:' + (action.target || '');
  if (kind === 'attack') return 'attack:' + (action.target || '');
  if (kind === 'defend') return 'defend:' + (action.duration || '');
  if (action.target) return kind + ':' + action.target;
  return kind;
}

function buildSpecsFromPlans(plans) {
  if (!plans || typeof plans !== 'object') return [];

  var cuaSteps = plans.cuaPlan && Array.isArray(plans.cuaPlan.steps) ? plans.cuaPlan.steps : [];
  if (cuaSteps.length > 0) {
    return cuaSteps.map(function(step, index) {
      return {
        phaseId: step.phaseId || ('phase_' + index),
        phaseName: step.phaseId || ('phase_' + index),
        requiredInteractions: uniq(toArray(step.actions).map(formatActionLabel).filter(Boolean)),
        triggerNext: {
          description: uniq(toArray(step.expectedSignals)).join(', ')
        },
        order: index,
      };
    });
  }

  var phaseBindings = plans.assemblyPlan && Array.isArray(plans.assemblyPlan.phaseBindings)
    ? plans.assemblyPlan.phaseBindings
    : [];
  return phaseBindings.map(function(binding, index) {
    return {
      phaseId: binding.phaseId || ('phase_' + index),
      phaseName: binding.phaseId || ('phase_' + index),
      requiredInteractions: [],
      triggerNext: {
        description: uniq(toArray(binding.completionSignals)).join(', ')
      },
      order: index,
    };
  });
}

module.exports = {
  buildSpecsFromPlans: buildSpecsFromPlans,
  formatActionLabel: formatActionLabel,
};
