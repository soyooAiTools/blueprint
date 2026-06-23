#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

function parseArgs(argv) {
  var args = argv || process.argv.slice(2);
  var out = {
    projectPath: '',
    unity: process.env.UNITY_EDITOR || process.env.UNITY_PATH || '',
    required: false,
    out: ''
  };
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (arg === '--unity') out.unity = String(args[++i] || '');
    else if (arg === '--required') out.required = true;
    else if (arg === '--out') out.out = String(args[++i] || '');
    else if (!out.projectPath) out.projectPath = arg;
    else throw new Error('Unexpected argument: ' + arg);
  }
  if (!out.projectPath) throw new Error('Usage: node scripts/unitycomponent-v1-unity-smoke.cjs <unity-project-dir> [--unity /path/to/Unity] [--required] [--out report.json]');
  return out;
}

function executableExists(file) {
  if (!file) return false;
  if (file.indexOf(path.sep) >= 0) return fs.existsSync(file);
  try {
    childProcess.execFileSync('which', [file], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (err) {
    return false;
  }
}

function findUnity(explicit) {
  var candidates = [
    explicit,
    'Unity',
    '/opt/Unity/Editor/Unity',
    '/Applications/Unity/Hub/Editor/2022.3.*/Unity.app/Contents/MacOS/Unity'
  ].filter(Boolean);
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].indexOf('*') >= 0) continue;
    if (executableExists(candidates[i])) return candidates[i];
  }
  return '';
}

function writeJson(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function runSmoke(opts) {
  var projectPath = path.resolve(opts.projectPath);
  if (!fs.existsSync(projectPath)) throw new Error('Unity project path missing: ' + projectPath);
  var unity = findUnity(opts.unity);
  var reportPath = opts.out || path.join(projectPath, 'UNITYCOMPONENT_V1_UNITY_SMOKE.json');
  if (!unity) {
    var skipped = {
      kind: 'blueprint.unityComponentV1UnitySmoke',
      status: 'skipped',
      reason: 'Unity executable not found; set UNITY_EDITOR/UNITY_PATH or pass --unity. Use --required in CI/cutover gates.',
      projectPath: projectPath
    };
    writeJson(reportPath, skipped);
    if (opts.required) throw new Error(skipped.reason);
    return skipped;
  }

  var logPath = path.join(os.tmpdir(), 'unitycomponent-v1-unity-smoke-' + process.pid + '.log');
  var args = ['-batchmode', '-quit', '-nographics', '-projectPath', projectPath, '-logFile', logPath];
  var exitCode = 0;
  try {
    childProcess.execFileSync(unity, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    exitCode = typeof err.status === 'number' ? err.status : 1;
  }
  var logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  var failed = exitCode !== 0 || /error CS\d+|Scripts have compiler errors|Compiler errors|Failed to compile/i.test(logText);
  var report = {
    kind: 'blueprint.unityComponentV1UnitySmoke',
    status: failed ? 'failed' : 'passed',
    unity: unity,
    projectPath: projectPath,
    exitCode: exitCode,
    logPath: logPath
  };
  writeJson(reportPath, report);
  if (failed) throw new Error('Unity batchmode import/compile smoke failed; see ' + logPath);
  return report;
}

function main(argv) {
  var result = runSmoke(parseArgs(argv || process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  return result;
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
  runSmoke: runSmoke,
  main: main
};
