#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_BLUEPRINT_ROOT,
  buildBlueprintContext,
  loadJson,
  writeBlueprintArtifacts,
} = require('./blueprint-project.js');
const {
  loadVisualAssetManifest,
} = require('./visual-assets.js');
const {
  loadUnityAssetPlan,
} = require('./unity-asset-plan.js');
const {
  injectVisualOverlay,
} = require('./visual-overlay.js');
const {
  runObserveVerify,
} = require('./verify-facade.cjs');

function usage() {
  console.error('Usage: node run-blueprint-smoke.js <demo2spec-outdir|gameschema.json> [outdir] [--verify] [--verify-runner direct|production] [--steps N]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 1) usage();
  const opts = { input: args[0], outDir: null, verify: false, steps: 40, verifyRunner: null };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verify') {
      opts.verify = true;
    } else if (arg === '--verify-runner') {
      opts.verifyRunner = args[++i] || null;
      opts.verify = true;
    } else if (arg === '--steps') {
      opts.steps = Number(args[++i] || 0) || 40;
    } else if (!opts.outDir) {
      opts.outDir = arg;
    } else {
      usage();
    }
  }
  return opts;
}

function resolvePaths(opts) {
  const input = path.resolve(opts.input);
  const stat = fs.statSync(input);
  const gameschemaPath = stat.isDirectory() ? path.join(input, 'gameschema.json') : input;
  if (!fs.existsSync(gameschemaPath)) throw new Error('missing gameschema.json: ' + gameschemaPath);
  const baseOutDir = opts.outDir
    ? path.resolve(opts.outDir)
    : path.join(path.dirname(gameschemaPath), 'blueprint-smoke');
  return { gameschemaPath, outDir: baseOutDir };
}

function writeGeneratedFiles(outDir, ctx) {
  fs.writeFileSync(path.join(outDir, 'GameFlowManagerMain.cs'), ctx.csCode);
  Object.keys(ctx.extraFiles || {}).sort().forEach(fileName => {
    if (!/^GameFlowManagerMain\./.test(fileName)) return;
    fs.writeFileSync(path.join(outDir, fileName), ctx.extraFiles[fileName]);
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const { gameschemaPath, outDir } = resolvePaths(opts);
  const blueprintRoot = process.env.BLUEPRINT_EDITOR_ROOT || DEFAULT_BLUEPRINT_ROOT;
  const codegenStage = require(path.join(blueprintRoot, 'engine/stages/codegen-schema.cjs'));
  const { buildFromCS } = require(path.join(blueprintRoot, 'worker/linux-bridge-build.js'));
  const { loadGfmFiles } = require(path.join(blueprintRoot, 'worker/gfm-files.cjs'));

  fs.mkdirSync(outDir, { recursive: true });
  const gameSchema = loadJson(gameschemaPath);
  const htmlPhaseSlicesPath = path.join(path.dirname(gameschemaPath), 'html-phase-slices.json');
  const assetManifestPath = path.join(path.dirname(gameschemaPath), 'asset-manifest.json');
  const unityAssetPlanPath = path.join(path.dirname(gameschemaPath), 'unity-asset-plan.json');
  const built = buildBlueprintContext(gameSchema, {
    projectName: path.basename(path.dirname(gameschemaPath)) + '-empty-project',
    source: gameschemaPath,
    blueprintRoot,
    htmlPhaseSlices: fs.existsSync(htmlPhaseSlicesPath) ? loadJson(htmlPhaseSlicesPath) : {},
    assetManifest: fs.existsSync(assetManifestPath) ? loadVisualAssetManifest(assetManifestPath) : null,
    unityAssetPlan: fs.existsSync(unityAssetPlanPath) ? loadUnityAssetPlan(unityAssetPlanPath) : null,
  });
  writeBlueprintArtifacts(outDir, built.project, built.blueprint);

  const ctx = {
    taskId: 'demo2spec-blueprint-smoke-' + Date.now(),
    csCode: null,
    extraFiles: {},
    blueprint: built.blueprint,
    addLog(stage, message) {
      console.log('[codegen][' + stage + '] ' + message);
    },
  };

  await codegenStage.execute(ctx);
  writeGeneratedFiles(outDir, ctx);

  const extraFiles = Object.assign({}, loadGfmFiles(), ctx.extraFiles);
  const buildResult = await buildFromCS(ctx.csCode, {
    taskId: ctx.taskId,
    className: 'GameFlowManagerMain',
    extraFiles,
    visualAssets: built.blueprint.visualAssets || null,
    log(message, taskId) {
      console.log('[' + taskId + '] ' + message);
    },
  });
  fs.writeFileSync(path.join(outDir, 'build-result.json'), JSON.stringify({
    ok: buildResult.ok,
    error: buildResult.error || null,
    buildTime: buildResult.buildTime || null,
    htmlSize: buildResult.html ? buildResult.html.length : 0,
    codegen: {
      prebuiltGameSchemaUsed: ctx.blueprint.prebuiltGameSchemaUsed === true,
      customLogicRoute: ctx.blueprint.customLogicRoute || null,
      assemblyImplementationCoverage: ctx.blueprint.assemblyImplementationCoverage,
      assemblyImplementationMissingCount: ctx.blueprint.assemblyImplementationMissingCount,
    },
  }, null, 2));
  if (!buildResult.ok) throw new Error(buildResult.error || 'Luna build failed');
  const htmlWithSourceVisuals = injectVisualOverlay(
    buildResult.html,
    built.blueprint.visualAssets || null
  );
  fs.writeFileSync(path.join(outDir, 'index.html'), htmlWithSourceVisuals);

  if (opts.verify) {
    await runObserveVerify({ outDir, steps: opts.steps, verifyRunner: opts.verifyRunner, stream: true });
  }

  console.log(JSON.stringify({
    ok: true,
    gameschema: gameschemaPath,
    outDir,
    html: path.join(outDir, 'index.html'),
    verifySummary: opts.verify ? path.join(outDir, 'unity-verify-summary.json') : null,
  }, null, 2));
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
