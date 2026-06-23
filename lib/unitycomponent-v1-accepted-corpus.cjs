#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var REQUIRED_CORE_ARTIFACTS = [
  'source-ir.json',
  'playable-scene-ir.json',
  'asset-manifest.json'
];

var UNITY_ASSET_PLAN_CANDIDATES = [
  'unity-asset-plan.json',
  'blueprint-unity-asset-plan.json'
];

var SOURCE_EVIDENCE_FILES = [
  'source-ir-report.json',
  'source-ir-build-summary.json'
];

var SOURCE_EVIDENCE_POLICY = 'optional-pair-validated';

function fileExists(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hasFile(dir, name) {
  return fileExists(path.join(dir, name));
}

function findUnityAssetPlan(dir) {
  for (var i = 0; i < UNITY_ASSET_PLAN_CANDIDATES.length; i++) {
    var name = UNITY_ASSET_PLAN_CANDIDATES[i];
    var file = path.join(dir, name);
    if (fileExists(file)) return { name: name, path: file, exists: true };
  }
  return { name: 'unity-asset-plan.json', path: path.join(dir, 'unity-asset-plan.json'), exists: false };
}

function evaluateCoreArtifacts(dir) {
  var artifacts = REQUIRED_CORE_ARTIFACTS.map(function(name) {
    var file = path.join(dir, name);
    return { name: name, path: file, exists: fileExists(file) };
  });
  var unityAssetPlan = findUnityAssetPlan(dir);
  artifacts.push(unityAssetPlan);
  var missing = artifacts.filter(function(artifact) { return !artifact.exists; }).map(function(artifact) { return artifact.name; });
  return {
    required: REQUIRED_CORE_ARTIFACTS.concat(['unity-asset-plan.json or blueprint-unity-asset-plan.json']),
    artifacts: artifacts,
    missing: missing,
    complete: missing.length === 0
  };
}

function safeReadJson(file, errors, codePrefix) {
  try {
    return readJson(file);
  } catch (err) {
    errors.push({
      code: codePrefix + '-json-invalid',
      file: file,
      message: String(err && err.message || err)
    });
    return null;
  }
}

function evaluateSourceEvidence(dir) {
  var reportPath = path.join(dir, 'source-ir-report.json');
  var summaryPath = path.join(dir, 'source-ir-build-summary.json');
  var reportPresent = fileExists(reportPath);
  var summaryPresent = fileExists(summaryPath);
  var errors = [];
  var report = null;
  var summary = null;

  if (reportPresent !== summaryPresent) {
    errors.push({
      code: 'source-evidence-metadata-partial',
      message: 'source-ir-report.json and source-ir-build-summary.json are optional, but must appear as a pair when present',
      files: SOURCE_EVIDENCE_FILES
    });
  }

  if (reportPresent) {
    report = safeReadJson(reportPath, errors, 'source-ir-report');
    if (report && report.passed !== true) {
      errors.push({
        code: 'source-ir-report-not-passed',
        file: reportPath,
        message: 'source-ir-report.json must have passed=true when included in accepted corpus evidence'
      });
    }
  }

  if (summaryPresent) {
    summary = safeReadJson(summaryPath, errors, 'source-ir-build-summary');
    if (summary) {
      if (summary.ok !== true) {
        errors.push({
          code: 'source-ir-build-summary-not-ok',
          file: summaryPath,
          message: 'source-ir-build-summary.json must have ok=true when included in accepted corpus evidence'
        });
      }
      if (summary.sourceIrBuildPassed !== true) {
        errors.push({
          code: 'source-ir-build-not-passed',
          file: summaryPath,
          message: 'source-ir-build-summary.json must have sourceIrBuildPassed=true when included'
        });
      }
      if (summary.sourceIrPreflightPassed !== true) {
        errors.push({
          code: 'source-ir-preflight-not-passed',
          file: summaryPath,
          message: 'source-ir-build-summary.json must have sourceIrPreflightPassed=true when included'
        });
      }
    }
  }

  return {
    policy: SOURCE_EVIDENCE_POLICY,
    files: {
      sourceIrReport: { path: reportPath, exists: reportPresent },
      sourceIrBuildSummary: { path: summaryPath, exists: summaryPresent }
    },
    present: reportPresent || summaryPresent,
    completePair: reportPresent && summaryPresent,
    absentPair: !reportPresent && !summaryPresent,
    partialPair: reportPresent !== summaryPresent,
    passed: errors.length === 0,
    errors: errors
  };
}

function isAcceptedArtifactDir(dir) {
  return evaluateCoreArtifacts(dir).complete;
}

function evaluateAcceptedArtifactDir(dir) {
  var core = evaluateCoreArtifacts(dir);
  var evidence = evaluateSourceEvidence(dir);
  var errors = [];
  core.missing.forEach(function(name) {
    errors.push({
      code: 'accepted-corpus-core-artifact-missing',
      artifact: name,
      message: 'accepted corpus sample is missing required core artifact: ' + name
    });
  });
  evidence.errors.forEach(function(error) { errors.push(error); });
  return {
    dir: dir,
    name: path.basename(dir),
    core: core,
    evidence: evidence,
    accepted: errors.length === 0,
    errors: errors
  };
}

function walkDirs(root, out, maxDepth, depth) {
  if (!root || !fs.existsSync(root) || depth > maxDepth) return;
  var stat = fs.statSync(root);
  if (!stat.isDirectory()) return;
  if (isAcceptedArtifactDir(root)) {
    out.push(root);
    return;
  }
  fs.readdirSync(root).sort().forEach(function(name) {
    var dir = path.join(root, name);
    if (fs.statSync(dir).isDirectory()) walkDirs(dir, out, maxDepth, depth + 1);
  });
}

function discoverAcceptedArtifactDirs(roots, options) {
  var inputRoots = Array.isArray(roots) ? roots : [roots];
  var maxDepth = options && typeof options.maxDepth === 'number' ? options.maxDepth : 2;
  var out = [];
  inputRoots.filter(Boolean).forEach(function(root) {
    walkDirs(path.resolve(root), out, maxDepth, 0);
  });
  return out.sort();
}

function summarizeAcceptedArtifacts(dirs) {
  var evaluations = dirs.map(evaluateAcceptedArtifactDir);
  var evidence = {
    policy: SOURCE_EVIDENCE_POLICY,
    completePairs: 0,
    absentPairs: 0,
    partialPairs: 0,
    failedPairs: 0
  };
  evaluations.forEach(function(item) {
    if (item.evidence.completePair) evidence.completePairs += 1;
    if (item.evidence.absentPair) evidence.absentPairs += 1;
    if (item.evidence.partialPair) evidence.partialPairs += 1;
    if (!item.evidence.passed) evidence.failedPairs += 1;
  });
  return {
    kind: 'blueprint.unityComponentV1AcceptedCorpusSummary',
    requiredCoreArtifacts: REQUIRED_CORE_ARTIFACTS.concat(['unity-asset-plan.json or blueprint-unity-asset-plan.json']),
    sourceEvidencePolicy: SOURCE_EVIDENCE_POLICY,
    sampleCount: evaluations.length,
    evidence: evidence,
    passed: evaluations.every(function(item) { return item.accepted; }),
    samples: evaluations
  };
}

function assertAcceptedArtifactEvidence(dir) {
  var evaluated = evaluateAcceptedArtifactDir(dir);
  assert.strictEqual(evaluated.accepted, true, dir + ' accepted corpus evidence failed: ' + JSON.stringify(evaluated.errors, null, 2));
  return evaluated;
}

function defaultCorpusRoot(repoRoot) {
  return path.join(repoRoot, 'test', 'fixtures', 'unitycomponent-v1-accepted-corpus');
}

module.exports = {
  REQUIRED_CORE_ARTIFACTS: REQUIRED_CORE_ARTIFACTS.slice(),
  UNITY_ASSET_PLAN_CANDIDATES: UNITY_ASSET_PLAN_CANDIDATES.slice(),
  SOURCE_EVIDENCE_FILES: SOURCE_EVIDENCE_FILES.slice(),
  SOURCE_EVIDENCE_POLICY: SOURCE_EVIDENCE_POLICY,
  defaultCorpusRoot: defaultCorpusRoot,
  discoverAcceptedArtifactDirs: discoverAcceptedArtifactDirs,
  evaluateAcceptedArtifactDir: evaluateAcceptedArtifactDir,
  evaluateCoreArtifacts: evaluateCoreArtifacts,
  evaluateSourceEvidence: evaluateSourceEvidence,
  isAcceptedArtifactDir: isAcceptedArtifactDir,
  summarizeAcceptedArtifacts: summarizeAcceptedArtifacts,
  assertAcceptedArtifactEvidence: assertAcceptedArtifactEvidence
};
