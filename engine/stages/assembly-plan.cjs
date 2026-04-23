var { buildProjectPlans } = require('../../adapters/assembly-plan-pipeline.cjs');
var { validateAssemblyRegistry } = require('../../adapters/schema/validate-assembly-registry.cjs');

function buildProjectLikeBlueprint(blueprint, taskId) {
  blueprint = blueprint || {};
  return {
    name: blueprint.projectName || blueprint.name || taskId || 'project',
    projectName: blueprint.projectName || blueprint.name || taskId || 'project',
    blueprint: {
      entities: blueprint.entities || [],
      phases: blueprint.phases || [],
      globalSettings: blueprint.globalSettings || {},
      storyboardFrames: blueprint.storyboardFrames || [],
      projectName: blueprint.projectName || blueprint.name || taskId || 'project'
    },
    entities: blueprint.entities || [],
    phases: blueprint.phases || [],
    specs: blueprint.specs || [],
    storyboardFrames: blueprint.storyboardFrames || ((blueprint.storyboard && blueprint.storyboard.frames) || []),
    storyboard: blueprint.storyboard || [],
    characterSheet: blueprint.storyboard && blueprint.storyboard.characterSheet || {},
    sceneSheet: blueprint.storyboard && blueprint.storyboard.sceneSheet || {},
    storyboardConfig: blueprint.storyboard && blueprint.storyboard.config || {},
    globalSettings: blueprint.globalSettings || {}
  };
}

function computeAssemblyCoverage(plans) {
  var atomCount = plans && plans.storyboardAtomPlan && plans.storyboardAtomPlan.items ? plans.storyboardAtomPlan.items.length : 0;
  var unresolved = plans && plans.assemblyPlan && plans.assemblyPlan.unresolved ? plans.assemblyPlan.unresolved.length : 0;
  if (atomCount <= 0) return unresolved > 0 ? 0 : 1;
  var covered = atomCount - unresolved;
  if (covered < 0) covered = 0;
  return covered / atomCount;
}

module.exports = {
  name: 'assembly-plan',
  canRetry: false,

  execute: function(ctx) {
    ctx.addLog('assembly-plan', 'Building assembly-first plans...');

    var registryCheck = validateAssemblyRegistry();
    if (!registryCheck.ok) {
      throw new Error('Assembly registry invalid: ' + registryCheck.errors.join('; '));
    }

    var plans = buildProjectPlans(buildProjectLikeBlueprint(ctx.blueprint, ctx.taskId));
    if (!plans.validation || !plans.validation.ok) {
      throw new Error('Assembly plan validation failed: ' + (plans.validation.errors || []).join('; '));
    }

    ctx.blueprint.plans = plans;
    ctx.blueprint.planValidation = plans.validation;
    ctx.blueprint.assemblyCoverage = computeAssemblyCoverage(plans);
    ctx.blueprint.assemblyUnresolvedCount = (plans.assemblyPlan && plans.assemblyPlan.unresolved || []).length;
    ctx.blueprint.storyboardAtomCount = (plans.storyboardAtomPlan && plans.storyboardAtomPlan.items || []).length;
    ctx.blueprint.moduleInstanceCount = (plans.assemblyPlan && plans.assemblyPlan.moduleInstances || []).length;
    ctx.blueprint.cuaPlanStepCount = (plans.cuaPlan && plans.cuaPlan.steps || []).length;
    ctx.blueprint.planValidationWarningCount = (plans.validation && plans.validation.warnings || []).length;

    if (plans.validation.warnings && plans.validation.warnings.length > 0) {
      ctx.addLog('assembly-plan', 'Plan warnings: ' + plans.validation.warnings.join(' | '));
    }
    if (ctx.blueprint.assemblyUnresolvedCount > 0) {
      ctx.addLog('assembly-plan', 'Plan unresolved count=' + ctx.blueprint.assemblyUnresolvedCount);
    }

    ctx.addLog(
      'assembly-plan',
      'Built ' + ctx.blueprint.storyboardAtomCount + ' atoms, ' +
      (plans.entityPlan.entities || []).length + ' entities, ' +
      ctx.blueprint.moduleInstanceCount + ' module instances, ' +
      ctx.blueprint.cuaPlanStepCount + ' CUA steps'
    );

    return {
      atomCount: ctx.blueprint.storyboardAtomCount,
      entityCount: (plans.entityPlan.entities || []).length,
      moduleInstanceCount: ctx.blueprint.moduleInstanceCount,
      cuaStepCount: ctx.blueprint.cuaPlanStepCount,
      unresolvedCount: ctx.blueprint.assemblyUnresolvedCount,
      warningCount: ctx.blueprint.planValidationWarningCount,
      assemblyCoverage: ctx.blueprint.assemblyCoverage
    };
  }
};
