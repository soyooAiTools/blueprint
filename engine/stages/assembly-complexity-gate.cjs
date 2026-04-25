function roundCoverage(value) {
  value = Number(value);
  if (!isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

var assemblyEmitter = require('../../adapters/assembly-emitter.cjs');

function decideAssemblyRisk(metrics) {
  var implementationCoverage = metrics.assemblyImplementationCoverage == null ? 1 : metrics.assemblyImplementationCoverage;
  var missingImpl = metrics.assemblyImplementationMissingCount || 0;
  if (metrics.unresolvedCount === 0 && metrics.assemblyCoverage >= 0.999 && implementationCoverage >= 0.999 && missingImpl === 0) {
    return {
      decision: 'assembly_ready',
      riskLevel: 'low',
      fallbackRequired: false,
      summary: 'assembly-ready'
    };
  }

  if (metrics.unresolvedCount <= 2 && metrics.assemblyCoverage >= 0.6 && implementationCoverage >= 0.6) {
    return {
      decision: 'assembly_caution',
      riskLevel: 'medium',
      fallbackRequired: metrics.unresolvedCount > 0 || implementationCoverage < 0.95 || missingImpl > 0,
      summary: 'caution'
    };
  }

  return {
    decision: 'fallback_heavy',
    riskLevel: 'high',
    fallbackRequired: true,
    summary: 'fallback-heavy'
  };
}

module.exports = {
  name: 'assembly-complexity-gate',
  canRetry: false,

  canSkip: function(ctx) {
    return !ctx.blueprint.plans;
  },

  execute: function(ctx) {
    var implementation = assemblyEmitter.computeImplementationCoverage(ctx.blueprint.plans);
    var metrics = {
      assemblyCoverage: roundCoverage(ctx.blueprint.assemblyCoverage),
      assemblyImplementationCoverage: roundCoverage(implementation.coverage),
      assemblyImplementationMissingCount: implementation.missing.length,
      assemblyImplementationMissingModuleIds: implementation.missingModuleIds,
      unresolvedCount: ctx.blueprint.assemblyUnresolvedCount != null ? ctx.blueprint.assemblyUnresolvedCount : 0,
      moduleInstanceCount: ctx.blueprint.moduleInstanceCount != null ? ctx.blueprint.moduleInstanceCount : 0,
      cuaStepCount: ctx.blueprint.cuaPlanStepCount != null ? ctx.blueprint.cuaPlanStepCount : 0,
      planValidationWarningCount: ctx.blueprint.planValidationWarningCount != null ? ctx.blueprint.planValidationWarningCount : 0,
      legacyComplexityScore: ctx.blueprint.legacyComplexityScore != null ? ctx.blueprint.legacyComplexityScore : null,
      legacyComplexityBand: ctx.blueprint.legacyComplexityBand || null,
    };
    var decision = decideAssemblyRisk(metrics);

    ctx.blueprint.assemblyDecision = decision.decision;
    ctx.blueprint.assemblyRiskLevel = decision.riskLevel;
    ctx.blueprint.assemblyFallbackRequired = decision.fallbackRequired;
    ctx.blueprint.assemblyDecisionMetrics = metrics;
    ctx.blueprint.assemblyImplementationCoverage = metrics.assemblyImplementationCoverage;
    ctx.blueprint.assemblyImplementationMissingCount = metrics.assemblyImplementationMissingCount;
    ctx.blueprint.assemblyImplementationMissingModuleIds = metrics.assemblyImplementationMissingModuleIds;

    ctx.addLog(
      'assembly-complexity-gate',
      'Decision=' + decision.decision +
      ' risk=' + decision.riskLevel +
      ' coverage=' + metrics.assemblyCoverage +
      ' implementation=' + metrics.assemblyImplementationCoverage +
      ' missingImpl=' + metrics.assemblyImplementationMissingCount +
      ' unresolved=' + metrics.unresolvedCount +
      ' modules=' + metrics.moduleInstanceCount +
      ' cuaSteps=' + metrics.cuaStepCount +
      ' legacyScore=' + (metrics.legacyComplexityScore != null ? metrics.legacyComplexityScore : 'n/a')
    );

    if (ctx.reportStatus) {
      ctx.reportStatus('processing', {
        message: '[assembly-gate] ' + decision.summary +
          ' (coverage ' + metrics.assemblyCoverage +
          ', implementation ' + metrics.assemblyImplementationCoverage +
          ', unresolved ' + metrics.unresolvedCount + ')'
      });
    }

    return {
      decision: decision.decision,
      riskLevel: decision.riskLevel,
      fallbackRequired: decision.fallbackRequired,
      assemblyCoverage: metrics.assemblyCoverage,
      assemblyImplementationCoverage: metrics.assemblyImplementationCoverage,
      assemblyImplementationMissingCount: metrics.assemblyImplementationMissingCount,
      assemblyImplementationMissingModuleIds: metrics.assemblyImplementationMissingModuleIds,
      unresolvedCount: metrics.unresolvedCount,
      moduleInstanceCount: metrics.moduleInstanceCount,
      cuaStepCount: metrics.cuaStepCount,
      legacyComplexityScore: metrics.legacyComplexityScore,
      legacyComplexityBand: metrics.legacyComplexityBand,
    };
  },

  _internals: {
    decideAssemblyRisk: decideAssemblyRisk,
  }
};
