'use strict';

var {
  PLAYABLE_SCENE_IR_SCHEMA_VERSION,
  PLAYABLE_SCENE_IR_KIND,
  computePlayableSceneIrHash,
  validatePlayableSceneIr,
} = require('../../engine/playable-scene-ir.cjs');
var {
  normalizeSourceSceneIr,
  projectSourceSceneIrToLegacy,
  validateSourceSceneIr,
} = require('../../engine/source-scene-ir.cjs');

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function positionObject(position) {
  position = safeArray(position);
  return {
    x: Number(position[0]) || 0,
    y: Number(position[1]) || 0,
    z: Number(position[2]) || 0,
  };
}

function compilePlayableSceneIr(sourceIr, options) {
  options = options || {};
  var ir = normalizeSourceSceneIr(sourceIr, options);
  validateSourceSceneIr(ir);
  var projection = projectSourceSceneIrToLegacy(ir);
  var sourceHtmlPath = ir.source && ir.source.htmlPath || options.sourceHtmlPath || options.sourcePath || null;
  var sourceHtmlSha256 = ir.source && ir.source.htmlSha256 || options.sourceHtmlSha256 || null;
  var playable = {
    schemaVersion: PLAYABLE_SCENE_IR_SCHEMA_VERSION,
    kind: PLAYABLE_SCENE_IR_KIND,
    generatedAt: options.generatedAt || ir.generatedAt || new Date().toISOString(),
    source: {
      htmlPath: sourceHtmlPath,
      htmlSha256: sourceHtmlSha256,
    },
    project: clone(ir.project),
    scene: clone(ir.scene),
    entities: safeArray(ir.entities).map(function(entity) {
      return {
        name: entity.id,
        label: entity.label || entity.id,
        kind: entity.kind || null,
        color: entity.visual && entity.visual.color || null,
        position: positionObject(entity.position),
        style: clone(entity.visual || null),
        composite: null,
        assetIds: [],
        primaryAssetId: null,
        fidelityTarget: null,
        visualFallback: 'source-scene-ir-procedural',
      };
    }),
    phases: safeArray(ir.phases).map(function(phase, index) {
      var projected = projection.PHASES[index] || {};
      return {
        index: index,
        id: phase.id,
        name: phase.title || phase.id,
        guideText: phase.guideText || '',
        goalText: phase.goalText || '',
        showEntities: safeArray(phase.showEntities),
        trigger: projected.trigger || null,
        steps: safeArray(projected.steps),
        hudText: clone(phase.hudText || null),
        plannedModuleIds: safeArray(phase.plannedModuleIds),
      };
    }),
    entityBindings: {},
    assets: [],
    unsupported: [],
    extractionSummary: {
      source: 'source-scene-ir',
      sourceSceneIrHash: ir.semanticHash,
    },
    diagnostics: {
      sourceSceneIrHash: ir.semanticHash,
    },
  };
  playable.semanticHash = computePlayableSceneIrHash(playable);
  validatePlayableSceneIr(playable);
  return playable;
}

module.exports = {
  compilePlayableSceneIr: compilePlayableSceneIr,
};
