#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var {
  extractSourceSceneIrFromHtml,
  loadSourceSceneIr,
  normalizeSourceSceneIr,
  sha256OfString,
  writeSourceSceneIr,
} = require('../../engine/source-scene-ir.cjs');
var {
  writePlayableSceneIr,
} = require('../../engine/playable-scene-ir.cjs');
var visualAssets = require('../demo2spec/visual-assets.js');
var {
  writeSnapshotSchema,
  buildCuaSpecs,
  buildCuaPlans,
  buildGameStateShim,
} = require('../demo2spec/snapshot-schema.js');
var {
  buildUnityAssetPlan,
  writeUnityAssetPlan,
  writeUnityEditorBaker,
} = require('../demo2spec/unity-asset-plan.js');
var {
  compileToGameSchema,
} = require('./compile-to-gameschema.js');
var {
  compileVisualAssetManifest,
} = require('./compile-visual-assets.js');
var {
  compilePlayableSceneIr,
} = require('./compile-playable-scene-ir.js');
var {
  buildSourceIrBlueprintContext,
  writeSourceIrBlueprintArtifacts,
} = require('./compile-blueprint-context.js');

function usage() {
  console.error('Usage: node adapters/source-ir/index.js <source.html|source-ir.json> <outdir> [--project name] [--no-blueprint]');
}

function parseArgs(argv) {
  var opts = { input: null, outDir: null, projectName: null, noBlueprint: false };
  for (var i = 2; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--project') opts.projectName = argv[++i] || opts.projectName;
    else if (arg === '--no-blueprint') opts.noBlueprint = true;
    else if (!opts.input) opts.input = arg;
    else if (!opts.outDir) opts.outDir = arg;
    else {
      usage();
      process.exit(2);
    }
  }
  if (!opts.input || !opts.outDir) {
    usage();
    process.exit(2);
  }
  return opts;
}

function loadSourceIrFromInput(inputPath, options) {
  options = options || {};
  var abs = path.resolve(inputPath);
  var text = fs.readFileSync(abs, 'utf8');
  if (/\.json$/i.test(abs)) {
    var loaded = loadSourceSceneIr(abs) || JSON.parse(text);
    return normalizeSourceSceneIr(loaded, {
      sourceHtmlPath: loaded.source && loaded.source.htmlPath || abs,
      sourceHtmlSha256: loaded.source && loaded.source.htmlSha256 || sha256OfString(text),
      generatedAt: options.generatedAt,
    });
  }
  return extractSourceSceneIrFromHtml(text, abs, {
    project: options.projectName || null,
    generatedAt: options.generatedAt,
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function buildHtmlPhaseSlices(sourceIr) {
  var out = {};
  (sourceIr.phases || []).forEach(function(phase, index) {
    out[phase.id || ('phase' + (index + 1))] = '';
  });
  return out;
}

function buildSourceIrArtifacts(inputPath, outDir, options) {
  options = options || {};
  var absOut = path.resolve(outDir);
  var sourceIr = options.sourceIr || loadSourceIrFromInput(inputPath, options);
  var projectName = options.projectName || sourceIr.project && sourceIr.project.name || 'source-ir';
  var gameSchema = compileToGameSchema(sourceIr, options);
  var playableSceneIr = compilePlayableSceneIr(sourceIr, options);
  var assetManifest = compileVisualAssetManifest(sourceIr, {
    project: projectName,
    sourceHtmlPath: playableSceneIr.source && playableSceneIr.source.htmlPath,
    sourceHtmlSha256: playableSceneIr.source && playableSceneIr.source.htmlSha256,
    playableSceneIrHash: playableSceneIr.semanticHash,
    generatedAt: options.generatedAt,
  });
  var spec = {
    meta: {
      project: projectName,
      extractor: 'source-scene-ir',
      semanticSource: 'source-scene-ir',
      legacyJsInferenceUsed: false,
      sourceSceneIrHash: sourceIr.semanticHash,
      sourceHtmlPath: sourceIr.source && sourceIr.source.htmlPath || null,
      sourceHtmlSha256: sourceIr.source && sourceIr.source.htmlSha256 || null,
      assetManifestPath: 'asset-manifest.json',
      visualRuntimeContractPath: 'visual-runtime-contract.json',
      playableSceneIrPath: 'playable-scene-ir.json',
      htmlPhaseSlicesPath: 'html-phase-slices.json',
      playableSceneIrHash: playableSceneIr.semanticHash,
    },
    notes: ['SourceSceneIR deterministic compiler; no legacy JS inference used.'],
    phases: gameSchema.phases,
    entities: gameSchema.entities,
    resources: gameSchema.resources || [],
    gfmGaps: [],
  };
  var htmlPhaseSlices = buildHtmlPhaseSlices(sourceIr);
  var snapshotSchema = writeSnapshotSchema(path.join(absOut, 'snapshot-schema.json'), {
    spec: spec,
    gameSchema: gameSchema,
    assetManifest: assetManifest,
  });
  var unityAssetPlan = buildUnityAssetPlan(assetManifest, {
    source: path.join(absOut, 'spec.json'),
    project: projectName,
  });
  fs.mkdirSync(absOut, { recursive: true });
  writeSourceSceneIr(path.join(absOut, 'source-ir.json'), sourceIr);
  writeJson(path.join(absOut, 'gameschema.json'), gameSchema);
  writeJson(path.join(absOut, 'spec.json'), spec);
  writeJson(path.join(absOut, 'html-phase-slices.json'), htmlPhaseSlices);
  writeJson(path.join(absOut, 'cua-specs.json'), buildCuaSpecs(gameSchema));
  writeJson(path.join(absOut, 'cua-plans.json'), buildCuaPlans(snapshotSchema));
  fs.writeFileSync(path.join(absOut, 'game-state-shim.js'), buildGameStateShim(snapshotSchema));
  visualAssets.writeVisualAssetManifest(path.join(absOut, 'asset-manifest.json'), assetManifest);
  visualAssets.writeVisualRuntimeContract(path.join(absOut, 'visual-runtime-contract.json'), assetManifest.visualRuntimeContract);
  writePlayableSceneIr(path.join(absOut, 'playable-scene-ir.json'), playableSceneIr);
  writeUnityAssetPlan(path.join(absOut, 'unity-asset-plan.json'), unityAssetPlan);
  writeUnityEditorBaker(path.join(absOut, 'Demo2SpecVisualAssetBaker.cs'), unityAssetPlan);
  var blueprint = null;
  if (options.noBlueprint !== true) {
    blueprint = buildSourceIrBlueprintContext(sourceIr, {
      projectName: projectName,
      source: path.join(absOut, 'gameschema.json'),
      gameSchema: gameSchema,
      assetManifest: assetManifest,
      playableSceneIr: playableSceneIr,
      unityAssetPlan: unityAssetPlan,
      buildProjectPlans: options.buildProjectPlans,
      blueprintRoot: options.blueprintRoot,
    });
    writeSourceIrBlueprintArtifacts(absOut, sourceIr, {
      projectName: projectName,
      source: path.join(absOut, 'gameschema.json'),
      gameSchema: gameSchema,
      assetManifest: assetManifest,
      playableSceneIr: playableSceneIr,
      unityAssetPlan: unityAssetPlan,
      buildProjectPlans: options.buildProjectPlans,
      blueprintRoot: options.blueprintRoot,
    });
  }
  return {
    sourceIr: sourceIr,
    gameSchema: gameSchema,
    assetManifest: assetManifest,
    playableSceneIr: playableSceneIr,
    blueprint: blueprint,
    paths: {
      sourceIr: path.join(absOut, 'source-ir.json'),
      gameSchema: path.join(absOut, 'gameschema.json'),
      spec: path.join(absOut, 'spec.json'),
      snapshotSchema: path.join(absOut, 'snapshot-schema.json'),
      htmlPhaseSlices: path.join(absOut, 'html-phase-slices.json'),
      assetManifest: path.join(absOut, 'asset-manifest.json'),
      visualRuntimeContract: path.join(absOut, 'visual-runtime-contract.json'),
      playableSceneIr: path.join(absOut, 'playable-scene-ir.json'),
      unityAssetPlan: path.join(absOut, 'unity-asset-plan.json'),
      unityEditorBaker: path.join(absOut, 'Demo2SpecVisualAssetBaker.cs'),
    },
  };
}

function main() {
  var opts = parseArgs(process.argv);
  var result = buildSourceIrArtifacts(opts.input, opts.outDir, opts);
  console.log(JSON.stringify({
    ok: true,
    semanticSource: 'source-scene-ir',
    legacyJsInferenceUsed: false,
    sourceSceneIrHash: result.sourceIr.semanticHash,
    playableSceneIrHash: result.playableSceneIr.semanticHash,
    paths: result.paths,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  buildSourceIrArtifacts: buildSourceIrArtifacts,
  loadSourceIrFromInput: loadSourceIrFromInput,
  compileToGameSchema: compileToGameSchema,
  compileVisualAssetManifest: compileVisualAssetManifest,
  compilePlayableSceneIr: compilePlayableSceneIr,
  buildSourceIrBlueprintContext: buildSourceIrBlueprintContext,
};
