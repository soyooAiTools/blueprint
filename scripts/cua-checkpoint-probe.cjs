#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');

const {
  runManualJoystickCheckpointProbe,
  selectManualJoystickPhaseWindow,
} = require('../worker/worker-playableagent.js');

function usage() {
  return [
    'Usage: node scripts/cua-checkpoint-probe.cjs <webgl-build-dir> --phase <phaseId|index> [--max-phases N] [--out outdir] [--task-id id]',
    '',
    'Runs a debug-only local manual joystick flow from a runtime checkpoint.',
    'This is not a replacement for production full-flow CUA hardgate.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    buildDir: '',
    phase: '',
    maxPhases: 1,
    outDir: '',
    taskId: '',
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--phase') {
      parsed.phase = String(args[++i] || '').trim();
    } else if (arg === '--max-phases') {
      parsed.maxPhases = Math.max(1, Math.floor(Number(args[++i] || 1) || 1));
    } else if (arg === '--out') {
      parsed.outDir = String(args[++i] || '').trim();
    } else if (arg === '--task-id') {
      parsed.taskId = String(args[++i] || '').trim();
    } else if (!parsed.buildDir) {
      parsed.buildDir = arg;
    } else {
      throw new Error('Unexpected argument: ' + arg);
    }
  }
  return parsed;
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch(e) {
    return null;
  }
}

function safeRunId(value) {
  return String(value || 'task').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'task';
}

function buildProbeBlueprint(buildDir) {
  const project = readJsonIfExists(path.join(buildDir, 'blueprint-project.json')) ||
    readJsonIfExists(path.join(buildDir, 'blueprint.json')) ||
    {};
  const proofBundle = readJsonIfExists(path.join(buildDir, 'blueprint-proof-bundle.json')) ||
    project.proofBundle ||
    null;
  return proofBundle ? Object.assign({}, project, { proofBundle }) : project;
}

function findEntryHtml(buildDir) {
  const candidates = ['iframe.html', 'index.html'];
  for (const name of candidates) {
    const filePath = path.join(buildDir, name);
    if (fs.existsSync(filePath)) return name;
  }
  throw new Error('No iframe.html or index.html found in ' + buildDir);
}

function contentType(filePath) {
  if (/\.html?$/i.test(filePath)) return 'text/html; charset=utf-8';
  if (/\.js$/i.test(filePath)) return 'application/javascript; charset=utf-8';
  if (/\.css$/i.test(filePath)) return 'text/css; charset=utf-8';
  if (/\.json$/i.test(filePath)) return 'application/json; charset=utf-8';
  if (/\.wasm$/i.test(filePath)) return 'application/wasm';
  return 'application/octet-stream';
}

function startStaticServer(buildDir) {
  const root = path.resolve(buildDir);
  const server = http.createServer((req, res) => {
    const requestPath = decodeURIComponent(String(req.url || '/').split('?')[0] || '/');
    const relative = requestPath === '/' ? findEntryHtml(root) : requestPath.replace(/^\/+/, '');
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', contentType(target));
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function run(argv, log) {
  const logger = typeof log === 'function' ? log : console.log;
  const parsed = parseArgs(argv || process.argv);
  if (parsed.help) {
    logger(usage());
    return { exitCode: 0, help: true };
  }
  if (!parsed.buildDir || !parsed.phase) throw new Error(usage());
  const buildDir = path.resolve(parsed.buildDir);
  const entry = findEntryHtml(buildDir);
  const blueprint = buildProbeBlueprint(buildDir);
  const phaseWindow = selectManualJoystickPhaseWindow(blueprint, {
    checkpointPhase: parsed.phase,
    maxPhases: parsed.maxPhases,
  });
  if (phaseWindow.checkpointError) throw new Error(phaseWindow.checkpointError);

  const outDir = path.resolve(parsed.outDir || path.join(buildDir, 'cua-checkpoint-results'));
  fs.mkdirSync(outDir, { recursive: true });
  const taskId = safeRunId(parsed.taskId || ('checkpoint-' + path.basename(buildDir) + '-' + parsed.phase));
  let server = null;
  try {
    server = await startStaticServer(buildDir);
    const port = server.address().port;
    const url = 'http://127.0.0.1:' + port + '/' + entry + '?checkpointCua=1&cb=' + Date.now();
    const probe = await runManualJoystickCheckpointProbe(url, blueprint, taskId, logger, parsed.phase, parsed.maxPhases);
    const report = {
      schemaVersion: 'blueprint-cua-checkpoint-report.v1',
      debugOnly: true,
      buildDir,
      url,
      entry,
      requestedPhase: parsed.phase,
      maxPhases: parsed.maxPhases,
      phaseWindow,
      passed: !!(probe && probe.passed),
      reason: probe && probe.reason || '',
      probe,
      generatedAt: new Date().toISOString(),
    };
    const reportPath = path.join(outDir, 'cua-checkpoint-report-' + safeRunId(parsed.phase) + '.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    logger('[cua-checkpoint-probe] ' + (report.passed ? 'PASS' : 'FAIL') + ' ' + parsed.phase + ' -> ' + reportPath);
    return { exitCode: report.passed ? 0 : 2, report, reportPath };
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

if (require.main === module) {
  run(process.argv).then((result) => {
    process.exitCode = result.exitCode || 0;
  }).catch((err) => {
    console.error('[cua-checkpoint-probe] FAIL ' + (err && err.message || err));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  buildProbeBlueprint,
  findEntryHtml,
  startStaticServer,
  run,
};
