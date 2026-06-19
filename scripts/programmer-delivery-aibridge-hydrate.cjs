'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var hydration = require('../lib/programmer-delivery-hydration-report.cjs');

var DEFAULT_TIMEOUT_MS = 120000;
var DEFAULT_PROBE_TIMEOUT_MS = 5000;
var OUTPUT_LIMIT = 12000;

function usage() {
  console.error('Usage: node scripts/programmer-delivery-aibridge-hydrate.cjs <delivery-root> [--scene Assets/Scenes/Game.unity] [--out MCP_HYDRATION_REPORT.json] [--require-aibridge] [--timeout-ms 120000]');
  process.exit(2);
}

function isFile(file) {
  return !!file && fs.existsSync(file) && fs.statSync(file).isFile();
}

function truncate(text) {
  text = String(text || '');
  if (text.length <= OUTPUT_LIMIT) return text;
  return text.slice(0, OUTPUT_LIMIT) + '\n...[truncated ' + (text.length - OUTPUT_LIMIT) + ' chars]';
}

function parseArgs(argv) {
  var args = {
    root: argv[2] || '',
    scenePath: 'Assets/Scenes/Game.unity',
    outPath: '',
    requireAibridge: process.env.BLUEPRINT_REQUIRE_AIBRIDGE === '1',
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (var i = 3; i < argv.length; i++) {
    var item = argv[i];
    if (item === '--scene') args.scenePath = argv[++i] || '';
    else if (item === '--out') args.outPath = argv[++i] || '';
    else if (item === '--require-aibridge') args.requireAibridge = true;
    else if (item === '--timeout-ms') args.timeoutMs = Math.max(1000, Number(argv[++i] || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    else usage();
  }
  if (!args.root) usage();
  args.root = path.resolve(args.root);
  args.outPath = args.outPath ? path.resolve(args.outPath) : path.join(args.root, 'MCP_HYDRATION_REPORT.json');
  return args;
}

function resolveCli(root) {
  var env = process.env.AIBRIDGE_CLI;
  var candidates = [];
  if (env) candidates.push(env);
  [
    '.aibridge/cli/AIBridgeCLI.exe',
    '.aibridge/cli/AIBridgeCLI',
    '.aibridge/cli/AIBridgeCLI.dll',
    'Packages/cn.lys.aibridge/Tools~/CLI/linux-x64/AIBridgeCLI',
    'Packages/cn.lys.aibridge/Tools~/CLI/linux-x64/AIBridgeCLI.dll',
    'Packages/cn.lys.aibridge/Tools~/CLI/win-x64/AIBridgeCLI.exe',
    'Packages/cn.lys.aibridge/Tools~/AIBridgeCLI',
    'Packages/AIBridge/Tools~/CLI/linux-x64/AIBridgeCLI',
    'Packages/AIBridge/Tools~/CLI/linux-x64/AIBridgeCLI.dll',
    'Packages/AIBridge/Tools~/CLI/win-x64/AIBridgeCLI.exe',
    'Packages/AIBridge/Tools~/AIBridgeCLI'
  ].forEach(function(rel) {
    candidates.push(path.join(root, rel));
  });

  for (var i = 0; i < candidates.length; i++) {
    var candidate = String(candidates[i] || '').trim();
    if (!candidate) continue;
    if (candidate.indexOf(path.sep) >= 0 || candidate.indexOf('/') >= 0 || candidate.indexOf('\\') >= 0) {
      candidate = path.resolve(root, candidate);
      if (!isFile(candidate)) continue;
    }
    if (/\.dll$/i.test(candidate)) {
      return { command: process.env.DOTNET || 'dotnet', baseArgs: [candidate], path: candidate, via: env === candidates[i] ? 'AIBRIDGE_CLI' : 'project' };
    }
    return { command: candidate, baseArgs: [], path: candidate, via: env === candidates[i] ? 'AIBRIDGE_CLI' : 'project' };
  }
  return null;
}

function makeCommand(label, args) {
  return { label: label, args: args };
}

function buildReadinessProbeCommand(timeoutMs) {
  return makeCommand('editor get_state probe', ['editor', 'get_state', '--timeout', String(timeoutMs || DEFAULT_PROBE_TIMEOUT_MS)]);
}

function buildCommands(scenePath) {
  var commands = [
    makeCommand('scene load', ['scene', 'load', '--scenePath', scenePath, '--mode', 'single']),
    makeCommand('scene get_active', ['scene', 'get_active']),
    makeCommand('scene get_hierarchy', ['scene', 'get_hierarchy', '--depth', '8', '--includeInactive', 'true'])
  ];
  hydration.REQUIRED_SCENE_SCRIPTS.forEach(function(item) {
    commands.push(makeCommand('inspector get_components ' + item.objectName, ['inspector', 'get_components', '--path', item.objectName]));
  });
  commands.push(makeCommand('scene save', ['scene', 'save']));
  commands.push(makeCommand('compile unity', ['compile', 'unity', '--timeout', String(DEFAULT_TIMEOUT_MS)]));
  commands.push(makeCommand('get_logs Error', ['get_logs', '--logType', 'Error', '--count', '50']));
  return commands;
}

function runCliCommand(cli, root, command, timeoutMs) {
  var startedAt = new Date().toISOString();
  var env = Object.assign({}, process.env);
  if (!env.DOTNET_ROOT && fs.existsSync('/opt/dotnet')) env.DOTNET_ROOT = '/opt/dotnet';
  var result = childProcess.spawnSync(cli.command, cli.baseArgs.concat(command.args), {
    cwd: root,
    env: env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8
  });
  return {
    label: command.label,
    args: command.args,
    startedAt: startedAt,
    status: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    error: result.error ? String(result.error.message || result.error) : '',
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    passed: result.status === 0 && !result.error
  };
}

function mergeCliEvidence(report, cli, commandResults, options) {
  report.mode = cli ? 'aibridge-cli' : 'static-unity-yaml';
  report.toolLayer = cli ? 'aibridge-cli' : 'aibridge-compatible';
  report.aibridge = {
    ran: !!cli,
    required: options.requireAibridge === true,
    cliPath: cli ? cli.path : '',
    cliVia: cli ? cli.via : '',
    scenePath: options.scenePath,
    commandCount: commandResults.length,
    failedCommandCount: commandResults.filter(function(item) { return !item.passed; }).length,
    commands: commandResults
  };
  if (!cli) {
    report.warnings.push('AIBridgeCLI not found; wrote static YAML hydration fallback');
  } else if (report.aibridge.failedCommandCount > 0) {
    if (options.requireAibridge === true) {
      report.errors.push('AIBridgeCLI hydration commands failed: ' + report.aibridge.failedCommandCount);
      report.passed = false;
    } else {
      report.mode = 'static-unity-yaml';
      report.toolLayer = 'aibridge-cli-attempted-static-fallback';
      report.warnings.push('AIBridgeCLI hydration commands failed: ' + report.aibridge.failedCommandCount + '; wrote static YAML hydration fallback');
    }
  }
  report.summary.aibridgeRan = !!cli;
  report.summary.aibridgeFailedCommandCount = report.aibridge.failedCommandCount;
  return report;
}

function runHydration(options) {
  var cli = resolveCli(options.root);
  var commandResults = [];
  if (cli) {
    var probeTimeout = Math.min(Math.max(1000, options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS), DEFAULT_PROBE_TIMEOUT_MS);
    var probe = runCliCommand(cli, options.root, buildReadinessProbeCommand(probeTimeout), probeTimeout + 2000);
    commandResults.push(probe);
    if (probe.passed) {
      buildCommands(options.scenePath).forEach(function(command) {
        if (command.label === 'compile unity') {
          command.args[command.args.length - 1] = String(options.timeoutMs);
        }
        commandResults.push(runCliCommand(cli, options.root, command, options.timeoutMs));
      });
    }
  }

  var report = hydration.validateHydration(options.root, {
    mode: cli ? 'aibridge-cli' : 'static-unity-yaml'
  });
  report = mergeCliEvidence(report, cli, commandResults, options);
  fs.writeFileSync(options.outPath, JSON.stringify(report, null, 2) + '\n');

  if (!cli && options.requireAibridge) {
    console.error('AIBridgeCLI not found. Set AIBRIDGE_CLI or install .aibridge/cli/AIBridgeCLI.exe in the Unity project.');
    return { report: report, exitCode: 1 };
  }
  return { report: report, exitCode: report.passed ? 0 : 1 };
}

if (require.main === module) {
  try {
    var options = parseArgs(process.argv);
    var result = runHydration(options);
    console.log(JSON.stringify(result.report, null, 2));
    process.exit(result.exitCode);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  resolveCli: resolveCli,
  buildCommands: buildCommands,
  runHydration: runHydration
};
