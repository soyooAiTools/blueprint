#!/usr/bin/env node
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');

var corpus = require('../lib/unitycomponent-v1-accepted-corpus.cjs');
var emitter = require('../lib/unitycomponent-v1-emitter.cjs');
var hardgate = require('../lib/unitycomponent-v1-hardgate.cjs');
var unitySmoke = require('./unitycomponent-v1-unity-smoke.cjs');

var repoRoot = path.join(__dirname, '..');

function usage() {
  return [
    'Usage: node scripts/unitycomponent-v1-cutover-gates.cjs [options]',
    '',
    'Options:',
    '  --corpus-root <dir>     Accepted SourceIR artifact corpus root; repeatable.',
    '  --out-dir <dir>         Directory for generated Unity projects, hardgate reports, Unity logs, and summary.',
    '  --out <file>            Summary JSON path. Defaults to <out-dir>/UNITYCOMPONENT_V1_CUTOVER_GATES.json.',
    '  --limit <n>             Number of discovered samples to run. Defaults to 5.',
    '  --all                   Run every discovered sample.',
    '  --min-count <n>         Minimum sample count required. Defaults to 5.',
    '  --unity <path>          Unity executable path. Defaults to UNITY_EDITOR/UNITY_PATH.',
    '  --unity-required        Require Unity batchmode import/compile. This is the cutover CI mode and the default.',
    '  --unity-optional        Run Unity if available; missing Unity emits skipped smoke reports and is not cutover-ready.',
    '  --no-unity              Do not run Unity; emits scaffold-only evidence and is not cutover-ready.',
    '  --generated-at <iso>    Stable timestamp for deterministic tests.'
  ].join('\n');
}

function parsePositiveInt(value, name) {
  var number = Number(value);
  if (!Number.isFinite(number) || number < 0 || Math.floor(number) !== number) {
    throw new Error(name + ' must be a non-negative integer: ' + value);
  }
  return number;
}

function parseArgs(argv) {
  var args = argv || process.argv.slice(2);
  var out = {
    corpusRoots: [],
    outDir: '',
    out: '',
    limit: 5,
    minCount: 5,
    unity: process.env.UNITY_EDITOR || process.env.UNITY_PATH || '',
    unityMode: 'required',
    generatedAt: '',
    maxDepth: 2
  };
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--corpus-root') {
      out.corpusRoots.push(String(args[++i] || ''));
    } else if (arg === '--out-dir') {
      out.outDir = String(args[++i] || '');
    } else if (arg === '--out') {
      out.out = String(args[++i] || '');
    } else if (arg === '--limit') {
      out.limit = parsePositiveInt(args[++i], '--limit');
    } else if (arg === '--all') {
      out.limit = 0;
    } else if (arg === '--min-count') {
      out.minCount = parsePositiveInt(args[++i], '--min-count');
    } else if (arg === '--unity') {
      out.unity = String(args[++i] || '');
    } else if (arg === '--unity-required') {
      out.unityMode = 'required';
    } else if (arg === '--unity-optional') {
      out.unityMode = 'optional';
    } else if (arg === '--no-unity') {
      out.unityMode = 'disabled';
    } else if (arg === '--generated-at') {
      out.generatedAt = String(args[++i] || '');
    } else {
      throw new Error('Unexpected argument: ' + arg + '\n' + usage());
    }
  }
  return out;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeName(name, index) {
  var cleaned = String(name || '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'sample') + '-' + String(index + 1).padStart(2, '0');
}

function pushSampleError(report, sample, code, message, details) {
  var error = {
    code: code,
    sample: sample.name,
    artifactDir: sample.artifactDir,
    message: message
  };
  if (details) error.details = details;
  sample.errors.push(error);
  report.errors.push(error);
}

function runCutoverGates(options) {
  var opts = options || {};
  var roots = (opts.corpusRoots && opts.corpusRoots.length ? opts.corpusRoots : [
    process.env.UNITYCOMPONENT_ACCEPTED_CORPUS_ROOT || corpus.defaultCorpusRoot(repoRoot)
  ]).filter(Boolean).map(function(root) { return path.resolve(root); });
  var outDir = path.resolve(opts.outDir || path.join(os.tmpdir(), 'unitycomponent-v1-cutover-gates-' + process.pid));
  var outPath = path.resolve(opts.out || path.join(outDir, 'UNITYCOMPONENT_V1_CUTOVER_GATES.json'));
  var limit = typeof opts.limit === 'number' ? opts.limit : 5;
  var minCount = typeof opts.minCount === 'number' ? opts.minCount : 5;
  var unityMode = opts.unityMode || 'required';
  var generatedAt = opts.generatedAt || new Date().toISOString();

  fs.mkdirSync(outDir, { recursive: true });
  var artifactDirs = corpus.discoverAcceptedArtifactDirs(roots, { maxDepth: typeof opts.maxDepth === 'number' ? opts.maxDepth : 2 });
  var selectedDirs = limit > 0 ? artifactDirs.slice(0, limit) : artifactDirs.slice();
  var corpusSummary = corpus.summarizeAcceptedArtifacts(selectedDirs);

  var report = {
    kind: 'blueprint.unityComponentV1CutoverGates',
    schemaVersion: '1.0.0',
    generatedAt: generatedAt,
    profile: 'unitycomponent-v1',
    status: 'running',
    cutoverReady: false,
    corpusRoots: roots,
    outDir: outDir,
    minCount: minCount,
    limit: limit,
    discoveredSampleCount: artifactDirs.length,
    selectedSampleCount: selectedDirs.length,
    sourceEvidencePolicy: corpus.SOURCE_EVIDENCE_POLICY,
    unityMode: unityMode,
    unity: opts.unity || process.env.UNITY_EDITOR || process.env.UNITY_PATH || '',
    gates: {
      acceptedCorpus: {
        status: 'running',
        requiredCoreArtifacts: corpusSummary.requiredCoreArtifacts,
        sourceEvidencePolicy: corpusSummary.sourceEvidencePolicy,
        evidence: corpusSummary.evidence
      },
      emitterHardgate: { status: 'running' },
      unityImportCompile: {
        status: unityMode === 'disabled' ? 'not-run' : 'running',
        required: unityMode === 'required'
      }
    },
    samples: [],
    errors: []
  };

  if (artifactDirs.length < minCount) {
    report.errors.push({
      code: 'accepted-corpus-min-count-not-met',
      message: 'accepted artifact corpus must contain at least ' + minCount + ' samples; found ' + artifactDirs.length
    });
  }
  if (selectedDirs.length < minCount) {
    report.errors.push({
      code: 'accepted-corpus-selected-count-not-met',
      message: 'cutover gates must run at least ' + minCount + ' selected samples; selected ' + selectedDirs.length
    });
  }

  selectedDirs.forEach(function(artifactDir, index) {
    var sampleName = safeName(path.basename(artifactDir), index);
    var projectPath = path.join(outDir, 'projects', sampleName);
    var hardgateReportPath = path.join(outDir, 'hardgate', sampleName + '.json');
    var unitySmokeReportPath = path.join(outDir, 'unity-smoke', sampleName + '.json');
    var unityLogPath = path.join(outDir, 'unity-logs', sampleName + '.log');
    var sample = {
      name: sampleName,
      artifactDir: artifactDir,
      projectPath: projectPath,
      hardgateReportPath: hardgateReportPath,
      unitySmokeReportPath: unityMode === 'disabled' ? null : unitySmokeReportPath,
      unityLogPath: unityMode === 'disabled' ? null : unityLogPath,
      evidence: null,
      semanticHash: '',
      exportPassed: false,
      hardgatePassed: false,
      unitySmokeStatus: unityMode === 'disabled' ? 'not-run' : 'pending',
      errors: []
    };
    report.samples.push(sample);

    var evidence = corpus.evaluateAcceptedArtifactDir(artifactDir);
    sample.evidence = {
      accepted: evidence.accepted,
      sourceEvidencePolicy: evidence.evidence.policy,
      sourceEvidenceCompletePair: evidence.evidence.completePair,
      sourceEvidenceAbsentPair: evidence.evidence.absentPair,
      sourceEvidencePartialPair: evidence.evidence.partialPair,
      errors: evidence.errors
    };
    if (!evidence.accepted) {
      pushSampleError(report, sample, 'accepted-corpus-evidence-failed', 'accepted corpus sample failed core/evidence checks', evidence.errors);
    }

    try {
      var emitted = emitter.emitFromArtifacts(artifactDir, projectPath, { generatedAt: generatedAt });
      sample.exportPassed = emitted.report.passed;
      sample.semanticHash = emitted.spec.semanticHash;
      if (!emitted.report.passed) {
        pushSampleError(report, sample, 'unitycomponent-v1-export-failed', 'UnityComponent v1 emitter validation failed', emitted.report.errors);
      }
    } catch (err) {
      pushSampleError(report, sample, 'unitycomponent-v1-export-threw', String(err && err.message || err));
      return;
    }

    try {
      var hardgateReport = hardgate.writeReport(projectPath, hardgateReportPath);
      sample.hardgatePassed = hardgateReport.passed;
      if (!hardgateReport.passed) {
        pushSampleError(report, sample, 'unitycomponent-v1-hardgate-failed', 'UnityComponent v1 hardgate failed', hardgateReport.errors);
      }
    } catch (err2) {
      pushSampleError(report, sample, 'unitycomponent-v1-hardgate-threw', String(err2 && err2.message || err2));
    }

    if (unityMode === 'disabled') return;
    try {
      var smokeReport = unitySmoke.runSmoke({
        projectPath: projectPath,
        unity: opts.unity || process.env.UNITY_EDITOR || process.env.UNITY_PATH || '',
        required: unityMode === 'required',
        out: unitySmokeReportPath,
        log: unityLogPath
      });
      sample.unitySmokeStatus = smokeReport.status;
      if (smokeReport.status !== 'passed') {
        if (!(unityMode === 'optional' && smokeReport.status === 'skipped')) {
          pushSampleError(report, sample, 'unity-smoke-not-passed', 'Unity batchmode import/compile smoke did not pass', smokeReport);
        }
      }
    } catch (err3) {
      var writtenSmoke = readJsonIfExists(unitySmokeReportPath);
      sample.unitySmokeStatus = writtenSmoke && writtenSmoke.status ? writtenSmoke.status : 'failed';
      pushSampleError(report, sample, 'unity-smoke-failed', String(err3 && err3.message || err3), writtenSmoke || null);
    }
  });

  var sampleFailures = report.samples.filter(function(sample) { return sample.errors.length > 0; });
  report.gates.acceptedCorpus.status = report.errors.some(function(error) {
    return /^accepted-corpus/.test(error.code);
  }) ? 'failed' : 'passed';
  report.gates.emitterHardgate.status = report.samples.every(function(sample) {
    return sample.exportPassed && sample.hardgatePassed;
  }) && selectedDirs.length >= minCount ? 'passed' : 'failed';
  if (unityMode === 'disabled') {
    report.gates.unityImportCompile.status = 'not-run';
  } else {
    var unityStatuses = report.samples.map(function(sample) { return sample.unitySmokeStatus; });
    if (unityMode === 'optional' && unityStatuses.some(function(status) { return status === 'skipped'; }) && unityStatuses.every(function(status) { return status === 'passed' || status === 'skipped'; })) {
      report.gates.unityImportCompile.status = 'skipped';
    } else {
      report.gates.unityImportCompile.status = unityStatuses.every(function(status) { return status === 'passed'; }) ? 'passed' : 'failed';
    }
  }

  if (sampleFailures.length > 0 || report.errors.length > 0) {
    report.status = 'failed';
  } else if (unityMode !== 'required') {
    report.status = 'scaffold-only';
  } else if (report.gates.unityImportCompile.status === 'passed') {
    report.status = 'passed';
  } else {
    report.status = 'failed';
  }
  report.cutoverReady = report.status === 'passed';
  writeJson(outPath, report);
  report.reportPath = outPath;
  return report;
}

function main(argv) {
  var parsed = parseArgs(argv || process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return null;
  }
  var report = runCutoverGates(parsed);
  console.log(JSON.stringify({
    status: report.status,
    cutoverReady: report.cutoverReady,
    selectedSampleCount: report.selectedSampleCount,
    reportPath: report.reportPath,
    gates: report.gates
  }, null, 2));
  if (report.status === 'failed') process.exit(1);
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  }
}

module.exports = {
  parseArgs: parseArgs,
  runCutoverGates: runCutoverGates,
  main: main
};
