var fs = require('fs');
var path = require('path');

var REGISTRY_DIR = path.join(__dirname, 'assembly-registry-v1');
var MANIFEST_PATH = path.join(REGISTRY_DIR, 'registry-pack.v1.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveManifestPath(baseDir, relPath) {
  return path.resolve(baseDir, relPath);
}

function uniq(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var value = list[i];
    if (value == null || value === '') continue;
    var key = String(value);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(value);
  }
  return out;
}

function buildAssertionIndex(cuaAssertions) {
  var index = {};
  var items = (cuaAssertions && cuaAssertions.items) || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i] && items[i].id) index[items[i].id] = items[i];
  }
  return index;
}

function buildPhaseEvidenceSchema(signals, assertionIndex, phaseId) {
  var phaseToken = phaseId || '<phaseId>';
  return uniq(signals || []).map(function(signal) {
    var assertion = assertionIndex && assertionIndex[signal] || {};
    return {
      signal: signal,
      kind: assertion.kind || 'unknown',
      phaseEvidencePath: 'phaseEvidence["' + phaseToken + '"]["' + signal + '"]',
      variableEvidenceKey: 'evidence.' + phaseToken + '.' + signal,
    };
  });
}

function enrichRuntimeModules(runtimeModules, cuaAssertions) {
  var assertionIndex = buildAssertionIndex(cuaAssertions);
  var items = runtimeModules && Array.isArray(runtimeModules.items) ? runtimeModules.items : [];
  for (var i = 0; i < items.length; i++) {
    var moduleItem = items[i] || {};
    var observableFeedback = Array.isArray(moduleItem.observableFeedback) ? moduleItem.observableFeedback.slice() : [];
    var expectedSignals = Array.isArray(moduleItem.expectedSignals) && moduleItem.expectedSignals.length > 0
      ? moduleItem.expectedSignals.slice()
      : observableFeedback.slice();
    moduleItem.expectedSignals = uniq(expectedSignals);
    moduleItem.phaseEvidenceSchema = Array.isArray(moduleItem.phaseEvidenceSchema) && moduleItem.phaseEvidenceSchema.length > 0
      ? moduleItem.phaseEvidenceSchema
      : buildPhaseEvidenceSchema(moduleItem.expectedSignals, assertionIndex);
  }
  return runtimeModules;
}

function loadAssemblyRegistry() {
  var manifest = readJson(MANIFEST_PATH);
  var baseDir = path.dirname(MANIFEST_PATH);
  var storyboardAtoms = readJson(resolveManifestPath(baseDir, manifest.storyboardAtoms));
  var runtimeModules = readJson(resolveManifestPath(baseDir, manifest.runtimeModules));
  var cuaAssertions = readJson(resolveManifestPath(baseDir, manifest.cuaAssertions));
  var mappings = readJson(resolveManifestPath(baseDir, manifest.mappings));
  enrichRuntimeModules(runtimeModules, cuaAssertions);

  return {
    manifest: manifest,
    storyboardAtoms: storyboardAtoms,
    runtimeModules: runtimeModules,
    cuaAssertions: cuaAssertions,
    mappings: mappings
  };
}

module.exports = {
  REGISTRY_DIR: REGISTRY_DIR,
  MANIFEST_PATH: MANIFEST_PATH,
  buildPhaseEvidenceSchema: buildPhaseEvidenceSchema,
  enrichRuntimeModules: enrichRuntimeModules,
  loadAssemblyRegistry: loadAssemblyRegistry
};
