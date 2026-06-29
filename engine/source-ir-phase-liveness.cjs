'use strict';

var fs = require('fs');
var path = require('path');
var { pathToFileURL } = require('url');

var {
  extractSourceSceneIrFromHtml,
  loadSourceSceneIr,
  normalizeSourceSceneIr,
  validateSourceSceneIr,
} = require('./source-scene-ir.cjs');
var {
  isHudOnlyEntity,
} = require('./source-visual-ir.cjs');

var SOURCE_IR_PHASE_LIVENESS_KIND = 'blueprint.sourceSceneIR.phaseLivenessReport';
var SOURCE_IR_PHASE_LIVENESS_SCHEMA_VERSION = '1.0.0';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function addViolation(out, code, message, extra) {
  out.push(Object.assign({ code: code, message: message }, extra || {}));
}

function sourcePositionObject(entity) {
  var p = safeArray(entity && entity.position);
  return {
    x: Number(p[0]) || 0,
    y: Number(p[1]) || 0,
    z: Number(p[2]) || 0,
  };
}

function indexById(items) {
  var out = {};
  safeArray(items).forEach(function(item) {
    if (item && item.id) out[item.id] = item;
  });
  return out;
}

function findPlayerId(ir) {
  var exact = safeArray(ir.entities).filter(function(entity) {
    return String(entity.id || '').toLowerCase() === 'player' || String(entity.kind || '').toLowerCase() === 'player';
  })[0];
  var fuzzy = exact || safeArray(ir.entities).filter(function(entity) {
    return /player|hero|主角|角色/i.test(String(entity.id || '') + ' ' + String(entity.label || '') + ' ' + String(entity.kind || ''));
  })[0];
  return fuzzy && fuzzy.id || null;
}

function stepTarget(step) {
  if (!isObject(step)) return '';
  return step.target || step.from || step.to || step.entity || '';
}

function gateTargets(gate) {
  if (!isObject(gate)) return [];
  if (gate.kind === 'compound_all' || gate.kind === 'compound_any') {
    var out = [];
    safeArray(gate.gates).forEach(function(child) {
      gateTargets(child).forEach(function(id) { if (id && out.indexOf(id) < 0) out.push(id); });
    });
    return out;
  }
  if (gate.kind === 'cta_arrival') return [];
  var target = gate.entity || gate.target || '';
  return target ? [target] : [];
}

function isCtaEntity(entityOrId) {
  var id = typeof entityOrId === 'string' ? entityOrId : String(entityOrId && entityOrId.id || '');
  var kind = typeof entityOrId === 'string' ? '' : String(entityOrId && entityOrId.kind || '');
  return /\b(cta|install|download)\b/i.test(kind + ' ' + id) ||
    /^(CtaButton|CTAButton|CTAPopup|InstallButton|DownloadButton)$/i.test(id);
}

function isFinalPhase(index, ir) {
  return index === safeArray(ir && ir.phases).length - 1;
}

function primaryGameplayTarget(targets, entityById, playerId) {
  for (var i = 0; i < safeArray(targets).length; i += 1) {
    var target = targets[i];
    var entity = entityById[target];
    if (!target || target === playerId || isCtaEntity(entity || target) || isHudOnlyEntity(entity)) continue;
    return target;
  }
  return '';
}

function phaseRequiresPlayer(phase, gate, sourceIrRequiresJoystick) {
  if (sourceIrRequiresJoystick) return true;
  if (gate && (gate.kind === 'near_entity' || gate.kind === 'cta_arrival')) return true;
  return safeArray(phase && phase.steps).some(function(step) {
    return [
      'move_to', 'collect', 'deliver', 'transfer', 'select', 'combine',
      'produce', 'reward', 'unlock', 'show', 'build', 'upgrade', 'attack', 'cta_finish',
    ].indexOf(String(step && step.kind || '')) >= 0;
  });
}

function collectResourceDeltas(ir) {
  var totals = {};
  safeArray(ir.resources).forEach(function(resource) {
    totals[resource.id] = Number(resource.initial || 0);
  });
  return totals;
}

function resourceIndex(ir) {
  var out = {};
  safeArray(ir.resources).forEach(function(resource) {
    if (resource && resource.id) out[resource.id] = resource;
  });
  return out;
}

function checkCollectCarrier(step, phase, phaseIndex, show, resourceById, entityById, errors) {
  if (!isObject(step) || step.kind !== 'collect') return;
  var resourceId = step.resource || step.item || '';
  if (!resourceId) {
    addViolation(errors, 'source_ir_collect_resource_missing', phase.id + ' collect step must declare resource', {
      phaseId: phase.id,
    });
    return;
  }
  var resource = resourceById[resourceId] || null;
  if (!resource) {
    addViolation(errors, 'source_ir_collect_resource_unknown', phase.id + ' collect step references unknown resource: ' + resourceId, {
      phaseId: phase.id,
      resource: resourceId,
    });
    return;
  }
  var declaredCarrier = resource.carrierEntity || resource.carrier || '';
  var stepCarrier = step.from || step.target || declaredCarrier || '';
  if (!stepCarrier) {
    addViolation(errors, 'source_ir_collect_carrier_missing', phase.id + ' collect step must declare from/target or resource.carrierEntity', {
      phaseId: phase.id,
      resource: resourceId,
    });
    return;
  }
  if (declaredCarrier && stepCarrier !== declaredCarrier) {
    addViolation(errors, 'source_ir_collect_carrier_mismatch', phase.id + ' collect target does not match resource carrierEntity', {
      phaseId: phase.id,
      resource: resourceId,
      stepCarrier: stepCarrier,
      resourceCarrier: declaredCarrier,
    });
    return;
  }
  var entity = entityById[stepCarrier];
  if (!entity) {
    addViolation(errors, 'source_ir_collect_carrier_entity_missing', phase.id + ' collect carrier entity is missing: ' + stepCarrier, {
      phaseId: phase.id,
      resource: resourceId,
      carrier: stepCarrier,
    });
  } else if (isHudOnlyEntity(entity)) {
    addViolation(errors, 'source_ir_collect_carrier_hud_only', phase.id + ' collect carrier is HUD-only: ' + stepCarrier, {
      phaseId: phase.id,
      resource: resourceId,
      carrier: stepCarrier,
    });
  } else if (show.indexOf(stepCarrier) < 0) {
    addViolation(errors, 'source_ir_collect_carrier_not_visible', phase.id + ' collect carrier is not visible in showEntities: ' + stepCarrier, {
      phaseId: phase.id,
      resource: resourceId,
      carrier: stepCarrier,
      phaseIndex: phaseIndex,
    });
  }
}

function stateValueOrDefault(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  var number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function applyEntityStateDelta(entityStates, entity, value) {
  if (!entity) return;
  var next = stateValueOrDefault(value, 1);
  if (next <= 0) entityStates[entity] = next;
  else entityStates[entity] = Math.max(Number(entityStates[entity] || 0), next);
}

function applyStepDelta(step, resources, entityStates) {
  if (!isObject(step)) return;
  if (step.kind === 'collect' && step.resource) {
    resources[step.resource] = Number(resources[step.resource] || 0) + (Number(step.amount) || 1);
  } else if (step.kind === 'produce' && step.resource) {
    resources[step.resource] = Number(resources[step.resource] || 0) + (Number(step.amount) || 1);
  } else if (step.kind === 'reward' && step.resource) {
    resources[step.resource] = Number(resources[step.resource] || 0) + (Number(step.amount) || 1);
  } else if (step.kind === 'deliver' && step.resource) {
    resources[step.resource] = Math.max(0, Number(resources[step.resource] || 0) - (Number(step.amount) || 1));
    if (step.target || step.to) {
      var deliverTarget = step.target || step.to;
      applyEntityStateDelta(entityStates, deliverTarget, step.state == null ? 1 : step.state);
    }
  } else if (step.kind === 'transfer' && step.resource) {
    resources[step.resource] = Math.max(0, Number(resources[step.resource] || 0) - (Number(step.amount) || 1));
    if (step.target || step.to) {
      var transferTarget = step.target || step.to;
      applyEntityStateDelta(entityStates, transferTarget, step.state == null ? 1 : step.state);
    }
  } else if (step.kind === 'set_resource' && step.resource) {
    resources[step.resource] = Number(step.amount != null ? step.amount : step.value) || 0;
  } else if (step.kind === 'set_entity_state' && step.entity) {
    applyEntityStateDelta(entityStates, step.entity, step.state == null ? 1 : step.state);
  } else if ((step.kind === 'build' || step.kind === 'upgrade' || step.kind === 'unlock' || step.kind === 'show' || step.kind === 'combine' || step.kind === 'select') && (step.entity || step.target)) {
    var id = step.entity || step.target;
    applyEntityStateDelta(entityStates, id, step.state != null ? step.state : (step.level != null ? step.level : 1));
  } else if (step.kind === 'attack' && (step.entity || step.target)) {
    var attackId = step.entity || step.target;
    applyEntityStateDelta(entityStates, attackId, step.state != null ? step.state : 0);
  }
}

function checkGateSatisfiable(gate, resources, entityStates, phase, phaseIndex, errors, entityById, ir) {
  if (!isObject(gate)) return;
  if (gate.kind === 'compound_all' || gate.kind === 'compound_any') {
    safeArray(gate.gates).forEach(function(child) {
      checkGateSatisfiable(child, resources, entityStates, phase, phaseIndex, errors, entityById, ir);
    });
    return;
  }
  if (gate.kind === 'resource') {
    var have = Number(resources[gate.resource] || 0);
    var need = Number(gate.threshold || gate.amount || 1);
    if (have < need) {
      addViolation(errors, 'source_ir_gate_resource_unsatisfied', 'phase' + (phaseIndex + 1) + ' resource gate cannot be reached by declared step deltas', {
        phaseId: phase.id,
        resource: gate.resource,
        required: need,
        availableAfterPhase: have,
      });
    }
  } else if (gate.kind === 'entity_state') {
    var state = Number(entityStates[gate.entity || gate.target] || 0);
    var required = Number(gate.state == null ? 1 : gate.state);
    var unsatisfied = required <= 0 ? state > required : state < required;
    if (unsatisfied) {
      addViolation(errors, 'source_ir_gate_entity_state_unsatisfied', 'phase' + (phaseIndex + 1) + ' entity_state gate cannot be reached by declared step deltas', {
        phaseId: phase.id,
        entity: gate.entity || gate.target,
        required: required,
        availableAfterPhase: state,
      });
    }
  } else if (gate.kind === 'near_entity' || gate.kind === 'cta_arrival') {
    var target = gate.ctaId || gate.entity || gate.target || 'CtaButton';
    if (isCtaEntity(target) && isFinalPhase(phaseIndex, ir)) {
      return;
    }
    if (!entityById[target]) {
      addViolation(errors, 'source_ir_gate_target_missing', 'phase' + (phaseIndex + 1) + ' gate target is missing: ' + target, {
        phaseId: phase.id,
        target: target,
      });
    } else if (isHudOnlyEntity(entityById[target])) {
      addViolation(errors, 'source_ir_gate_target_hud_only', 'phase' + (phaseIndex + 1) + ' gate target is HUD-only: ' + target, {
        phaseId: phase.id,
        target: target,
      });
    }
  } else if (gate.kind === 'entity_count') {
    addViolation(errors, 'source_ir_gate_liveness_unsupported', 'phase' + (phaseIndex + 1) + ' entity_count gates are not executable by the SourceIR preview liveness probe yet', {
      phaseId: phase.id,
      gateKind: gate.kind,
    });
  }
}

function analyzeSourceIrPhaseLiveness(sourceIr, options) {
  options = options || {};
  var ir = normalizeSourceSceneIr(sourceIr, options);
  validateSourceSceneIr(ir);
  var entityById = indexById(ir.entities);
  var playerId = findPlayerId(ir);
  var player = playerId && entityById[playerId] || null;
  var resources = collectResourceDeltas(ir);
  var resourceById = resourceIndex(ir);
  var entityStates = {};
  var errors = [];
  var phaseSummaries = [];
  var requiresJoystick = !!(ir.runtimeContract && ir.runtimeContract.requiresJoystick);
  var previousPrimaryTarget = '';
  var previousPrimaryPhaseId = '';

  if (!playerId || !player) {
    addViolation(errors, 'source_ir_player_missing', 'SourceIR phase liveness requires a Player/player-like entity');
  } else if (isHudOnlyEntity(player)) {
    addViolation(errors, 'source_ir_player_hud_only', 'Player entity is marked HUD-only', { playerId: playerId });
  }

  safeArray(ir.phases).forEach(function(phase, index) {
    var expectedId = 'phase' + (index + 1);
    var show = safeArray(phase && phase.showEntities);
    var showMap = {};
    show.forEach(function(id) { showMap[id] = true; });
    if (phase.id !== expectedId) {
      addViolation(errors, 'source_ir_phase_id_not_sequential', 'phase id must be sequential: expected ' + expectedId + ', got ' + phase.id, {
        phaseId: phase.id,
        expectedId: expectedId,
      });
    }
    if (!safeArray(phase.steps).length && !(phase.gate && phase.gate.kind === 'timer')) {
      addViolation(errors, 'source_ir_phase_steps_missing', phase.id + ' must declare executable steps', { phaseId: phase.id });
    }
    var needsPlayer = phaseRequiresPlayer(phase, phase.gate, requiresJoystick);
    if (needsPlayer && playerId && show.indexOf(playerId) < 0) {
      addViolation(errors, 'source_ir_phase_player_not_visible', phase.id + ' requires joystick/player interaction but does not list ' + playerId + ' in showEntities', {
        phaseId: phase.id,
        playerId: playerId,
      });
    }
    var targets = [];
    safeArray(phase.steps).forEach(function(step) {
      checkCollectCarrier(step, phase, index, show, resourceById, entityById, errors);
      var target = stepTarget(step);
      if (target && targets.indexOf(target) < 0) targets.push(target);
    });
    gateTargets(phase.gate).forEach(function(target) {
      if (target && targets.indexOf(target) < 0) targets.push(target);
    });
    targets.forEach(function(target) {
      if (isCtaEntity(target) && isFinalPhase(index, ir)) return;
      if (isCtaEntity(target) && !isFinalPhase(index, ir)) {
        addViolation(errors, 'source_ir_non_final_cta_target', phase.id + ' references CTA as a gameplay target before the final phase: ' + target, {
          phaseId: phase.id,
          target: target,
        });
        return;
      }
      var entity = entityById[target];
      if (!entity) {
        addViolation(errors, 'source_ir_phase_target_missing', phase.id + ' references missing target: ' + target, {
          phaseId: phase.id,
          target: target,
        });
      } else if (isHudOnlyEntity(entity)) {
        addViolation(errors, 'source_ir_phase_target_hud_only', phase.id + ' target is HUD-only and cannot drive gameplay: ' + target, {
          phaseId: phase.id,
          target: target,
        });
      } else if (target !== playerId && show.indexOf(target) < 0) {
        addViolation(errors, 'source_ir_phase_target_not_visible', phase.id + ' target is not visible in showEntities: ' + target, {
          phaseId: phase.id,
          target: target,
        });
      }
    });

    safeArray(phase.steps).forEach(function(step) {
      applyStepDelta(step, resources, entityStates);
    });
    checkGateSatisfiable(phase.gate, resources, entityStates, phase, index, errors, entityById, ir);
    var primaryTarget = primaryGameplayTarget(targets, entityById, playerId);
    if (primaryTarget && previousPrimaryTarget && primaryTarget === previousPrimaryTarget) {
      addViolation(errors, 'source_ir_consecutive_phase_target_shared', phase.id + ' shares primary target with the previous phase: ' + primaryTarget, {
        phaseId: phase.id,
        previousPhaseId: previousPrimaryPhaseId,
        target: primaryTarget,
      });
    }
    previousPrimaryTarget = primaryTarget;
    previousPrimaryPhaseId = phase.id;
    phaseSummaries.push({
      id: phase.id,
      index: index,
      showEntities: show,
      targetSequence: targets,
      primaryTarget: primaryTarget,
      requiresPlayer: needsPlayer,
      gate: phase.gate && phase.gate.kind || null,
      resourceSnapshot: Object.assign({}, resources),
      entityStateSnapshot: Object.assign({}, entityStates),
    });
  });

  return {
    passed: errors.length === 0,
    summary: {
      phaseCount: ir.phases.length,
      entityCount: ir.entities.length,
      playerId: playerId,
      requiresJoystick: requiresJoystick,
      checkedPhases: phaseSummaries.length,
    },
    phases: phaseSummaries,
    violations: errors,
  };
}

function currentPhaseIndex(phase, completedCount, total) {
  if (String(phase || '') === 'gameEnd') return total;
  var match = String(phase || '').match(/\d+/);
  if (match) return Math.max(0, Math.min(total - 1, Number(match[0]) - 1));
  return Math.max(0, Math.min(total - 1, Number(completedCount) || 0));
}

function targetForProbe(ir, phaseIndex, stepIndex) {
  var phase = safeArray(ir.phases)[phaseIndex] || null;
  if (!phase) return null;
  var steps = safeArray(phase.steps);
  var index = Math.max(0, Number(stepIndex) || 0);
  if (index >= steps.length) return gateTargets(phase.gate)[0] || null;
  var step = steps[index] || null;
  var target = stepTarget(step) || (gateTargets(phase.gate)[0] || '');
  return target || null;
}

async function runBrowserProbe(htmlPath, sourceIr, options) {
  options = options || {};
  var playwright = require('playwright');
  var ir = normalizeSourceSceneIr(sourceIr, options);
  var entityById = indexById(ir.entities);
  var playerId = findPlayerId(ir);
  var maxTicks = Number(options.maxTicks || ir.phases.length * 260) || 1200;
  var browser = await playwright.chromium.launch({ headless: true });
  var page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  var errors = [];
  var samples = [];
  try {
    await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'domcontentloaded', timeout: Number(options.loadTimeoutMs || 60000) });
    await page.waitForTimeout(Number(options.settleMs || 600));
    var api = await page.evaluate(function() {
      return {
        hasGameState: typeof window.__gameState === 'function',
        hasSetJoystick: typeof window.__sourceIrPreviewSetJoystick === 'function',
        hasRuntimeTick: typeof window.__sourceIrPreviewRuntimeTick === 'function',
      };
    });
    if (!api.hasGameState || !api.hasSetJoystick || !api.hasRuntimeTick) {
      addViolation(errors, 'source_ir_liveness_probe_api_missing', 'SourceIR preview must expose __gameState, __sourceIrPreviewSetJoystick, and __sourceIrPreviewRuntimeTick', api);
      return { passed: false, skipped: false, reason: 'probe_api_missing', samples: samples, violations: errors };
    }
    var lastCompleted = -1;
    var stagnantTicks = 0;
    for (var tick = 0; tick < maxTicks; tick += 1) {
      var state = await page.evaluate(function() {
        var gs = window.__gameState();
        var states = gs.entity_states || gs.entityStates || {};
        return {
          phase: gs.phase,
          completedPhases: Array.isArray(gs.completedPhases) ? gs.completedPhases.slice() : [],
          currentStepIndex: gs.ui_state && gs.ui_state.currentStepIndex || gs.uiState && gs.uiState.currentStepIndex || 0,
          entityStates: states,
          resources: Object.assign({}, gs.resources || gs.inventory || {}),
        };
      });
      var completedCount = safeArray(state.completedPhases).length;
      if (completedCount !== lastCompleted) {
        samples.push({
          tick: tick,
          phase: state.phase,
          completedCount: completedCount,
          completedPhases: state.completedPhases,
          currentStepIndex: state.currentStepIndex,
          resources: state.resources,
        });
        lastCompleted = completedCount;
        stagnantTicks = 0;
      } else {
        stagnantTicks += 1;
      }
      if (String(state.phase) === 'gameEnd' || completedCount >= ir.phases.length) {
        await page.evaluate(function() {
          window.__sourceIrPreviewSetJoystick(0, 0, false);
        });
        return {
          passed: true,
          skipped: false,
          reason: 'completed',
          tickCount: tick + 1,
          completedPhases: state.completedPhases,
          samples: samples,
          violations: [],
        };
      }
      if (stagnantTicks > Number(options.maxStagnantTicks || 220)) {
        addViolation(errors, 'source_ir_phase_liveness_stalled', 'source HTML liveness probe stalled before completing all phases', {
          tick: tick,
          phase: state.phase,
          completedCount: completedCount,
          targetCompleted: ir.phases.length,
          samples: samples.slice(-5),
        });
        break;
      }
      var phaseIndex = currentPhaseIndex(state.phase, completedCount, ir.phases.length);
      var targetId = targetForProbe(ir, phaseIndex, state.currentStepIndex);
      var playerState = playerId && state.entityStates && state.entityStates[playerId] || null;
      var playerPos = playerState && playerState.position || sourcePositionObject(entityById[playerId]);
      var targetEntity = targetId && entityById[targetId] || null;
      var targetState = targetId && state.entityStates && state.entityStates[targetId] || null;
      var targetPos = targetState && targetState.position || sourcePositionObject(targetEntity);
      var dx = 0;
      var dz = 0;
      if (targetEntity && !isHudOnlyEntity(targetEntity)) {
        var vx = Number(targetPos.x || 0) - Number(playerPos.x || 0);
        var vz = Number(targetPos.z || 0) - Number(playerPos.z || 0);
        var distance = Math.sqrt(vx * vx + vz * vz);
        if (distance > 0.05) {
          dx = vx / distance;
          dz = vz / distance;
        }
      }
      await page.evaluate(function(input) {
        window.__sourceIrPreviewSetJoystick(input.dx, input.dz, true);
        for (var i = 0; i < 4; i += 1) window.__sourceIrPreviewRuntimeTick(0.05);
      }, { dx: dx, dz: dz });
    }
    if (!errors.length) {
      addViolation(errors, 'source_ir_phase_liveness_timeout', 'source HTML did not complete all phases within joystick probe budget', {
        maxTicks: maxTicks,
        samples: samples.slice(-8),
      });
    }
    return { passed: false, skipped: false, reason: 'failed', samples: samples, violations: errors };
  } finally {
    await browser.close();
  }
}

function loadInput(inputPath, options) {
  options = options || {};
  var abs = path.resolve(inputPath);
  var text = fs.readFileSync(abs, 'utf8');
  if (/\.json$/i.test(abs)) {
    return {
      inputKind: 'source-ir-json',
      html: null,
      sourceIr: loadSourceSceneIr(abs),
    };
  }
  return {
    inputKind: 'source-ir-html',
    html: text,
    sourceIr: extractSourceSceneIrFromHtml(text, abs, Object.assign({}, options, {
      repairPhaseLiveness: false,
    })),
  };
}

async function evaluateSourceIrPhaseLiveness(inputPath, options) {
  options = options || {};
  var loaded;
  try {
    loaded = loadInput(inputPath, options);
  } catch (error) {
    return {
      schemaVersion: SOURCE_IR_PHASE_LIVENESS_SCHEMA_VERSION,
      kind: SOURCE_IR_PHASE_LIVENESS_KIND,
      generatedAt: options.generatedAt || new Date().toISOString(),
      inputPath: path.resolve(inputPath),
      inputKind: /\.json$/i.test(String(inputPath || '')) ? 'source-ir-json' : 'source-ir-html',
      passed: false,
      summary: {
        sourceSceneIrHash: null,
        phaseCount: 0,
        playerId: null,
        staticPassed: false,
        browserProbePassed: null,
        browserProbeSkipped: true,
        completedPhases: [],
      },
      static: null,
      browser: {
        passed: null,
        skipped: true,
        reason: 'input_invalid',
        violations: [],
        samples: [],
      },
      violations: [{
        code: 'source_ir_phase_liveness_input_invalid',
        message: error && error.message || String(error),
      }],
    };
  }
  var livenessOptions = Object.assign({}, options);
  if (loaded.inputKind === 'source-ir-html') livenessOptions.repairPhaseLiveness = false;
  var staticReport = analyzeSourceIrPhaseLiveness(loaded.sourceIr, livenessOptions);
  var browser = {
    passed: null,
    skipped: true,
    reason: loaded.inputKind === 'source-ir-html' ? 'static_failed_or_static_only' : 'json_input_no_executable_html',
    violations: [],
    samples: [],
  };
  if (loaded.inputKind === 'source-ir-html' && options.staticOnly !== true && staticReport.passed) {
    browser = await runBrowserProbe(inputPath, loaded.sourceIr, livenessOptions);
  }
  var violations = [].concat(staticReport.violations || [], browser.violations || []);
  return {
    schemaVersion: SOURCE_IR_PHASE_LIVENESS_SCHEMA_VERSION,
    kind: SOURCE_IR_PHASE_LIVENESS_KIND,
    generatedAt: options.generatedAt || new Date().toISOString(),
    inputPath: path.resolve(inputPath),
    inputKind: loaded.inputKind,
    passed: violations.length === 0 && (loaded.inputKind !== 'source-ir-html' || options.staticOnly === true || browser.passed === true),
    summary: {
      sourceSceneIrHash: loaded.sourceIr.semanticHash,
      phaseCount: staticReport.summary.phaseCount,
      playerId: staticReport.summary.playerId,
      staticPassed: staticReport.passed,
      browserProbePassed: browser.passed,
      browserProbeSkipped: browser.skipped === true,
      completedPhases: browser.completedPhases || [],
    },
    static: staticReport,
    browser: browser,
    violations: violations,
  };
}

module.exports = {
  SOURCE_IR_PHASE_LIVENESS_KIND: SOURCE_IR_PHASE_LIVENESS_KIND,
  SOURCE_IR_PHASE_LIVENESS_SCHEMA_VERSION: SOURCE_IR_PHASE_LIVENESS_SCHEMA_VERSION,
  analyzeSourceIrPhaseLiveness: analyzeSourceIrPhaseLiveness,
  evaluateSourceIrPhaseLiveness: evaluateSourceIrPhaseLiveness,
  runBrowserProbe: runBrowserProbe,
};
