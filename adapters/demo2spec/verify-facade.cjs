'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const playableFlowManifest = require('../../engine/playable-flow-manifest.cjs');

const DEFAULT_CUA_ROOT = '/root/cua-agent';
const DEFAULT_VERIFY_SCRIPT = path.join(DEFAULT_CUA_ROOT, 'blueprint_verify.py');
const DEFAULT_RUNS_DIR = path.join(DEFAULT_CUA_ROOT, 'runs');
const VERIFY_RUNNERS = { direct: true, production: true };

function resolveVerifyArtifactPaths(outDir) {
  const root = path.resolve(outDir);
  return {
    outDir: root,
    specsPath: path.join(root, 'blueprint-specs.json'),
    plansPath: path.join(root, 'blueprint-plans.json'),
    reportPath: path.join(root, 'unity-verify-report.json'),
    summaryPath: path.join(root, 'unity-verify-summary.json'),
  };
}

function buildObserveVerifyArgs(options) {
  options = options || {};
  if (!options.url) throw new Error('buildObserveVerifyArgs requires url');
  if (!options.outDir && (!options.specsPath || !options.plansPath)) {
    throw new Error('buildObserveVerifyArgs requires outDir or explicit specsPath/plansPath');
  }
  const paths = options.outDir ? resolveVerifyArtifactPaths(options.outDir) : {};
  return [
    options.verifyScript || DEFAULT_VERIFY_SCRIPT,
    options.url,
    '--specs', options.specsPath || paths.specsPath,
    '--plans', options.plansPath || paths.plansPath,
    '--steps', String(options.steps || 40),
    '--observe',
  ];
}

function withAutoplayQuery(url) {
  const text = String(url || '');
  if (!text) return text;
  if (/[?&]autoplay=/.test(text)) return text;
  return text + (text.indexOf('?') >= 0 ? '&' : '?') + 'autoplay=1';
}

function latestVerifyReport(sinceMs, runsDir) {
  const root = runsDir || DEFAULT_RUNS_DIR;
  if (!fs.existsSync(root)) return null;
  const reports = [];
  for (const runName of fs.readdirSync(root)) {
    const reportPath = path.join(root, runName, 'verify_report.json');
    if (!fs.existsSync(reportPath)) continue;
    const stat = fs.statSync(reportPath);
    if (stat.mtimeMs >= sinceMs - 2000) reports.push({ reportPath, mtimeMs: stat.mtimeMs });
  }
  reports.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return reports.length ? reports[0].reportPath : null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function runProcess(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env: Object.assign({}, process.env, opts.env || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      stdout += text;
      if (opts.stream) process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      stderr += text;
      if (opts.stream) process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function writeVerifySummary(outDir, reportPath) {
  const paths = resolveVerifyArtifactPaths(outDir);
  fs.copyFileSync(reportPath, paths.reportPath);
  const report = JSON.parse(fs.readFileSync(paths.reportPath, 'utf8'));
  const phaseEvidence = report.phaseEvidenceSummary || {};
  fs.writeFileSync(paths.summaryPath, JSON.stringify({
    passed: report.passed,
    phaseCoverage: report.phaseCoverage,
    signalCoverage: report.signalCoverage,
    phaseEvidenceSummary: {
      enabled: phaseEvidence.enabled,
      reason: phaseEvidence.reason,
      aggregate: phaseEvidence.aggregate,
      validation: phaseEvidence.validation,
    },
  }, null, 2));
  playableFlowManifest.recordDemo2SpecVerify({
    outDir,
    reportPath: paths.reportPath,
    summaryPath: paths.summaryPath,
    runner: 'direct',
  });
  return {
    reportPath: paths.reportPath,
    summaryPath: paths.summaryPath,
    report,
  };
}

function normalizeVerifyRunner(value) {
  const runner = String(value || process.env.DEMO2SPEC_VERIFY_RUNNER || 'production').trim() || 'production';
  if (!VERIFY_RUNNERS[runner]) {
    throw new Error('Unknown verify runner "' + runner + '" (expected direct|production)');
  }
  return runner;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertBlueprintShape(blueprint, expectedKeys) {
  expectedKeys = expectedKeys || ['specs', 'plans.cuaPlan', 'storyboardFrames', 'entities'];
  if (!blueprint || typeof blueprint !== 'object') {
    throw new Error('production verify requires blueprint object');
  }
  const missing = [];
  for (const key of expectedKeys) {
    if (key === 'plans.cuaPlan') {
      if (!blueprint.plans || !blueprint.plans.cuaPlan) missing.push(key);
    } else if (!Object.prototype.hasOwnProperty.call(blueprint, key)) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error('production verify blueprint shape missing: ' + missing.join(', '));
  }
  if (!Array.isArray(blueprint.specs)) throw new Error('production verify blueprint.specs must be an array');
  if (!Array.isArray(blueprint.storyboardFrames)) throw new Error('production verify blueprint.storyboardFrames must be an array');
  if (!Array.isArray(blueprint.entities)) throw new Error('production verify blueprint.entities must be an array');
  if (!blueprint.plans || !blueprint.plans.cuaPlan || !Array.isArray(blueprint.plans.cuaPlan.steps)) {
    throw new Error('production verify blueprint.plans.cuaPlan.steps must be an array');
  }
  return blueprint;
}

function loadBlueprintForProduction(outDir) {
  const paths = resolveVerifyArtifactPaths(outDir);
  const project = readJsonIfExists(path.join(outDir, 'blueprint-project.json')) || {};
  const gameSchema = readJsonIfExists(path.join(outDir, 'blueprint-gameschema.json')) || {};
  const specs = readJsonIfExists(paths.specsPath);
  const plans = readJsonIfExists(paths.plansPath);
  if (!specs) throw new Error('missing blueprint specs for production verify: ' + paths.specsPath);
  if (!plans) throw new Error('missing blueprint plans for production verify: ' + paths.plansPath);
  return assertBlueprintShape({
    projectName: project.name || gameSchema.name || path.basename(outDir),
    schemaSource: 'demo2spec',
    prebuiltGameSchema: true,
    gameSchema,
    specs,
    plans,
    storyboardFrames: Array.isArray(project.storyboardFrames) ? project.storyboardFrames : [],
    entities: Array.isArray(project.entities)
      ? project.entities
      : (Array.isArray(gameSchema.entities) ? gameSchema.entities : []),
  });
}

function copyTreeSync(sourcePath, destPath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.mkdirSync(destPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyTreeSync(path.join(sourcePath, entry), path.join(destPath, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
}

function materializeVerifyBuildDir(outDir, buildDir, options) {
  options = options || {};
  const sourceRoot = path.resolve(outDir);
  const targetRoot = path.resolve(buildDir);
  if (targetRoot === sourceRoot || targetRoot.indexOf(sourceRoot + path.sep) === 0) {
    throw new Error('verify buildDir must be outside outDir: ' + targetRoot);
  }
  fs.rmSync(targetRoot, { recursive: true, force: true });
  if (!fs.existsSync(path.join(sourceRoot, 'index.html'))) {
    throw new Error('missing verify HTML: ' + path.join(sourceRoot, 'index.html'));
  }
  if (options.forceCopy) {
    copyTreeSync(sourceRoot, targetRoot);
    return { buildDir: targetRoot, buildDirMaterialization: 'copy' };
  }
  try {
    fs.symlinkSync(sourceRoot, targetRoot, 'dir');
    return { buildDir: targetRoot, buildDirMaterialization: 'symlink' };
  } catch (err) {
    if (!err || ['EXDEV', 'EPERM', 'EACCES'].indexOf(err.code) < 0) throw err;
    copyTreeSync(sourceRoot, targetRoot);
    return { buildDir: targetRoot, buildDirMaterialization: 'copy' };
  }
}

function writeProductionVerifySummary(outDir, reportPath, meta) {
  const paths = resolveVerifyArtifactPaths(outDir);
  fs.copyFileSync(reportPath, paths.reportPath);
  const report = JSON.parse(fs.readFileSync(paths.reportPath, 'utf8'));
  const phaseEvidence = report.phaseEvidenceSummary || {};
  const workerResult = meta.workerResult || {};
  const runtimeContractSummary = meta.runtimeContractSummary || null;
  fs.writeFileSync(paths.summaryPath, JSON.stringify({
    runner: 'production',
    passed: !!(runtimeContractSummary && runtimeContractSummary.passed === true),
    phaseCoverage: report.phaseCoverage || (workerResult.report && workerResult.report.phaseCoverage) || null,
    signalCoverage: workerResult.signalCoverage || report.signalCoverage || null,
    phaseEvidenceSummary: {
      enabled: phaseEvidence.enabled,
      reason: phaseEvidence.reason,
      aggregate: phaseEvidence.aggregate,
      validation: phaseEvidence.validation,
    },
    runtimeContractSummary,
    issues: workerResult.issues || [],
    silentPassSignals: workerResult.silentPassSignals || [],
    hardBlockingSilentSignals: workerResult.hardBlockingSilentSignals || [],
    telemetry: workerResult.telemetry || (workerResult.report && workerResult.report.telemetry) || null,
    buildDirMaterialization: meta.buildDirMaterialization || null,
  }, null, 2));
  playableFlowManifest.recordDemo2SpecVerify({
    outDir,
    reportPath: paths.reportPath,
    summaryPath: paths.summaryPath,
    runner: 'production',
  });
  return {
    reportPath: paths.reportPath,
    summaryPath: paths.summaryPath,
    report,
  };
}

async function runDirectObserveVerify(options) {
  options = options || {};
  const outDir = path.resolve(options.outDir || '.');
  const port = options.port || await findFreePort();
  const server = spawn(options.python || 'python3.8', [
    '-m', 'http.server', String(port),
    '--bind', '127.0.0.1',
    '--directory', outDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const startedAt = Date.now();
  const url = options.url || withAutoplayQuery('http://127.0.0.1:' + port + '/index.html');
  await new Promise(resolve => setTimeout(resolve, options.serverWarmupMs || 700));
  try {
    const args = buildObserveVerifyArgs({
      url,
      outDir,
      steps: options.steps,
      verifyScript: options.verifyScript,
      specsPath: options.specsPath,
      plansPath: options.plansPath,
    });
    const result = await runProcess(options.python || 'python3.8', args, {
      cwd: options.cuaRoot || DEFAULT_CUA_ROOT,
      env: { DISPLAY: options.display || process.env.DISPLAY || ':99' },
      stream: options.stream,
    });
    const reportPath = latestVerifyReport(startedAt, options.runsDir);
    let summary = null;
    if (reportPath) {
      summary = writeVerifySummary(outDir, reportPath);
      console.log('\nverifyReport=' + summary.reportPath);
    }
    if (result.code !== 0) {
      throw new Error('blueprint_verify.py failed with exit ' + result.code);
    }
    return {
      ok: true,
      url,
      outDir,
      result,
      verifyReport: summary && summary.reportPath || null,
      verifySummary: summary && summary.summaryPath || null,
    };
  } finally {
    server.kill('SIGTERM');
  }
}

async function runProductionObserveVerify(options) {
  options = options || {};
  const outDir = path.resolve(options.outDir || '.');
  const startedAt = Date.now();
  const tempBuildDir = options.buildDir || fs.mkdtempSync(path.join(os.tmpdir(), 'demo2spec-production-verify-'));
  const materialized = materializeVerifyBuildDir(outDir, tempBuildDir);
  const blueprint = assertBlueprintShape(options.blueprint || loadBlueprintForProduction(outDir));
  const taskId = options.taskId || ('demo2spec-production-verify-' + startedAt);
  const log = typeof options.log === 'function'
    ? options.log
    : function(message) {
      if (options.stream) console.log(message);
    };
  const runCUAVerification = options.runCUAVerification
    || require('../../worker/worker-playableagent.js').runCUAVerification;
  const summarizeRuntimeContractResult = options.summarizeRuntimeContractResult
    || require('../../engine/stages/runtime-contract.cjs').summarizeRuntimeContractResult;
  try {
    const workerResult = await runCUAVerification(materialized.buildDir, blueprint, taskId, log);
    let runtimeContractSummary;
    try {
      runtimeContractSummary = summarizeRuntimeContractResult(workerResult);
    } catch (err) {
      runtimeContractSummary = {
        passed: false,
        contractPassed: false,
        needsEscalation: true,
        escalationReasons: ['runtime-contract-summary-error'],
        error: err && err.message ? err.message : String(err),
      };
    }
    const reportPath = options.reportPath || latestVerifyReport(startedAt, options.runsDir);
    if (!reportPath) throw new Error('production verify did not produce verify_report.json');
    const summary = writeProductionVerifySummary(outDir, reportPath, {
      workerResult,
      runtimeContractSummary,
      buildDirMaterialization: materialized.buildDirMaterialization,
    });
    console.log('\nverifyReport=' + summary.reportPath);
    return {
      ok: true,
      runner: 'production',
      outDir,
      result: workerResult,
      runtimeContractSummary,
      verifyReport: summary.reportPath,
      verifySummary: summary.summaryPath,
      buildDir: materialized.buildDir,
      buildDirMaterialization: materialized.buildDirMaterialization,
    };
  } finally {
    if (!options.keepBuildDir) {
      try { fs.rmSync(materialized.buildDir, { recursive: true, force: true }); } catch (err) {}
    }
  }
}

async function runObserveVerify(options) {
  options = options || {};
  const runner = normalizeVerifyRunner(options.runner || options.verifyRunner);
  if (runner === 'production') return runProductionObserveVerify(options);
  return runDirectObserveVerify(options);
}

module.exports = {
  DEFAULT_CUA_ROOT,
  DEFAULT_VERIFY_SCRIPT,
  DEFAULT_RUNS_DIR,
  resolveVerifyArtifactPaths,
  buildObserveVerifyArgs,
  withAutoplayQuery,
  latestVerifyReport,
  findFreePort,
  runProcess,
  writeVerifySummary,
  normalizeVerifyRunner,
  assertBlueprintShape,
  loadBlueprintForProduction,
  materializeVerifyBuildDir,
  writeProductionVerifySummary,
  runDirectObserveVerify,
  runProductionObserveVerify,
  runObserveVerify,
};
