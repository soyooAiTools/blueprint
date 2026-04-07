/**
 * Stage: spec-validate — Validate blueprint specs before codegen
 *
 * Ensures specs have 100% chapter coverage, non-empty triggers,
 * valid entity references, known interaction verbs, and sane durations.
 *
 * Reads: ctx.blueprint.specs, ctx.blueprint.entities, ctx.blueprint.storyboard
 * Writes: ctx.blueprint.specs (auto-fixed durations)
 */

var fs = require('fs');
var path = require('path');

// Load interaction verb whitelist
var KNOWN_VERBS = {};
var VERB_VALIDATION_ENABLED = false;
try {
  var verbsFile = path.join(__dirname, '..', '..', 'worker', 'interaction-verbs.json');
  var verbsData = JSON.parse(fs.readFileSync(verbsFile, 'utf8'));
  var categories = verbsData.verbs || {};
  for (var cat in categories) {
    for (var verb in categories[cat]) {
      KNOWN_VERBS[verb] = categories[cat][verb];
    }
  }
  VERB_VALIDATION_ENABLED = Object.keys(KNOWN_VERBS).length > 0;
} catch(e) {
  console.warn('[spec-validate] interaction-verbs.json not loaded: ' + e.message + ' — verb validation DISABLED');
}

module.exports = {
  name: 'spec-validate',
  canRetry: false,
  canSkip: function(ctx) {
    // Skip if no specs (AI generates from storyboard narrative)
    return !ctx.blueprint.specs || ctx.blueprint.specs.length === 0;
  },
  execute: function(ctx) {
    ctx.addLog('spec-validate', 'Validating blueprint specs...');
    var specs = ctx.blueprint.specs;
    var errors = [];    // BLOCK — pipeline stops
    var warnings = [];  // WARN — logged but continues
    var autoFixes = []; // AUTO-FIX — corrected in place

    // --- 1. 100% chapter coverage ---
    var expectedChapters = getExpectedChapterCount(ctx.blueprint);
    if (expectedChapters > 0 && specs.length < expectedChapters) {
      errors.push('Spec coverage incomplete: got ' + specs.length + '/' + expectedChapters +
        ' chapters. Every chapter must have a spec.');
    }

    // --- 2. Per-spec validation ---
    var entityNames = new Set();
    if (ctx.blueprint.entities && ctx.blueprint.entities.length > 0) {
      ctx.blueprint.entities.forEach(function(e) {
        entityNames.add(e.name);
        if (e.poolName) entityNames.add(e.poolName);
      });
    }

    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var label = 'Spec[' + i + '] ' + (spec.phaseId || 'unnamed');

      // --- BLOCK: empty trigger condition ---
      if (spec.triggerNext) {
        var cond = (spec.triggerNext.condition || '').trim();
        if (!cond || cond === 'true' || cond === 'false') {
          errors.push(label + ': triggerNext.condition is empty or trivial ("' + cond + '"). Must specify real C# condition.');
        }
      } else if (i < specs.length - 1) {
        // Non-final spec must have triggerNext
        errors.push(label + ': missing triggerNext (non-final phase must define transition condition)');
      }

      // --- BLOCK: entity references not in blueprint.entities ---
      if (spec.entitiesRequired && spec.entitiesRequired.length > 0 && entityNames.size > 0) {
        spec.entitiesRequired.forEach(function(ent) {
          if (!entityNames.has(ent.name)) {
            errors.push(label + ': entity "' + ent.name + '" not found in blueprint.entities. Known: ' +
              Array.from(entityNames).slice(0, 10).join(', '));
          }
        });
      }

      // --- WARN: unknown interaction verbs ---
      if (spec.requiredInteractions && spec.requiredInteractions.length > 0) {
        spec.requiredInteractions.forEach(function(interaction) {
          var verb = interaction.split(':')[0];
          if (VERB_VALIDATION_ENABLED && !KNOWN_VERBS[verb]) {
            errors.push(label + ': unknown interaction verb "' + verb + '" — will cause unpredictable AI code generation. Known: ' +
              Object.keys(KNOWN_VERBS).slice(0, 8).join(', ') + '...');
          }
        });
      }

      // --- WARN: playerMustAct=false but autoAllowed=false ---
      if (spec.playerMustAct === false && spec.autoAllowed === false) {
        warnings.push(label + ': playerMustAct=false but autoAllowed=false — contradictory');
      }

      // --- AUTO-FIX: duration sanity ---
      if (spec.duration) {
        if (spec.duration.min > spec.duration.max) {
          autoFixes.push(label + ': duration min(' + spec.duration.min + ') > max(' + spec.duration.max + ') — swapped');
          var tmp = spec.duration.min;
          spec.duration.min = spec.duration.max;
          spec.duration.max = tmp;
        }
        if (spec.duration.min <= 0) {
          autoFixes.push(label + ': duration.min was ' + spec.duration.min + ' — set to 1');
          spec.duration.min = 1;
        }
      }
    }


    // --- 3. Trigger condition references entities check ---
    for (var ti = 0; ti < specs.length; ti++) {
      var tSpec = specs[ti];
      var tLabel = 'Spec[' + ti + '] ' + (tSpec.phaseId || 'unnamed');
      if (tSpec.triggerNext && tSpec.triggerNext.condition) {
        var cond = tSpec.triggerNext.condition;
        var tEnts = tSpec.entitiesRequired || [];
        // If spec has entities, at least one entity name should appear in the condition
        // (as entityNameState pattern from skeleton generator)
        if (tEnts.length > 0) {
          var hasEntityRef = false;
          for (var te = 0; te < tEnts.length; te++) {
            var stateVar = tEnts[te].name + 'State';
            var rawName = tEnts[te].name;
            if (cond.indexOf(stateVar) >= 0 || cond.indexOf(rawName) >= 0) {
              hasEntityRef = true;
              break;
            }
          }
          if (!hasEntityRef) {
            warnings.push(tLabel + ': triggerNext.condition "' + cond.substring(0, 60) +
              '" does not reference any entity from entitiesRequired (' +
              tEnts.map(function(e) { return e.name; }).join(', ') +
              '). This may cause condition-entity mismatch in generated code.');
          }
        }
      }
    }

    // --- 4. Phase graph dead-end check ---
    // Verify all non-final specs have triggerNext that can lead to the next phase
    for (var gi = 0; gi < specs.length - 1; gi++) {
      var gSpec = specs[gi];
      var gLabel = 'Spec[' + gi + '] ' + (gSpec.phaseId || 'unnamed');
      if (!gSpec.triggerNext || !gSpec.triggerNext.condition) {
        errors.push(gLabel + ': no triggerNext.condition — phase graph has dead end at phase ' + (gi + 1) +
          '. Next phase (' + (specs[gi + 1].phaseId || 'unnamed') + ') will be unreachable.');
      }
      // Check for phases with playerMustAct=true but no interactions
      if (gSpec.playerMustAct && (!gSpec.requiredInteractions || gSpec.requiredInteractions.length === 0)) {
        warnings.push(gLabel + ': playerMustAct=true but no requiredInteractions defined — ' +
          'AI won\'t know what player action is needed. Consider adding interaction verbs.');
      }
    }

    // --- 5. Entity terminal state consistency ---
    // Check that entities referenced across multiple specs have consistent terminal states
    var entityTerminalStates = {};
    for (var eti = 0; eti < specs.length; eti++) {
      var etEnts = specs[eti].entitiesRequired || [];
      for (var etj = 0; etj < etEnts.length; etj++) {
        var eName = etEnts[etj].name;
        var eState = etEnts[etj].terminalState;
        if (entityTerminalStates[eName] === undefined) {
          entityTerminalStates[eName] = { maxState: eState, phases: [specs[eti].phaseId] };
        } else {
          entityTerminalStates[eName].phases.push(specs[eti].phaseId);
          if (eState > entityTerminalStates[eName].maxState) {
            entityTerminalStates[eName].maxState = eState;
          }
        }
      }
    }
    // Log multi-phase entities for visibility
    var multiPhaseEntities = Object.keys(entityTerminalStates).filter(function(k) {
      return entityTerminalStates[k].phases.length > 1;
    });
    if (multiPhaseEntities.length > 0) {
      ctx.addLog('spec-validate', 'Multi-phase entities: ' + multiPhaseEntities.map(function(k) {
        return k + '(state 0→' + entityTerminalStates[k].maxState + ' across ' + entityTerminalStates[k].phases.join(',') + ')';
      }).join('; '));
    }

    // --- 6. Circular reference detection ---
    // Check if any triggerNext.condition references a previous phase (backwards jump)
    var phaseIdSet = {};
    for (var ci = 0; ci < specs.length; ci++) {
      phaseIdSet[specs[ci].phaseId] = ci;
    }
    for (var cri = 0; cri < specs.length; cri++) {
      var crSpec = specs[cri];
      var crLabel = 'Spec[' + cri + '] ' + (crSpec.phaseId || 'unnamed');
      if (crSpec.triggerNext && crSpec.triggerNext.condition) {
        var crCond = crSpec.triggerNext.condition;
        // Check if condition text references any earlier phase ID (potential loop)
        for (var crj = 0; crj <= cri; crj++) {
          var earlierPhaseId = specs[crj].phaseId;
          if (earlierPhaseId && crCond.indexOf(earlierPhaseId) >= 0 && crj !== cri) {
            errors.push(crLabel + ': triggerNext.condition references earlier phase "' + earlierPhaseId +
              '" (Spec[' + crj + ']) — creates circular dependency. Phase graph must be acyclic (linear forward progression).');
          }
        }
      }
      // Also check if any spec's nextPhase points backwards (explicit graph cycle)
      if (crSpec.nextPhase && phaseIdSet[crSpec.nextPhase] !== undefined) {
        var nextIdx = phaseIdSet[crSpec.nextPhase];
        if (nextIdx <= cri) {
          errors.push(crLabel + ': nextPhase "' + crSpec.nextPhase + '" points to Spec[' + nextIdx +
            '] which is at or before current position — circular reference detected.');
        }
      }
    }

    // --- 7. Unreachable phase detection ---
    // First phase is always reachable. Subsequent phases are reachable if the previous phase has a valid triggerNext.
    for (var uri = 1; uri < specs.length; uri++) {
      var prevSpec = specs[uri - 1];
      var urLabel = 'Spec[' + uri + '] ' + (specs[uri].phaseId || 'unnamed');
      if (!prevSpec.triggerNext || !(prevSpec.triggerNext.condition || '').trim()) {
        warnings.push(urLabel + ': potentially unreachable — previous phase "' +
          (prevSpec.phaseId || 'unnamed') + '" has no triggerNext.condition to transition here.');
      }
    }

    // --- Log results ---
    if (autoFixes.length > 0) {
      autoFixes.forEach(function(f) { ctx.addLog('spec-validate', 'AUTO-FIX: ' + f); });
    }
    if (warnings.length > 0) {
      warnings.forEach(function(w) { ctx.addLog('spec-validate', 'WARN: ' + w); });
    }

    // --- BLOCK on errors ---
    if (errors.length > 0) {
      errors.forEach(function(e) { ctx.addLog('spec-validate', 'ERROR: ' + e); });
      throw new Error('Spec validation failed: ' + errors.length + ' error(s):\n' + errors.join('\n'));
    }

    ctx.addLog('spec-validate', 'Passed (' + specs.length + ' specs, ' +
      warnings.length + ' warning(s), ' + autoFixes.length + ' auto-fix(es))');

    return Promise.resolve({
      valid: true,
      specsCount: specs.length,
      warnings: warnings,
      autoFixes: autoFixes,
    });
  },
};

/**
 * Determine expected chapter count from storyboard frames.
 */
function getExpectedChapterCount(blueprint) {
  var frames = null;
  if (blueprint.storyboard && blueprint.storyboard.frames) {
    frames = blueprint.storyboard.frames;
  } else if (blueprint.shots) {
    frames = blueprint.shots;
  }
  if (!frames || frames.length === 0) return 0;

  // Count unique chapters
  var chapters = new Set();
  frames.forEach(function(f) {
    var ch = f.chapter || f.chapterId || f.chapterNumber;
    if (ch) chapters.add(ch);
  });

  // If no chapter markers, each frame is a chapter
  return chapters.size > 0 ? chapters.size : frames.length;
}
