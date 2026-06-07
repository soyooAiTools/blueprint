'use strict';

var path = require('path');
var {
  buildBlueprintContext,
  writeBlueprintArtifacts,
} = require('../demo2spec/blueprint-project.js');
var {
  compileToGameSchema,
} = require('./compile-to-gameschema.js');
var {
  compileVisualAssetManifest,
} = require('./compile-visual-assets.js');
var {
  compilePlayableSceneIr,
} = require('./compile-playable-scene-ir.js');

function cloneOrNull(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function buildSourceIrBlueprintContext(sourceIr, options) {
  options = options || {};
  var gameSchema = options.gameSchema || compileToGameSchema(sourceIr, options);
  var playableSceneIr = options.playableSceneIr || compilePlayableSceneIr(sourceIr, options);
  var assetManifest = options.assetManifest || compileVisualAssetManifest(sourceIr, {
    project: options.projectName,
    sourceHtmlPath: playableSceneIr.source && playableSceneIr.source.htmlPath,
    sourceHtmlSha256: playableSceneIr.source && playableSceneIr.source.htmlSha256,
    playableSceneIrHash: playableSceneIr.semanticHash,
    generatedAt: options.generatedAt,
  });
  var built = buildBlueprintContext(gameSchema, {
    projectName: options.projectName || sourceIr.project && sourceIr.project.name || 'source-ir',
    source: options.source || null,
    assetManifest: assetManifest,
    playableSceneIr: playableSceneIr,
    unityAssetPlan: options.unityAssetPlan || null,
    requireAssetManifestHash: !!(assetManifest && assetManifest.sourceHtmlSha256),
    buildProjectPlans: options.buildProjectPlans,
    blueprintRoot: options.blueprintRoot,
  });
  built.blueprint.schemaSource = 'source-scene-ir';
  built.blueprint.semanticSource = 'source-scene-ir';
  built.blueprint.legacyJsInferenceUsed = false;
  built.blueprint.sourceMeshOps = cloneOrNull(assetManifest && assetManifest.sourceMeshOps || null);
  built.project.semanticSource = 'source-scene-ir';
  built.project.legacyJsInferenceUsed = false;
  return built;
}

function writeSourceIrBlueprintArtifacts(outDir, sourceIr, options) {
  options = options || {};
  var built = buildSourceIrBlueprintContext(sourceIr, Object.assign({}, options, {
    source: options.source || path.join(outDir, 'gameschema.json'),
  }));
  writeBlueprintArtifacts(outDir, built.project, built.blueprint);
  return built;
}

module.exports = {
  buildSourceIrBlueprintContext: buildSourceIrBlueprintContext,
  writeSourceIrBlueprintArtifacts: writeSourceIrBlueprintArtifacts,
};
