'use strict';

var path = require('path');
var spawnSync = require('child_process').spawnSync;

var BLUEPRINT_ROOT = path.resolve(__dirname, '..', '..');
var SCRIPT_ROOT = path.join(BLUEPRINT_ROOT, 'scripts');

function scriptPath(name) {
  return path.join(SCRIPT_ROOT, name);
}

function runScript(name, args, opts) {
  opts = opts || {};
  return spawnSync(process.execPath, [scriptPath(name)].concat(args || []), {
    cwd: opts.cwd || BLUEPRINT_ROOT,
    env: Object.assign({}, process.env, opts.env || {}),
    encoding: opts.encoding || 'utf8',
    stdio: opts.stdio || 'pipe',
  });
}

function runScriptChecked(name, args, opts) {
  var result = runScript(name, args, opts);
  if (result.status !== 0) {
    throw new Error([
      'storyboard2html adapter script failed: ' + name + ' exit=' + result.status,
      result.stdout || '',
      result.stderr || '',
    ].join('\n'));
  }
  return result;
}

function buildStoryboardHtmlInput(blueprint, opts) {
  return require('../../engine/storyboard2html-contract.cjs').buildStoryboard2HtmlInput(blueprint, opts);
}

function runStoryboardHtmlInputCli(inputPath, outPath, opts) {
  opts = opts || {};
  var args = [inputPath];
  if (outPath) args.push(outPath);
  if (opts.theme) args.push('--theme', opts.theme);
  if (opts.steps) args.push('--steps', String(opts.steps));
  return runScriptChecked('storyboard2html-input.cjs', args, opts);
}

function generateStoryboardHtml(inputPath, outHtml, opts) {
  opts = opts || {};
  var args = [inputPath, outHtml];
  if (opts.theme) args.push('--theme', opts.theme);
  if (opts.steps) args.push('--steps', String(opts.steps));
  if (opts.dryRun) args.push('--dry-run');
  if (opts.promptOnly) args.push('--prompt-only', opts.promptOnly);
  if (opts.model) args.push('--model', opts.model);
  if (opts.timeoutMs) args.push('--timeout-ms', String(opts.timeoutMs));
  return runScriptChecked('storyboard2html-generate.cjs', args, opts);
}

function runStoryboard2HtmlSmoke(htmlPath, outDir, opts) {
  opts = opts || {};
  var args = [htmlPath, outDir];
  if (opts.theme) args.push('--theme', opts.theme);
  if (opts.steps) args.push('--steps', String(opts.steps));
  if (opts.verifyRunner) args.push('--verify-runner', opts.verifyRunner);
  if (opts.dryRun) args.push('--dry-run');
  if (opts.allowNonRendererHtml) args.push('--allow-non-renderer-html');
  if (opts.requireSourceIrRenderer) args.push('--require-source-ir-renderer');
  if (opts.visualDiff) args.push('--visual-diff');
  if (opts.visualPhases) args.push('--visual-phases', String(opts.visualPhases));
  return runScriptChecked('storyboard2html-smoke.cjs', args, opts);
}

module.exports = {
  BLUEPRINT_ROOT: BLUEPRINT_ROOT,
  SCRIPT_ROOT: SCRIPT_ROOT,
  scriptPath: scriptPath,
  runScript: runScript,
  runScriptChecked: runScriptChecked,
  contract: require('../../engine/storyboard2html-contract.cjs'),
  prompt: require('../../engine/storyboard2html-prompt.cjs'),
  hardgate: require('../../engine/storyboard2html-hardgate.cjs'),
  buildStoryboardHtmlInput: buildStoryboardHtmlInput,
  runStoryboardHtmlInputCli: runStoryboardHtmlInputCli,
  generateStoryboardHtml: generateStoryboardHtml,
  runStoryboard2HtmlSmoke: runStoryboard2HtmlSmoke,
};
