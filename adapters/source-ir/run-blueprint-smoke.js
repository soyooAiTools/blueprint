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
const {
  loadPlayableSceneIr,
} = require('../../engine/playable-scene-ir.cjs');

function usage() {
  console.error('Usage: node run-blueprint-smoke.js <source-ir-outdir|gameschema.json> [outdir] [--verify] [--verify-runner direct|production] [--steps N]');
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

function appendBeforeClassEnd(source, block) {
  const marker = '\n}';
  const idx = source.lastIndexOf(marker);
  if (idx < 0) return source + '\n' + block + '\n';
  return source.slice(0, idx) + '\n' + block + source.slice(idx);
}

function insertBeforeClassOrStart(source, block) {
  const text = String(source || '');
  const markerIdx = text.lastIndexOf('\n    // TODO_VARIABLES_END');
  if (markerIdx >= 0) return text.slice(0, markerIdx) + '\n' + block + '\n' + text.slice(markerIdx);
  const startMatch = /\n[ \t]*void\s+Start\s*\(/.exec(text);
  if (startMatch) return text.slice(0, startMatch.index + 1) + block + '\n' + text.slice(startMatch.index + 1);
  return appendBeforeClassEnd(text, block);
}

function hasResourceBridgeDeclarations(code) {
  if (!code) return { hasStruct: false, hasField: false };
  const text = String(code);
  return {
    hasStruct: /\bstruct\s+ResourceDef\b/.test(text),
    hasField: /\bResourceDef\[\]\s+_resources\b/.test(text),
  };
}

function addPreBuildCompatibilityRepairs(ctx) {
  if (!ctx || typeof ctx.csCode !== 'string') return;
  const blueprintRoot = process.env.BLUEPRINT_EDITOR_ROOT || DEFAULT_BLUEPRINT_ROOT;
  const methodCheck = require(path.join(blueprintRoot, 'engine/stages/method-check.cjs'));

  const repairCtx = {
    csCode: ctx.csCode,
    extraFiles: Object.assign({}, ctx.extraFiles || {}),
    blueprint: ctx.blueprint || {},
  };

  if (typeof methodCheck.autoRepairMissingSkeletonBridgeInfra === 'function') {
    methodCheck.autoRepairMissingSkeletonBridgeInfra(repairCtx);
  }

  const allCode = [repairCtx.csCode].concat(Object.values(repairCtx.extraFiles || {})).join('\n');
  if (/\b_manualGameplayUnlocked\b/.test(allCode) && !/\bbool\s+_manualGameplayUnlocked\b/.test(allCode)) {
    repairCtx.csCode = appendBeforeClassEnd(repairCtx.csCode, [
      '// [AUTO-REPAIR] Compile-safe gameplay unlock flag for generated templates.',
      'bool _manualGameplayUnlocked = false;',
    ].join('\n'));
  }

  const finalCode = [repairCtx.csCode].concat(Object.values(repairCtx.extraFiles || {})).join('\n');
  const needsEconomyBridge = /\b(AddResource|GetResource|TrySpend|TryConvert|UpdateResourceUI|_SyncResourcesToManager)\s*\(/.test(finalCode) ||
    /\b_resources\b/.test(finalCode);
  const needsIsNear = /\bIsNear\s*\(/.test(finalCode);
  const hasIsNear = /\bbool\s+IsNear\s*\(/.test(finalCode) || /\bfloat\s+IsNear\s*\(/.test(finalCode);
  if (needsIsNear && !hasIsNear) {
    repairCtx.csCode = appendBeforeClassEnd(repairCtx.csCode, [
      '// [AUTO-REPAIR] Compile-safe player near-helper when emitted via assembly specs.',
      'bool IsNear(GameObject target, float range)',
      '{',
      '    var gp = GFM_Player.Instance;',
      '    return gp != null && gp.IsNear(target, range);',
      '}',
    ].join('\n'));
  }

  if (needsEconomyBridge) {
    const bridgeDecl = hasResourceBridgeDeclarations(finalCode);
    const bridgeFields = [];
    if (!bridgeDecl.hasStruct) {
      bridgeFields.push(
        '// [AUTO-REPAIR] Economy bridge type used by generated resource skeleton.',
        '    struct ResourceDef',
        '    {',
        '        public string resourceId;',
        '        public string displayName;',
        '        public string convertFrom;',
        '        public int convertRatio;',
        '    }'
      );
    }
    if (!bridgeDecl.hasField) {
      bridgeFields.push(
        '// [AUTO-REPAIR] Economy bridge storage for generated runtime sync.',
        '    ResourceDef[] _resources;'
      );
    }
    if (bridgeFields.length > 0) {
      repairCtx.csCode = insertBeforeClassOrStart(repairCtx.csCode, bridgeFields.join('\n'));
    }
  }

  ctx.csCode = repairCtx.csCode;
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
  const playableSceneIrPath = path.join(path.dirname(gameschemaPath), 'playable-scene-ir.json');
  const unityAssetPlanPath = path.join(path.dirname(gameschemaPath), 'unity-asset-plan.json');
  const assetManifest = fs.existsSync(assetManifestPath) ? loadVisualAssetManifest(assetManifestPath) : null;
  const playableSceneIr = fs.existsSync(playableSceneIrPath) ? loadPlayableSceneIr(playableSceneIrPath) : null;
  if (assetManifest && !playableSceneIr && process.env.SOURCE_IR_REQUIRE_PLAYABLE_SCENE_IR !== '0') {
    throw new Error('missing playable-scene-ir.json for source-bound SourceIR build: ' + playableSceneIrPath);
  }
  const built = buildBlueprintContext(gameSchema, {
    projectName: path.basename(path.dirname(gameschemaPath)) + '-empty-project',
    source: gameschemaPath,
    blueprintRoot,
    htmlPhaseSlices: fs.existsSync(htmlPhaseSlicesPath) ? loadJson(htmlPhaseSlicesPath) : {},
    assetManifest,
    playableSceneIr,
    requireAssetManifestHash: assetManifest && playableSceneIr ? process.env.SOURCE_IR_REQUIRE_PLAYABLE_SCENE_IR_HASH !== '0' : false,
    unityAssetPlan: fs.existsSync(unityAssetPlanPath) ? loadUnityAssetPlan(unityAssetPlanPath) : null,
  });
  writeBlueprintArtifacts(outDir, built.project, built.blueprint);

  const ctx = {
    taskId: 'source-ir-blueprint-smoke-' + Date.now(),
    csCode: null,
    extraFiles: {},
    blueprint: built.blueprint,
    addLog(stage, message) {
      console.log('[codegen][' + stage + '] ' + message);
    },
  };

  await codegenStage.execute(ctx);
  addPreBuildCompatibilityRepairs(ctx);
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
    sourceBinding: {
      sourceHtmlPath: built.blueprint.sourceHtmlPath || null,
      sourceHtmlSha256: built.blueprint.sourceHtmlSha256 || null,
      playableSceneIrHash: built.blueprint.playableSceneIrHash || null,
    },
  }, null, 2));
  if (!buildResult.ok) throw new Error(buildResult.error || 'Luna build failed');
  const htmlWithSourceVisuals = injectVisualOverlay(
    buildResult.html,
    built.blueprint.visualAssets || null,
    built.blueprint.playableSceneIr || null
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
