'use strict';

var path = require('path');
var spawnSync = require('child_process').spawnSync;

var ADAPTER_ROOT = __dirname;

function scriptPath(name) {
  return path.join(ADAPTER_ROOT, name);
}

function runScript(name, args, opts) {
  opts = opts || {};
  var result = spawnSync(process.execPath, [scriptPath(name)].concat(args || []), {
    cwd: opts.cwd || ADAPTER_ROOT,
    env: Object.assign({}, process.env, opts.env || {}),
    encoding: opts.encoding || 'utf8',
    stdio: opts.stdio || 'pipe',
  });
  return result;
}

function runScriptChecked(name, args, opts) {
  var result = runScript(name, args, opts);
  if (result.status !== 0) {
    throw new Error([
      'demo2spec adapter script failed: ' + name + ' exit=' + result.status,
      result.stdout || '',
      result.stderr || '',
    ].join('\n'));
  }
  return result;
}

function extractDemoHtml(htmlPath, outDir, opts) {
  return runScriptChecked('extract.js', [htmlPath, outDir], opts);
}

function convertDemoSpecToGameSchema(specPath, outPath, opts) {
  opts = opts || {};
  var args = [specPath, outPath];
  if (opts.theme) args.push('--theme', opts.theme);
  return runScriptChecked('convert-to-gameschema.js', args, opts);
}

function runDemo2SpecPipeline(htmlPath, outDir, opts) {
  opts = opts || {};
  var args = [htmlPath, outDir];
  if (opts.theme) args.push('--theme', opts.theme);
  if (opts.blueprintSmoke) args.push('--blueprint-smoke');
  if (opts.verify) args.push('--verify');
  if (opts.verifyRunner) args.push('--verify-runner', String(opts.verifyRunner));
  if (opts.steps) args.push('--steps', String(opts.steps));
  if (opts.visualDiff) args.push('--visual-diff');
  if (opts.visualPhases) args.push('--visual-phases', String(opts.visualPhases));
  return runScriptChecked('index.js', args, opts);
}

function runBlueprintSmoke(input, outDir, opts) {
  opts = opts || {};
  var args = [input];
  if (outDir) args.push(outDir);
  if (opts.verify) args.push('--verify');
  if (opts.verifyRunner) args.push('--verify-runner', String(opts.verifyRunner));
  if (opts.steps) args.push('--steps', String(opts.steps));
  return runScriptChecked('run-blueprint-smoke.js', args, opts);
}

module.exports = {
  ADAPTER_ROOT: ADAPTER_ROOT,
  scriptPath: scriptPath,
  runScript: runScript,
  runScriptChecked: runScriptChecked,
  extractDemoHtml: extractDemoHtml,
  convertDemoSpecToGameSchema: convertDemoSpecToGameSchema,
  runDemo2SpecPipeline: runDemo2SpecPipeline,
  runBlueprintSmoke: runBlueprintSmoke,
  modules: {
    snapshotSchema: require('./snapshot-schema.js'),
    blueprintProject: require('./blueprint-project.js'),
    visualAssets: require('./visual-assets.js'),
    unityAssetPlan: require('./unity-asset-plan.js'),
    visualOverlay: require('./visual-overlay.js'),
    verifyFacade: require('./verify-facade.cjs'),
    fidelityContract: require('./fidelity-contract.js'),
    fidelityUnityWriter: require('./fidelity-unity-writer.js'),
  },
};
