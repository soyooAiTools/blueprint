/**
 * Spec Conformance Checker
 * Validates generated code against blueprint spec semantics:
 *   - Phase completion calls exist
 *   - Required interaction handlers present
 *   - Entity pool references correct
 *   - Trigger condition tokens present
 */

function checkConformance(csCode, blueprint) {
  var issues = [];
  var specs = blueprint.specs || [];
  if (specs.length === 0) return { passed: true, issues: [], criticalCount: 0, warningCount: 0 };

  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    var phaseId = spec.phaseId;

    // 1. Phase must have AddCompletedPhase or ReportPhase call (not just any string mention)
    var inAddCompleted = csCode.indexOf('AddCompletedPhase("' + phaseId + '"') >= 0;
    var inReportPhase = csCode.indexOf('ReportPhase("' + phaseId + '"') >= 0;
    var inCheckEvent = csCode.indexOf('CheckEventRules("' + phaseId + '"') >= 0;
    if (!inAddCompleted && !inReportPhase && !inCheckEvent) {
      issues.push({
        severity: 'critical',
        phase: phaseId,
        message: 'Phase "' + phaseId + '" has no AddCompletedPhase/ReportPhase/CheckEventRules call — phase will never complete',
      });
    }

    // 2. Required interactions — verify handler patterns in code
    var interactions = spec.requiredInteractions || [];
    var verbPatterns = {
      'click': /OnPointerClick|OnMouseDown|PointerClick|onClick/,
      'drag': /OnDrag|IDragHandler|OnBeginDrag|EventTriggerType\.Drag/,
      'swipe': /swipe|OnDrag.*delta/i,
      'tap': /OnPointerClick|OnMouseDown|PointerDown/,
      'hold': /holdTime|pressTime|OnPointerDown/i,
      'collect': /collect|pickup|gather/i,
      'shoot': /shoot|fire|bullet|projectile/i,
      'merge': /merge|combine|match/i,
    };
    for (var j = 0; j < interactions.length; j++) {
      var verb = interactions[j];
      var verbKey = verb.split('_')[0].toLowerCase();
      if (verbPatterns[verbKey] && !verbPatterns[verbKey].test(csCode)) {
        issues.push({
          severity: 'warning',
          phase: phaseId,
          message: 'Phase "' + phaseId + '" requires "' + verb + '" but no matching interaction handler found',
        });
      }
    }

    // 3. Entity pool references — check entities are actually Find()'d in code
    var entities = spec.entitiesRequired || [];
    var entityPoolMap = blueprint.entityPoolMap || {};
    for (var k = 0; k < entities.length; k++) {
      var entityName = entities[k].name || entities[k];
      var poolName = entityPoolMap[entityName];
      if (poolName && csCode.indexOf('"' + poolName + '"') < 0) {
        issues.push({
          severity: 'warning',
          phase: phaseId,
          message: 'Entity "' + entityName + '" (pool: ' + poolName + ') not referenced via Find("' + poolName + '")',
        });
      }
    }

    // 4. Trigger condition — check key variable/function tokens appear in code
    if (spec.triggerNext && spec.triggerNext.condition) {
      var condTokens = spec.triggerNext.condition.match(/[a-zA-Z_]\w{3,}/g) || [];
      var reserved = ['true', 'false', 'null', 'this', 'void', 'else', 'return', 'while', 'string', 'float'];
      var importantTokens = condTokens.filter(function(t) { return reserved.indexOf(t) < 0; });
      if (importantTokens.length > 0) {
        var missingTokens = importantTokens.filter(function(t) { return csCode.indexOf(t) < 0; });
        if (missingTokens.length > importantTokens.length * 0.5) {
          issues.push({
            severity: 'warning',
            phase: phaseId,
            message: 'Trigger "' + spec.triggerNext.condition + '" — key tokens missing: ' + missingTokens.join(', '),
          });
        }
      }
    }
  }

  var criticals = issues.filter(function(i) { return i.severity === 'critical'; });
  return {
    passed: criticals.length === 0,
    issues: issues,
    criticalCount: criticals.length,
    warningCount: issues.length - criticals.length,
  };
}

module.exports = { checkConformance: checkConformance };
