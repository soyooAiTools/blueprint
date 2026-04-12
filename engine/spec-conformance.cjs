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

  // P1: Extract all phaseId strings from actual code for fuzzy matching
  var codePhaseIds = [];
  var phaseIdMatches = csCode.match(/(?:AddCompletedPhase|ReportPhase|CheckEventRules)\s*\(\s*"([^"]+)"/g) || [];
  for (var pmi = 0; pmi < phaseIdMatches.length; pmi++) {
    var idMatch = phaseIdMatches[pmi].match(/"([^"]+)"/);
    if (idMatch && codePhaseIds.indexOf(idMatch[1]) < 0) codePhaseIds.push(idMatch[1]);
  }
  var codePhaseIdsNorm = codePhaseIds.map(function(id) { return id.toLowerCase().replace(/[_\s-]/g, ''); });

  function fuzzyMatchPhaseId(pid) {
    // Level 1: exact string in code
    if (csCode.indexOf('"' + pid + '"') >= 0) return true;
    // Level 2: normalized match
    var pidNorm = pid.toLowerCase().replace(/[_\s-]/g, '');
    for (var ci = 0; ci < codePhaseIdsNorm.length; ci++) {
      if (codePhaseIdsNorm[ci] === pidNorm ||
          codePhaseIdsNorm[ci].indexOf(pidNorm) >= 0 ||
          pidNorm.indexOf(codePhaseIdsNorm[ci]) >= 0) return true;
    }
    // Level 3: keyword overlap
    var specWords = pid.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
    for (var cwi = 0; cwi < codePhaseIds.length; cwi++) {
      var codeWords = codePhaseIds[cwi].replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
      var overlap = 0;
      for (var swi = 0; swi < specWords.length; swi++) {
        if (specWords[swi].length >= 3 && codeWords.indexOf(specWords[swi]) >= 0) overlap++;
      }
      if (overlap >= Math.max(2, Math.floor(specWords.length * 0.5))) return true;
    }
    return false;
  }

  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    var phaseId = spec.phaseId;

    // 1. Phase must have AddCompletedPhase or ReportPhase call (fuzzy matched)
    var phaseFound = fuzzyMatchPhaseId(phaseId);
    if (!phaseFound) {
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

    // 5. Phase transition quality — detect trivial/timer-only transitions
    //    CUA often fails because phases auto-progress without real player interaction.
    //    Flag phases that require player action (playerMustAct) but have no interaction handler nearby.
    if (spec.playerMustAct !== false && phaseFound) {
      // Find any AddCompletedPhase call for this phase (exact or fuzzy matched)
      var addPhaseIdx = csCode.indexOf('AddCompletedPhase("' + phaseId + '"');
      if (addPhaseIdx < 0) {
        // Try to find the fuzzy-matched phaseId in code
        for (var fpi = 0; fpi < codePhaseIds.length; fpi++) {
          var testIdx = csCode.indexOf('AddCompletedPhase("' + codePhaseIds[fpi] + '"');
          if (testIdx >= 0) { addPhaseIdx = testIdx; break; }
        }
      }
      if (addPhaseIdx >= 0) {
        // Look at surrounding 500 chars for interaction-related code
        var surroundStart = Math.max(0, addPhaseIdx - 500);
        var surroundEnd = Math.min(csCode.length, addPhaseIdx + 500);
        var surrounding = csCode.substring(surroundStart, surroundEnd);
        var hasInteraction = /OnPointerClick|OnMouseDown|OnDrag|PointerClick|Input\.GetMouse|EventTrigger|onClick|onPointer/.test(surrounding);
        var hasTimerOnly = /timer|Timer|elapsed|deltaTime|timeLeft|countdown/i.test(surrounding) && !hasInteraction;
        if (hasTimerOnly) {
          issues.push({
            severity: 'warning',
            phase: phaseId,
            message: 'Phase "' + phaseId + '" transition appears timer-only (no player interaction found nearby). CUA will likely fail to verify this phase.',
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
