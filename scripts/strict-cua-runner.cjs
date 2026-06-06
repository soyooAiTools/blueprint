#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const checkpointCli = require('./cua-checkpoint-probe.cjs');
const { runCUAVerification } = require('../worker/worker-playableagent.js');

function usage() {
  return [
    'Usage: node scripts/strict-cua-runner.cjs <webgl-build-dir> [--out report.json] [--task-id id]',
    '',
    'Runs the production strict CUA path: observe + manual joystick probe + full manual joystick flow.',
    'This is valid for the final WebGL CUA hardgate; checkpoint probes are debug-only and are not a substitute.',
  ].join('\n');
}

function safeRunId(value) {
  return String(value || 'strict-cua').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'strict-cua';
}

function parseArgs(argv) {
  const args = (argv || process.argv).slice(2);
  const parsed = {
    buildDir: '',
    outPath: '',
    taskId: '',
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--out') {
      parsed.outPath = String(args[++i] || '').trim();
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

async function run(argv, log) {
  const logger = typeof log === 'function' ? log : console.log;
  const parsed = parseArgs(argv || process.argv);
  if (parsed.help) {
    logger(usage());
    return { exitCode: 0, help: true };
  }
  if (!parsed.buildDir) throw new Error(usage());
  const buildDir = path.resolve(parsed.buildDir);
  checkpointCli.findEntryHtml(buildDir);
  const blueprint = checkpointCli.buildProbeBlueprint(buildDir);
  const taskId = safeRunId(parsed.taskId || ('strict-cua-' + path.basename(buildDir)));
  const report = await runCUAVerification(buildDir, blueprint, taskId, function(message) {
    logger(message);
  });
  const outPath = path.resolve(parsed.outPath || path.join(buildDir, 'strict-cua-report.json'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  logger('[strict-cua-runner] ' + (report && report.passed ? 'PASS' : 'FAIL') + ' -> ' + outPath);
  return {
    exitCode: report && report.passed ? 0 : 2,
    report,
    reportPath: outPath,
  };
}

if (require.main === module) {
  run(process.argv).then((result) => {
    process.exitCode = result.exitCode || 0;
  }).catch((err) => {
    console.error('[strict-cua-runner] FAIL ' + (err && err.message || err));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  run,
  usage,
};
