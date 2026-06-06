'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH = path.join(__dirname, '..', 'contracts', 'snapshot-schema.v1.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function numberCloseToOne(value) {
  return typeof value === 'number' && Math.abs(value - 1) < 1e-9;
}

function numberValue(value) {
  var numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseCoveragePair(value) {
  if (typeof value === 'string') {
    var match = value.match(/(\d+)\s*\/\s*(\d+)/);
    if (match) return { covered: Number(match[1]), total: Number(match[2]) };
  }
  if (isObject(value)) {
    var covered = value.covered != null ? value.covered
      : value.completed != null ? value.completed
      : value.completedCount != null ? value.completedCount
      : value.coveredCount;
    var total = value.total != null ? value.total
      : value.expected != null ? value.expected
      : value.expectedCount;
    if (Number.isFinite(Number(covered)) && Number.isFinite(Number(total))) {
      return { covered: Number(covered), total: Number(total) };
    }
  }
  return null;
}

function stripComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function findUserInputListeners(source) {
  var html = stripComments(source);
  var listeners = [];
  var re = /\.addEventListener\s*\(\s*['"]([^'"]+)['"]/g;
  var match;
  var userEvents = {
    click: true,
    mousedown: true,
    mouseup: true,
    pointerdown: true,
    pointerup: true,
    touchstart: true,
    touchend: true,
    keydown: true,
    keyup: true,
  };
  while ((match = re.exec(html))) {
    if (userEvents[match[1]]) listeners.push(match[1]);
  }
  return listeners;
}

function hasJoystickControl(source) {
  var html = stripComments(source);
  var hasControl = /id\s*=\s*["']joystick["']|#[\w-]*joystick|\bjoystick\b/.test(html);
  var hasOverlayUi = /#[\w-]*joystick[\w-]*\s*\{[^}]*\bposition\s*:\s*fixed\b/.test(html)
    || /id\s*=\s*["'][^"']*joystick[^"']*["'][^>]*style\s*=\s*["'][^"']*\bposition\s*:\s*fixed\b/.test(html)
    || /style\s*=\s*["'][^"']*\bposition\s*:\s*fixed\b[^"']*["'][^>]*id\s*=\s*["'][^"']*joystick[^"']*["']/.test(html);
  var hasPointerDown = /(?:document|window|canvas|stage|renderer\.domElement|document\.body)\.addEventListener\s*\(\s*['"]pointerdown['"]|joystick[\s\S]{0,260}\.addEventListener\s*\(\s*['"]pointerdown['"]|\.addEventListener\s*\(\s*['"]pointerdown['"][\s\S]{0,260}joystick/.test(html);
  var hasPointerMove = /(?:document|window|canvas|stage|renderer\.domElement|document\.body)\.addEventListener\s*\(\s*['"]pointermove['"]|joystick[\s\S]{0,260}\.addEventListener\s*\(\s*['"]pointermove['"]|\.addEventListener\s*\(\s*['"]pointermove['"][\s\S]{0,260}joystick/.test(html);
  var hasPointerEnd = /(?:document|window|canvas|stage|renderer\.domElement|document\.body)\.addEventListener\s*\(\s*['"]pointer(?:up|cancel)['"]|joystick[\s\S]{0,320}\.addEventListener\s*\(\s*['"]pointer(?:up|cancel)['"]|\.addEventListener\s*\(\s*['"]pointer(?:up|cancel)['"][\s\S]{0,320}joystick/.test(html);
  var hasAnyPositionStart = /(?:document|window|canvas|stage|renderer\.domElement|document\.body)\.addEventListener\s*\(\s*['"]pointerdown['"]/.test(html);
  var movesJoystickToPointer = /joystick\.style\.(?:left|top)\s*=|joystick\.style\.transform\s*=|showJoystickAt|placeJoystickAt|startJoystickAt/.test(html);
  var joystickVar = html.match(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:document\.)?getElementById\s*\(\s*["']joystick["']\s*\)/);
  if (!movesJoystickToPointer && joystickVar) {
    var escaped = joystickVar[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    movesJoystickToPointer = new RegExp('\\b' + escaped + '\\.style\\.(?:left|top|transform)\\s*=').test(html);
  }
  return hasControl && hasOverlayUi && hasPointerDown && hasPointerMove && hasPointerEnd && hasAnyPositionStart && movesJoystickToPointer;
}

function findAutoProgressPatterns(source) {
  var html = stripComments(source);
  var hits = [];
  var timerRe = /setTimeout\s*\(([\s\S]{0,320}?),\s*(?:\d+|[a-zA-Z_$][\w$]*)\s*\)/g;
  var match;
  while ((match = timerRe.exec(html))) {
    var snippet = match[0].replace(/\s+/g, ' ').slice(0, 220);
    if (/(?:enterPhase|advancePhase|completePhase|finishAndAdvance|phaseIndex\s*(?:=|\+\+|--|\+=|-=)|currentPhase\s*(?:=|\+\+|--|\+=|-=))/.test(match[1])) {
      hits.push(snippet);
    }
  }
  var enterPhaseTimerRe = /function\s+enterPhase\d*\s*\([^)]*\)\s*\{[\s\S]{0,600}?(?:setTimeout|scheduleComplete)\s*\(/g;
  while ((match = enterPhaseTimerRe.exec(html))) {
    hits.push(match[0].replace(/\s+/g, ' ').slice(0, 220));
  }
  return hits;
}

function findDirectClickCompletionPatterns(source) {
  var html = stripComments(source);
  var hits = [];
  var re = /addEventListener\s*\(\s*['"](?:click|pointerdown|touchstart|keydown)['"]\s*,\s*(function\s*\([^)]*\)\s*\{[\s\S]{0,700}?\}|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{[\s\S]{0,700}?\})/g;
  var match;
  while ((match = re.exec(html))) {
    var body = match[1] || '';
    if (!/(?:(?:completePhase|enterPhase|advancePhase|nextPhase|performAction)\s*\(|(?:phaseIndex|currentPhase)\s*(?:=|\+\+|--|\+=|-=))/.test(body)) continue;
    var snippet = match[0].replace(/\s+/g, ' ').slice(0, 220);
    if (!/joystick|setPointerCapture|updateStick/.test(match[0])) hits.push(snippet);
  }
  if (/\bactionBtn\b|执行当前操作/.test(html)) hits.push('actionBtn/执行当前操作 shortcut present');
  return hits;
}

function extractBalancedArrayLiteral(source, openIndex) {
  var depth = 0;
  var quote = null;
  var escaped = false;
  for (var i = openIndex; i < source.length; i += 1) {
    var ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return null;
}

function extractPhasesArrayLiteral(source) {
  var html = stripComments(source);
  var assignmentRe = /(?:\b(?:const|let|var)\s+PHASES\s*=|\bwindow\.PHASES\s*=)/g;
  var match;
  while ((match = assignmentRe.exec(html))) {
    var openIndex = html.indexOf('[', assignmentRe.lastIndex);
    if (openIndex < 0) return null;
    var literal = extractBalancedArrayLiteral(html, openIndex);
    if (literal) return literal;
  }
  return null;
}

function parsePhasesFromSource(source) {
  var literal = extractPhasesArrayLiteral(source);
  if (!literal) {
    return { phases: null, errors: ['PHASES array could not be statically parsed'] };
  }
  try {
    var phases = vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 100 });
    if (!Array.isArray(phases)) return { phases: null, errors: ['PHASES must evaluate to an array'] };
    return { phases: phases, errors: [] };
  } catch (err) {
    return { phases: null, errors: ['PHASES array parse failed: ' + err.message] };
  }
}

function triggerContainsClickEntity(trigger) {
  if (!isObject(trigger)) return false;
  if (trigger.type === 'click_entity') return true;
  return safeArray(trigger.triggers).some(triggerContainsClickEntity);
}

function validatePhaseInteractionPlan(source, opts) {
  opts = opts || {};
  var parsed = parsePhasesFromSource(source);
  var errors = [];
  var nonFinalClickEntityCount = 0;
  var nonFinalMissingJoystickEvidenceCount = 0;
  if (!parsed.phases) {
    if (Number(opts.expectedPhaseCount || 0) > 1) errors = errors.concat(parsed.errors);
    return {
      passed: errors.length === 0,
      errors: errors,
      phaseCount: 0,
      nonFinalClickEntityCount: 0,
      nonFinalMissingJoystickEvidenceCount: 0,
    };
  }
  for (var i = 0; i < parsed.phases.length - 1; i += 1) {
    var phase = parsed.phases[i] || {};
    if (triggerContainsClickEntity(phase.trigger)) {
      nonFinalClickEntityCount += 1;
      errors.push('non-final PHASES[' + i + '] trigger must not use click_entity');
    }
    var modules = safeArray(phase.plannedModuleIds || phase.plannedModules);
    if (modules.indexOf('player_input_joystick') < 0) {
      nonFinalMissingJoystickEvidenceCount += 1;
      errors.push('non-final PHASES[' + i + '] plannedModuleIds must include player_input_joystick');
    }
  }
  return {
    passed: errors.length === 0,
    errors: errors,
    phaseCount: parsed.phases.length,
    nonFinalClickEntityCount: nonFinalClickEntityCount,
    nonFinalMissingJoystickEvidenceCount: nonFinalMissingJoystickEvidenceCount,
  };
}

function findCtaClickHandlersWithoutArrivalGate(source) {
  var html = stripComments(source);
  var hits = [];
  var handlerRe = /addEventListener\s*\(\s*['"](?:click|pointerdown|touchstart)['"][\s\S]{0,1200}?(?:CtaButton|cta_finish|InstallFullGame|gameEnded\s*=\s*true)[\s\S]{0,500}?\}/g;
  var match;
  while ((match = handlerRe.exec(html))) {
    if (!/\b(?:distance|distanceTo|threshold|near|arrival|arrived|bounding|bbox|recordedDistance|proximity)\b/.test(match[0])) {
      hits.push(match[0].replace(/\s+/g, ' ').slice(0, 220));
    }
  }
  return hits;
}

function validateJoystickArrivalEvidence(source) {
  var html = stripComments(source);
  var errors = [];
  if (!/\bplayer_input_joystick\b/.test(html)) errors.push('missing player_input_joystick evidence');
  if (!/\bmove_to_target\b/.test(html)) errors.push('missing move_to_target evidence');
  if (!/\bproximity_trigger\b/.test(html)) errors.push('missing proximity_trigger evidence');
  if (!/distanceTo\s*\(|\.distanceTo\s*\(|recordedDistance|arrived/.test(html)) {
    errors.push('missing distance/proximity arrival check');
  }
  return { passed: errors.length === 0, errors: errors };
}

function extractShowEntities(source) {
  var html = stripComments(source);
  var names = {};
  var re = /showEntities\s*:\s*\[([\s\S]*?)\]/g;
  var match;
  while ((match = re.exec(html))) {
    var itemRe = /['"]([^'"]+)['"]/g;
    var item;
    while ((item = itemRe.exec(match[1]))) {
      names[item[1]] = true;
    }
  }
  return Object.keys(names).sort();
}

function validateRenderableEntities(source, opts) {
  opts = opts || {};
  var html = stripComments(source);
  var errors = [];
  var names = opts.entityNames || extractShowEntities(html);
  var phaseBlockStart = html.search(/\b(?:const|let|var)\s+PHASES\s*=|\bwindow\.PHASES\s*=/);
  var renderSource = phaseBlockStart >= 0 ? html.slice(0, phaseBlockStart) + html.slice(phaseBlockStart).replace(/PHASES\s*=\s*\[[\s\S]*?\]\s*;?/, '') : html;
  var missing = [];
  names.forEach(function(name) {
    if (name === 'CtaButton') return;
    var escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(escaped).test(renderSource)) missing.push(name);
  });
  if (names.length > 0 && missing.length > 0) {
    errors.push('showEntities missing render/model references: ' + missing.slice(0, 12).join(', '));
  }

  var threeGeometryCount = (html.match(/new\s+THREE\.(?:Box|Cylinder|Sphere|Cone|Torus|Plane|Capsule|Dodecahedron|Icosahedron|Octahedron)Geometry\b/g) || []).length;
  var hasThreeScene = /new\s+THREE\.Scene\b/.test(html) && /new\s+THREE\.WebGLRenderer\b/.test(html);
  if (!hasThreeScene || threeGeometryCount < 3) {
    errors.push('rendered scene must be real three.js 3D with Scene/WebGLRenderer and multiple procedural geometries');
  }
  return { passed: errors.length === 0, errors: errors, entityNames: names };
}

function validateHtmlInteractionContract(source, opts) {
  opts = opts || {};
  var html = String(source || '');
  var errors = [];
  var expected = Number(opts.expectedPhaseCount || 0);
  var listeners = findUserInputListeners(html);
  if (expected > 1 && listeners.length === 0) {
    errors.push('generated HTML must register at least one real user input listener');
  }
  var autoProgress = findAutoProgressPatterns(html);
  if (autoProgress.length > 0) {
    errors.push('phase progression must not be scheduled by setTimeout/scheduleComplete: ' + autoProgress.slice(0, 3).join(' | '));
  }
  if (!hasJoystickControl(html)) {
    errors.push('generated HTML must expose a floating/global joystick: pointerdown can start from any screen position, pointermove/pointerup update/reset it, and the visible joystick moves to the pointer origin');
  }
  var directCompletion = findDirectClickCompletionPatterns(html);
  if (directCompletion.length > 0) {
    errors.push('gameplay phases must not complete through direct click/key/button shortcuts: ' + directCompletion.slice(0, 3).join(' | '));
  }
  var phasePlan = validatePhaseInteractionPlan(html, opts);
  errors = errors.concat(phasePlan.errors);
  var ctaHandlersWithoutArrival = findCtaClickHandlersWithoutArrivalGate(html);
  if (ctaHandlersWithoutArrival.length > 0) {
    errors.push('CtaButton click handlers must be arrival-gated: ' + ctaHandlersWithoutArrival.slice(0, 3).join(' | '));
  }
  var arrivalEvidence = validateJoystickArrivalEvidence(html);
  errors = errors.concat(arrivalEvidence.errors);
  var renderable = validateRenderableEntities(html, opts);
  errors = errors.concat(renderable.errors);
  return {
    passed: errors.length === 0,
    errors: errors,
    userInputListenerCount: listeners.length,
    userInputEvents: listeners,
    autoProgressPatternCount: autoProgress.length,
    directCompletionPatternCount: directCompletion.length,
    hasJoystickControl: hasJoystickControl(html),
    phaseCount: phasePlan.phaseCount,
    nonFinalClickEntityCount: phasePlan.nonFinalClickEntityCount,
    nonFinalMissingJoystickEvidenceCount: phasePlan.nonFinalMissingJoystickEvidenceCount,
    ctaUngatedHandlerCount: ctaHandlersWithoutArrival.length,
    entityCount: renderable.entityNames.length,
  };
}

function evaluateHtmlPreflight(source, opts) {
  opts = opts || {};
  var parsed = parsePhasesFromSource(source);
  var expected = opts.expectedPhaseCount != null && Number.isFinite(Number(opts.expectedPhaseCount))
    ? Number(opts.expectedPhaseCount)
    : (parsed.phases ? parsed.phases.length : 0);
  var gate = validateHtmlInteractionContract(source, {
    expectedPhaseCount: expected,
  });
  var errors = gate.errors.slice();
  if (!parsed.phases) {
    parsed.errors.forEach(function(error) {
      if (errors.indexOf(error) < 0) errors.unshift(error);
    });
  }
  return Object.assign({}, gate, {
    id: 'storyboard2html-html-preflight',
    passed: errors.length === 0,
    errors: errors,
    expectedPhaseCount: expected || null,
  });
}

function evaluateHtmlPreflightFile(htmlPath, opts) {
  if (!htmlPath) throw new Error('htmlPath is required');
  return evaluateHtmlPreflight(fs.readFileSync(htmlPath, 'utf8'), opts);
}

function expectedPhaseCount(snapshotDoc, opts) {
  if (opts && opts.expectedPhaseCount != null && Number.isFinite(Number(opts.expectedPhaseCount))) {
    return Number(opts.expectedPhaseCount);
  }
  var phases = snapshotDoc && snapshotDoc.project && snapshotDoc.project.phases;
  if (Array.isArray(phases)) return phases.length;
  var reportCoverage = parseCoveragePair(opts && opts.verifyReport && opts.verifyReport.phaseCoverage);
  if (reportCoverage && reportCoverage.total > 0) return reportCoverage.total;
  var summaryCoverage = parseCoveragePair(opts && opts.verifySummary && opts.verifySummary.phaseCoverage);
  if (summaryCoverage && summaryCoverage.total > 0) return summaryCoverage.total;
  var runtime = opts && opts.verifySummary && opts.verifySummary.runtimeContractSummary;
  var flow = runtime && runtime.manualJoystickFlowProbe;
  var targetCompleted = numberValue(flow && flow.targetCompleted);
  if (targetCompleted != null && targetCompleted > 0) return targetCompleted;
  return null;
}

function validateSnapshotSchemaDoc(doc, contractDoc) {
  var errors = [];
  if (!isObject(doc)) {
    return { passed: false, errors: ['snapshot schema must be an object'] };
  }
  if (doc.schemaVersion !== '1.0.0') errors.push('schemaVersion must be 1.0.0');
  if (doc.kind !== 'blueprint.phaseEvidence.snapshotSchema') errors.push('kind must be blueprint.phaseEvidence.snapshotSchema');
  if (!doc.browserStateContract || doc.browserStateContract.globalName !== 'window.__gameState') {
    errors.push('browserStateContract.globalName must be window.__gameState');
  }
  var requiredTopLevel = (doc.browserStateContract && doc.browserStateContract.requiredTopLevelKeys) || [];
  ['phase', 'phaseRealTimer', 'entity_states', 'phaseEvidence'].forEach(function(key) {
    if (requiredTopLevel.indexOf(key) < 0) errors.push('browserStateContract.requiredTopLevelKeys missing ' + key);
  });
  if (!doc.runtimeSnapshotEnvelope || !doc.runtimeSnapshotEnvelope.requiredMeta) {
    errors.push('runtimeSnapshotEnvelope.requiredMeta missing');
  } else {
    if (doc.runtimeSnapshotEnvelope.requiredMeta['_meta.schemaVersion'] !== '1.0.0') {
      errors.push('runtimeSnapshotEnvelope must require _meta.schemaVersion=1.0.0');
    }
    var platforms = doc.runtimeSnapshotEnvelope.requiredMeta['_meta.sourcePlatform'];
    if (!Array.isArray(platforms) || platforms.indexOf('html') < 0 || platforms.indexOf('unity') < 0) {
      errors.push('runtimeSnapshotEnvelope must allow html and unity sourcePlatform');
    }
  }
  if (!isObject(doc.moduleVocabulary) || Object.keys(doc.moduleVocabulary).length === 0) {
    errors.push('moduleVocabulary missing/empty');
  }
  if (contractDoc && isObject(contractDoc.moduleVocabulary)) {
    var expectedKeys = Object.keys(contractDoc.moduleVocabulary).sort();
    var actualKeys = Object.keys(doc.moduleVocabulary || {}).sort();
    if (expectedKeys.join('|') !== actualKeys.join('|')) {
      errors.push('moduleVocabulary keys differ from canonical snapshot contract');
    }
  }
  return { passed: errors.length === 0, errors: errors };
}

function evaluateVerifyReport(report, snapshotDoc, opts) {
  opts = opts || {};
  var errors = [];
  if (!isObject(report)) {
    return { passed: false, errors: ['verify report must be an object'] };
  }
  var summary = report.phaseEvidenceSummary || {};
  var aggregate = summary.aggregate || {};
  var validation = summary.validation || {};
  if (summary.enabled !== true) errors.push('phaseEvidenceSummary.enabled must be true');
  if (validation.passed !== true) errors.push('phaseEvidenceSummary.validation.passed must be true');
  if (!numberCloseToOne(aggregate.triggeredPresentFullRate)) {
    errors.push('triggeredPresentFullRate must be 1');
  }
  if (!numberCloseToOne(aggregate.triggeredAntiAutoplayHeldRate)) {
    errors.push('triggeredAntiAutoplayHeldRate must be 1');
  }
  var expected = expectedPhaseCount(snapshotDoc, Object.assign({}, opts, { verifyReport: report }));
  var coverage = parseCoveragePair(report.phaseCoverage);
  if (expected != null) {
    if (!coverage) {
      var completed = safeArray(report.completedPhases || report.coveredPlanSteps);
      if (completed.length !== expected) {
        errors.push('phaseCoverage missing/unparseable and completed phase count ' + completed.length + ' != expected ' + expected);
      }
    } else {
      if (coverage.covered !== expected || coverage.total !== expected) {
        errors.push('phaseCoverage must be ' + expected + '/' + expected + ', got ' + coverage.covered + '/' + coverage.total);
      }
    }
  }
  return { passed: errors.length === 0, errors: errors };
}

function evaluateProductionRuntimeSummary(summary, snapshotDoc, opts) {
  opts = opts || {};
  var errors = [];
  if (!isObject(summary)) {
    return { passed: false, errors: ['verify summary must be an object'] };
  }
  if (summary.runner !== 'production') {
    errors.push('verify summary runner must be production');
  }
  var runtime = summary.runtimeContractSummary || {};
  if (!isObject(runtime)) {
    errors.push('runtimeContractSummary must be present');
    runtime = {};
  }
  if (runtime.contractPassed !== true) errors.push('runtimeContractSummary.contractPassed must be true');
  if (runtime.passed !== true) errors.push('runtimeContractSummary.passed must be true');

  var expected = expectedPhaseCount(snapshotDoc, Object.assign({}, opts, { verifySummary: summary }));
  var requiresManualFlow = expected == null || expected > 1;
  if (requiresManualFlow) {
    if (runtime.manualJoystickProbeRequired !== true) {
      errors.push('manualJoystickProbeRequired must be true for multi-phase storyboard2html');
    }
    if (runtime.manualJoystickFlowProbeRequired !== true) {
      errors.push('manualJoystickFlowProbeRequired must be true for multi-phase storyboard2html');
    }
    if (runtime.manualJoystickProbePassed !== true) {
      errors.push('manualJoystickProbePassed must be true');
    }
    if (runtime.manualJoystickFlowProbePassed !== true) {
      errors.push('manualJoystickFlowProbePassed must be true');
    }
    var flow = runtime.manualJoystickFlowProbe || {};
    if (!isObject(flow)) {
      errors.push('manualJoystickFlowProbe summary must be present');
      flow = {};
    }
    if (flow.passed !== true || flow.skipped === true) {
      errors.push('manualJoystickFlowProbe must pass and must not be skipped');
    }
    var completedAfter = numberValue(flow.completedAfter);
    var targetCompleted = numberValue(flow.targetCompleted);
    if (completedAfter == null || targetCompleted == null || targetCompleted <= 0) {
      errors.push('manualJoystickFlowProbe must expose completedAfter and targetCompleted');
    } else if (completedAfter < targetCompleted) {
      errors.push('manualJoystickFlowProbe completedAfter must reach targetCompleted, got ' + completedAfter + '/' + targetCompleted);
    }
    if (!Array.isArray(flow.phasePath) || flow.phasePath.length === 0) {
      errors.push('manualJoystickFlowProbe.phasePath must be non-empty');
    }
    if (!flow.driver) {
      errors.push('manualJoystickFlowProbe.driver must be recorded');
    } else if (['autonav-joystick', 'legacy-drag'].indexOf(String(flow.driver)) < 0) {
      errors.push('manualJoystickFlowProbe.driver must be autonav-joystick or legacy-drag');
    }
    if (!flow.phasePathSource) {
      errors.push('manualJoystickFlowProbe.phasePathSource must be recorded');
    } else if (['samples', 'phase-witness', 'phase-completion-witness'].indexOf(String(flow.phasePathSource)) < 0) {
      errors.push('manualJoystickFlowProbe.phasePathSource is unsupported: ' + flow.phasePathSource);
    }
    if (!Array.isArray(flow.missingPhasePath)) {
      errors.push('manualJoystickFlowProbe.missingPhasePath must be recorded');
    } else if (flow.missingPhasePath.length > 0) {
      errors.push('manualJoystickFlowProbe.missingPhasePath must be empty, got ' + flow.missingPhasePath.join(', '));
    }
    var maxPlayerDistance = numberValue(flow.maxPlayerDistance);
    if (maxPlayerDistance == null || maxPlayerDistance <= 0.05) {
      errors.push('manualJoystickFlowProbe.maxPlayerDistance must show real player movement');
    }
  }
  var telemetry = summary.telemetry || runtime.telemetry || null;
  if (!isObject(telemetry)) {
    errors.push('verify summary telemetry must be present for production CUA');
  } else {
    if (telemetry.schemaVersion !== 'blueprint-cua-telemetry.v1') {
      errors.push('verify summary telemetry schemaVersion must be blueprint-cua-telemetry.v1');
    }
    ['observeMs', 'totalMs'].forEach(function(key) {
      var value = numberValue(telemetry[key]);
      if (value == null || value < 0) errors.push('verify summary telemetry.' + key + ' must be a non-negative number');
    });
    if (requiresManualFlow) {
      ['manualProbeMs', 'manualFlowMs'].forEach(function(key) {
        var value = numberValue(telemetry[key]);
        if (value == null || value < 0) errors.push('verify summary telemetry.' + key + ' must be a non-negative number');
      });
    }
  }
  return { passed: errors.length === 0, errors: errors };
}

function evaluateHardGates(options) {
  options = options || {};
  var snapshotPath = options.snapshotSchemaPath;
  var verifyPath = options.verifyReportPath;
  var summaryPath = options.verifySummaryPath;
  if (!snapshotPath) throw new Error('snapshotSchemaPath is required');
  if (!verifyPath) throw new Error('verifyReportPath is required');
  if (!summaryPath && options.requireProductionCua !== false) throw new Error('verifySummaryPath is required');
  var snapshotDoc = readJson(snapshotPath);
  var verifyReport = readJson(verifyPath);
  var verifySummary = summaryPath ? readJson(summaryPath) : null;
  var contractPath = options.snapshotSchemaContractPath || DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH;
  var contractDoc = fs.existsSync(contractPath) ? readJson(contractPath) : null;
  var gates = [];

  var snapshotGate = validateSnapshotSchemaDoc(snapshotDoc, contractDoc);
  gates.push({
    id: 'snapshot-schema-validates',
    passed: snapshotGate.passed,
    errors: snapshotGate.errors,
  });

  var expectedOpts = Object.assign({}, options, { verifyReport: verifyReport, verifySummary: verifySummary });
  var verifyGate = evaluateVerifyReport(verifyReport, snapshotDoc, expectedOpts);
  gates.push({
    id: 'phase-evidence-hard-gates',
    passed: verifyGate.passed,
    errors: verifyGate.errors,
  });

  if (options.requireProductionCua !== false) {
    var runtimeGate = evaluateProductionRuntimeSummary(verifySummary, snapshotDoc, expectedOpts);
    gates.push({
      id: 'production-runtime-cua-hard-gates',
      passed: runtimeGate.passed,
      errors: runtimeGate.errors,
    });
  }

  if (options.htmlPath) {
    var htmlSource = fs.readFileSync(options.htmlPath, 'utf8');
    var htmlGate = validateHtmlInteractionContract(htmlSource, {
      expectedPhaseCount: expectedPhaseCount(snapshotDoc, expectedOpts),
    });
    gates.push({
      id: 'html-interaction-hard-gates',
      passed: htmlGate.passed,
      errors: htmlGate.errors,
      details: {
        userInputListenerCount: htmlGate.userInputListenerCount,
        userInputEvents: htmlGate.userInputEvents,
        autoProgressPatternCount: htmlGate.autoProgressPatternCount,
        directCompletionPatternCount: htmlGate.directCompletionPatternCount,
        hasJoystickControl: htmlGate.hasJoystickControl,
        phaseCount: htmlGate.phaseCount,
        nonFinalClickEntityCount: htmlGate.nonFinalClickEntityCount,
        nonFinalMissingJoystickEvidenceCount: htmlGate.nonFinalMissingJoystickEvidenceCount,
        ctaUngatedHandlerCount: htmlGate.ctaUngatedHandlerCount,
        entityCount: htmlGate.entityCount,
      },
    });
  }

  return {
    passed: gates.every(function(gate) { return gate.passed; }),
    gates: gates,
    snapshotSchemaPath: snapshotPath,
    verifyReportPath: verifyPath,
    verifySummaryPath: summaryPath || null,
  };
}

module.exports = {
  DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH: DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH,
  parseCoveragePair: parseCoveragePair,
  validateHtmlInteractionContract: validateHtmlInteractionContract,
  evaluateHtmlPreflight: evaluateHtmlPreflight,
  evaluateHtmlPreflightFile: evaluateHtmlPreflightFile,
  validateSnapshotSchemaDoc: validateSnapshotSchemaDoc,
  evaluateVerifyReport: evaluateVerifyReport,
  evaluateProductionRuntimeSummary: evaluateProductionRuntimeSummary,
  evaluateHardGates: evaluateHardGates,
};
