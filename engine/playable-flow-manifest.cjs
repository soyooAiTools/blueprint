'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var KIND = 'blueprint.playableFlowManifest';
var SCHEMA_VERSION = 1;
var DEFAULT_FILENAME = 'playable-flow-manifest.json';

function nowIso() {
  return new Date().toISOString();
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256OfFile(filePath) {
  var hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function artifactFor(filePath) {
  if (!filePath) return null;
  var abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return {
      path: abs,
      exists: false,
    };
  }
  var stat = fs.statSync(abs);
  return {
    path: abs,
    exists: true,
    bytes: stat.size,
    sha256: stat.isFile() ? sha256OfFile(abs) : null,
    mtimeMs: stat.mtimeMs,
  };
}

function resolveManifestPath(options) {
  options = options || {};
  if (options.manifestPath) return path.resolve(options.manifestPath);
  if (process.env.PLAYABLE_FLOW_MANIFEST_PATH) return path.resolve(process.env.PLAYABLE_FLOW_MANIFEST_PATH);
  var outDir = options.outDir || options.root || process.cwd();
  return path.join(path.resolve(outDir), DEFAULT_FILENAME);
}

function baseManifest(existing) {
  var doc = isObject(existing) ? existing : {};
  if (doc.kind !== KIND) doc.kind = KIND;
  if (doc.schemaVersion !== SCHEMA_VERSION) doc.schemaVersion = SCHEMA_VERSION;
  if (!doc.createdAt) doc.createdAt = nowIso();
  if (!isObject(doc.artifacts)) doc.artifacts = {};
  if (!isObject(doc.stages)) doc.stages = {};
  if (!Array.isArray(doc.events)) doc.events = [];
  doc.updatedAt = nowIso();
  return doc;
}

function mergeObject(target, source) {
  Object.keys(source || {}).forEach(function(key) {
    var incoming = source[key];
    if (isObject(incoming) && isObject(target[key])) {
      mergeObject(target[key], incoming);
    } else if (Array.isArray(incoming)) {
      target[key] = incoming.slice();
    } else {
      target[key] = incoming;
    }
  });
  return target;
}

function compactTelemetry(telemetry) {
  if (!isObject(telemetry)) return null;
  var keys = [
    'schemaVersion',
    'taskId',
    'buildDir',
    'runner',
    'phaseCount',
    'speedMultiplier',
    'verifyTimeoutMs',
    'buildMs',
    'proofMs',
    'serverMs',
    'observeMs',
    'manualProbeMs',
    'checkpointProbeMs',
    'manualFlowMs',
    'storyboardVisualAuditMs',
    'storyboardVideoAuditMs',
    'totalMs',
    'startedAt',
    'finishedAt',
  ];
  var out = {};
  keys.forEach(function(key) {
    if (telemetry[key] !== undefined) out[key] = telemetry[key];
  });
  return out;
}

function compactRuntimeSummary(summary) {
  if (!isObject(summary)) return null;
  return {
    passed: summary.passed === true,
    contractPassed: summary.contractPassed === true,
    needsEscalation: summary.needsEscalation === true,
    escalationReasons: Array.isArray(summary.escalationReasons) ? summary.escalationReasons.slice() : [],
    manualJoystickProbeRequired: summary.manualJoystickProbeRequired === true,
    manualJoystickProbePassed: summary.manualJoystickProbePassed === true,
    manualJoystickFlowProbeRequired: summary.manualJoystickFlowProbeRequired === true,
    manualJoystickFlowProbePassed: summary.manualJoystickFlowProbePassed === true,
    manualJoystickFlowProbe: isObject(summary.manualJoystickFlowProbe) ? {
      passed: summary.manualJoystickFlowProbe.passed === true,
      skipped: summary.manualJoystickFlowProbe.skipped === true,
      completedAfter: summary.manualJoystickFlowProbe.completedAfter,
      targetCompleted: summary.manualJoystickFlowProbe.targetCompleted,
      phasePath: Array.isArray(summary.manualJoystickFlowProbe.phasePath) ? summary.manualJoystickFlowProbe.phasePath.slice() : [],
      missingPhasePath: Array.isArray(summary.manualJoystickFlowProbe.missingPhasePath) ? summary.manualJoystickFlowProbe.missingPhasePath.slice() : [],
      phasePathSource: summary.manualJoystickFlowProbe.phasePathSource || '',
      driver: summary.manualJoystickFlowProbe.driver || '',
      inputMode: summary.manualJoystickFlowProbe.inputMode || '',
      dragCount: summary.manualJoystickFlowProbe.dragCount,
      maxPlayerDistance: summary.manualJoystickFlowProbe.maxPlayerDistance,
    } : null,
    storyboardVideoAuditPassed: summary.storyboardVideoAuditPassed === true,
    storyboardVideoAuditRequired: summary.storyboardVideoAuditRequired === true,
    telemetry: compactTelemetry(summary.telemetry),
  };
}

function compactHardgateResult(result) {
  if (!isObject(result)) return null;
  return {
    passed: result.passed === true,
    gates: Array.isArray(result.gates) ? result.gates.map(function(gate) {
      return {
        id: gate && gate.id || '',
        passed: !!(gate && gate.passed === true),
        errors: gate && Array.isArray(gate.errors) ? gate.errors.slice() : [],
        details: gate && isObject(gate.details) ? gate.details : undefined,
      };
    }) : [],
    snapshotSchemaPath: result.snapshotSchemaPath || null,
    verifyReportPath: result.verifyReportPath || null,
    verifySummaryPath: result.verifySummaryPath || null,
  };
}

function updateManifest(options, patch) {
  options = options || {};
  var manifestPath = resolveManifestPath(options);
  var existing = readJsonIfExists(manifestPath);
  var doc = baseManifest(existing);
  mergeObject(doc, patch || {});
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(doc, null, 2) + '\n');
  return {
    manifestPath: manifestPath,
    manifest: doc,
  };
}

function recordSourceIrVerify(options) {
  options = options || {};
  var summary = readJsonIfExists(options.summaryPath);
  var report = readJsonIfExists(options.reportPath);
  var runner = options.runner || (summary && summary.runner) || 'direct';
  return updateManifest({
    outDir: options.outDir,
    manifestPath: options.manifestPath,
  }, {
    artifacts: {
      verifyReport: artifactFor(options.reportPath),
      verifySummary: artifactFor(options.summaryPath),
    },
    stages: {
      sourceIrVerify: {
        recordedAt: nowIso(),
        runner: runner,
        passed: !!(summary && summary.passed === true),
        phaseCoverage: summary && summary.phaseCoverage || report && report.phaseCoverage || null,
        signalCoverage: summary && summary.signalCoverage || report && report.signalCoverage || null,
        telemetry: compactTelemetry(summary && summary.telemetry),
        runtimeContractSummary: compactRuntimeSummary(summary && summary.runtimeContractSummary),
      },
    },
    events: [{
      at: nowIso(),
      stage: 'source-ir-verify',
      runner: runner,
      passed: !!(summary && summary.passed === true),
    }],
  });
}

function recordStoryboard2HtmlPreflight(options) {
  options = options || {};
  var preflight = options.preflightResult || readJsonIfExists(options.preflightPath);
  return updateManifest({
    outDir: options.outDir,
    manifestPath: options.manifestPath,
  }, {
    artifacts: {
      generatedHtml: artifactFor(options.htmlPath),
      preflightReport: artifactFor(options.preflightPath),
    },
    stages: {
      storyboard2htmlPreflight: {
        recordedAt: nowIso(),
        passed: !!(preflight && preflight.passed === true),
        errors: preflight && Array.isArray(preflight.errors) ? preflight.errors.slice() : [],
        details: preflight && isObject(preflight.details) ? preflight.details : {},
      },
    },
    events: [{
      at: nowIso(),
      stage: 'storyboard2html-preflight',
      passed: !!(preflight && preflight.passed === true),
    }],
  });
}

function recordStoryboard2HtmlSmoke(options) {
  options = options || {};
  var verifySummary = readJsonIfExists(options.verifySummaryPath);
  var hardgateResult = options.hardgateResult || null;
  return updateManifest({
    outDir: options.outDir,
    manifestPath: options.manifestPath,
  }, {
    artifacts: {
      generatedHtml: artifactFor(options.htmlPath),
      snapshotSchema: artifactFor(options.snapshotSchemaPath),
      verifyReport: artifactFor(options.verifyReportPath),
      verifySummary: artifactFor(options.verifySummaryPath),
    },
    stages: {
      storyboard2htmlSmoke: {
        recordedAt: nowIso(),
        passed: !!(hardgateResult && hardgateResult.passed === true),
        verifyRunner: verifySummary && verifySummary.runner || null,
        telemetry: compactTelemetry(verifySummary && verifySummary.telemetry),
        hardgate: compactHardgateResult(hardgateResult),
        runtimeContractSummary: compactRuntimeSummary(verifySummary && verifySummary.runtimeContractSummary),
      },
    },
    events: [{
      at: nowIso(),
      stage: 'storyboard2html-smoke',
      passed: !!(hardgateResult && hardgateResult.passed === true),
    }],
  });
}

function recordExportDelivery(options) {
  options = options || {};
  var validation = readJsonIfExists(options.validationPath);
  var summary = readJsonIfExists(options.summaryPath);
  return updateManifest({
    outDir: options.outDir || options.root,
    manifestPath: options.manifestPath,
  }, {
    artifacts: {
      programmerDeliverySummary: artifactFor(options.summaryPath),
      deliveryValidation: artifactFor(options.validationPath),
      exportArchive: artifactFor(options.archivePath),
    },
    stages: {
      programmerDeliveryExport: {
        recordedAt: nowIso(),
        passed: !!(validation && validation.passed === true),
        errors: validation && Array.isArray(validation.errors) ? validation.errors.slice() : [],
        warnings: validation && Array.isArray(validation.warnings) ? validation.warnings.slice() : [],
        taskId: options.taskId || validation && validation.taskId || summary && summary.taskId || null,
      },
    },
    events: [{
      at: nowIso(),
      stage: 'programmer-delivery-export',
      passed: !!(validation && validation.passed === true),
    }],
  });
}

module.exports = {
  KIND: KIND,
  SCHEMA_VERSION: SCHEMA_VERSION,
  DEFAULT_FILENAME: DEFAULT_FILENAME,
  resolveManifestPath: resolveManifestPath,
  readJsonIfExists: readJsonIfExists,
  sha256OfFile: sha256OfFile,
  artifactFor: artifactFor,
  updateManifest: updateManifest,
  recordSourceIrVerify: recordSourceIrVerify,
  recordStoryboard2HtmlPreflight: recordStoryboard2HtmlPreflight,
  recordStoryboard2HtmlSmoke: recordStoryboard2HtmlSmoke,
  recordExportDelivery: recordExportDelivery,
  _internals: {
    compactRuntimeSummary: compactRuntimeSummary,
    compactTelemetry: compactTelemetry,
    compactHardgateResult: compactHardgateResult,
    mergeObject: mergeObject,
  },
};

function parseCliArgs(argv) {
  var opts = {};
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--root' || arg === '--out-dir') opts.outDir = argv[++i] || null;
    else if (arg === '--manifest') opts.manifestPath = argv[++i] || null;
    else if (arg === '--summary') opts.summaryPath = argv[++i] || null;
    else if (arg === '--validation') opts.validationPath = argv[++i] || null;
    else if (arg === '--archive') opts.archivePath = argv[++i] || null;
    else if (arg === '--task') opts.taskId = argv[++i] || null;
    else throw new Error('unknown flag: ' + arg);
  }
  return opts;
}

function usage() {
  console.error('Usage: node engine/playable-flow-manifest.cjs record-export --root <delivery-root> --summary <summary.json> --validation <DELIVERY_VALIDATION.json> [--archive out.tar.gz] [--task taskId] [--manifest playable-flow-manifest.json]');
  process.exit(2);
}

if (require.main === module) {
  try {
    var cmd = process.argv[2];
    if (cmd !== 'record-export') usage();
    var opts = parseCliArgs(process.argv.slice(3));
    if (!opts.outDir || !opts.summaryPath || !opts.validationPath) usage();
    var result = recordExportDelivery(opts);
    console.log(JSON.stringify({
      ok: true,
      manifestPath: result.manifestPath,
      passed: !!(result.manifest.stages &&
        result.manifest.stages.programmerDeliveryExport &&
        result.manifest.stages.programmerDeliveryExport.passed === true),
    }, null, 2));
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}
