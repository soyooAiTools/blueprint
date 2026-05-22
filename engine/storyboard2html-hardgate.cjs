'use strict';

var fs = require('fs');
var path = require('path');

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

  var threeGeometryCount = (html.match(/new\s+THREE\.(?:Box|Cylinder|Sphere|Cone|Torus|Plane|Capsule|Dodecahedron|Icosahedron)Geometry\b/g) || []).length;
  var canvasDrawCount = (html.match(/\b(?:fillRect|strokeRect|arc|ellipse|drawImage|lineTo|bezierCurveTo)\s*\(/g) || []).length;
  if (threeGeometryCount < 3 && canvasDrawCount < 8) {
    errors.push('rendered scene must contain complete procedural models or rich canvas pseudo-3D drawing');
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
  var renderable = validateRenderableEntities(html, opts);
  errors = errors.concat(renderable.errors);
  return {
    passed: errors.length === 0,
    errors: errors,
    userInputListenerCount: listeners.length,
    userInputEvents: listeners,
    autoProgressPatternCount: autoProgress.length,
    entityCount: renderable.entityNames.length,
  };
}

function expectedPhaseCount(snapshotDoc, opts) {
  if (opts && Number.isFinite(Number(opts.expectedPhaseCount))) {
    return Number(opts.expectedPhaseCount);
  }
  var phases = snapshotDoc && snapshotDoc.project && snapshotDoc.project.phases;
  if (Array.isArray(phases)) return phases.length;
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
  var expected = expectedPhaseCount(snapshotDoc, opts);
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

function evaluateHardGates(options) {
  options = options || {};
  var snapshotPath = options.snapshotSchemaPath;
  var verifyPath = options.verifyReportPath;
  if (!snapshotPath) throw new Error('snapshotSchemaPath is required');
  if (!verifyPath) throw new Error('verifyReportPath is required');
  var snapshotDoc = readJson(snapshotPath);
  var verifyReport = readJson(verifyPath);
  var contractPath = options.snapshotSchemaContractPath || DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH;
  var contractDoc = fs.existsSync(contractPath) ? readJson(contractPath) : null;
  var gates = [];

  var snapshotGate = validateSnapshotSchemaDoc(snapshotDoc, contractDoc);
  gates.push({
    id: 'snapshot-schema-validates',
    passed: snapshotGate.passed,
    errors: snapshotGate.errors,
  });

  var verifyGate = evaluateVerifyReport(verifyReport, snapshotDoc, options);
  gates.push({
    id: 'phase-evidence-hard-gates',
    passed: verifyGate.passed,
    errors: verifyGate.errors,
  });

  if (options.htmlPath) {
    var htmlSource = fs.readFileSync(options.htmlPath, 'utf8');
    var htmlGate = validateHtmlInteractionContract(htmlSource, {
      expectedPhaseCount: expectedPhaseCount(snapshotDoc, options),
    });
    gates.push({
      id: 'html-interaction-hard-gates',
      passed: htmlGate.passed,
      errors: htmlGate.errors,
      details: {
        userInputListenerCount: htmlGate.userInputListenerCount,
        userInputEvents: htmlGate.userInputEvents,
        autoProgressPatternCount: htmlGate.autoProgressPatternCount,
        entityCount: htmlGate.entityCount,
      },
    });
  }

  return {
    passed: gates.every(function(gate) { return gate.passed; }),
    gates: gates,
    snapshotSchemaPath: snapshotPath,
    verifyReportPath: verifyPath,
  };
}

module.exports = {
  DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH: DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH,
  parseCoveragePair: parseCoveragePair,
  validateHtmlInteractionContract: validateHtmlInteractionContract,
  validateSnapshotSchemaDoc: validateSnapshotSchemaDoc,
  evaluateVerifyReport: evaluateVerifyReport,
  evaluateHardGates: evaluateHardGates,
};
