'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var KIND = 'blueprint.programmerDeliverySceneBakePlan';
var SCHEMA_VERSION = 1;

function usage() {
  console.error('Usage: node lib/programmer-delivery-scene-bake-plan.cjs <delivery-root> [--summary PROGRAMMER_DELIVERY_SUMMARY.json] [--out SCENE_BAKE_PLAN.json]');
  process.exit(2);
}

function readJsonIfExists(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

function listFiles(dir) {
  var out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
    var file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'Library' || entry.name === 'Temp' || entry.name === 'Obj' || entry.name === '.git') return;
      out = out.concat(listFiles(file));
    } else if (entry.isFile()) {
      out.push(file);
    }
  });
  return out;
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function sourceSnapshot(root) {
  var candidates = [
    path.join(root, 'source-scene-ir.json'),
    path.join(root, 'source-ir.json')
  ];
  for (var i = 0; i < candidates.length; i++) {
    var data = readJsonIfExists(candidates[i]);
    if (data) {
      return {
        path: rel(root, candidates[i]),
        sha1: sha1(fs.readFileSync(candidates[i], 'utf8')),
        phaseCount: Array.isArray(data.phases) ? data.phases.length : 0,
        entityCount: Array.isArray(data.entities) ? data.entities.length : 0
      };
    }
  }
  return { path: '', sha1: '', phaseCount: 0, entityCount: 0 };
}

function phasePresetFiles(root) {
  return listFiles(path.join(root, 'Assets')).filter(function(file) {
    return /\/Assets\/Scripts\/Game\/Phases\/.+\.asset$/i.test(file.split(path.sep).join('/')) ||
      /\/Assets\/Scripts\/Core\/Modules\/.+Phase.+\.asset$/i.test(file.split(path.sep).join('/'));
  }).sort();
}

function countMatches(text, re) {
  var count = 0;
  String(text || '').replace(re, function() {
    count++;
    return '';
  });
  return count;
}

function captureSceneObjectNames(sceneText, re) {
  var names = [];
  String(sceneText || '').replace(/\n  m_Name:\s*([^\n\r]+)/g, function(_, name) {
    name = String(name || '').trim();
    if (re.test(name)) names.push(name);
    return _;
  });
  return names.sort();
}

function captureEntityBindings(sceneText) {
  var names = [];
  String(sceneText || '').replace(/\n\s*-?\s*mEntityName:\s*"([^"]+)"/g, function(_, name) {
    if (names.indexOf(name) < 0) names.push(name);
    return _;
  });
  return names.sort();
}

function runtimePrimitiveScripts(root) {
  return listFiles(path.join(root, 'Assets', 'Scripts')).filter(function(file) {
    return /\/GMP_Primitive(?:Builder|Spec)\.cs$/i.test(file.split(path.sep).join('/'));
  }).map(function(file) {
    return rel(root, file);
  }).sort();
}

function generatedMeshAssets(root) {
  return listFiles(path.join(root, 'Assets', 'GeneratedMeshes')).filter(function(file) {
    return /\.asset$/i.test(file);
  }).map(function(file) {
    return rel(root, file);
  }).sort();
}

function buildBakeActions(summary, sceneStats, scripts) {
  var actions = [];
  if (scripts.length || sceneStats.primitiveSpecSerializedFieldCount > 0) {
    actions.push({
      id: 'bake-primitive-spec-components',
      owner: 'AIBridge/UnityEditor',
      input: 'GMP_PrimitiveSpec scene components',
      output: 'Assets/GeneratedMeshes/*.asset assigned to MeshFilter.sharedMesh',
      cleanup: ['remove GMP_PrimitiveSpec components', 'delete GMP_PrimitiveSpec.cs', 'delete GMP_PrimitiveBuilder.cs']
    });
  }
  actions.push({
    id: 'hydrate-scene-references',
    owner: 'AIBridge/Inspector',
    input: 'SourceSceneIR/source-ir + scene objects',
    output: 'serialized manager refs, HUD refs, camera refs and GMP_EntityBindingManager.mBindings',
    cleanup: ['no runtime Find/AddComponent/new GameObject fallback']
  });
  actions.push({
    id: 'preserve-storyboard-webgl-parity',
    owner: 'SourceIR gate',
    input: 'source HTML -> SourceSceneIR/SourceIR -> playable-scene-ir',
    output: 'phase, guideText, targetSequence, entity/resource/gate semantics unchanged',
    cleanup: ['no Unity-side semantic fallback']
  });
  if (Number(summary && summary.fallbackSourcePrimitiveEntityCount || 0) > 0 || sceneStats.fallbackPrimitiveObjectNames.length > 0) {
    actions.push({
      id: 'replace-fallback-primitives-with-source-contract',
      owner: 'SourceIR visual extraction',
      input: 'fallback SourcePrimitive_*_Fallback scene objects',
      output: 'sourceEntityContract-backed primitives or explicit missing-asset failure',
      cleanup: ['remove heuristic gold/coin/ice/scrap fallback path from final delivery']
    });
  }
  return actions;
}

function buildSceneBakePlan(root, options) {
  root = path.resolve(root);
  options = options || {};
  var summary = readJsonIfExists(options.summaryPath) || {};
  var scenePath = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  var sceneText = fs.existsSync(scenePath) ? fs.readFileSync(scenePath, 'utf8') : '';
  var scripts = runtimePrimitiveScripts(root);
  var meshes = generatedMeshAssets(root);
  var fallbackNames = captureSceneObjectNames(sceneText, /^SourcePrimitive_.*_Fallback_/);
  var sceneStats = {
    exists: !!sceneText,
    path: rel(root, scenePath),
    sourcePrimitiveObjectCount: captureSceneObjectNames(sceneText, /^SourcePrimitive_/).length,
    fallbackPrimitiveObjectNames: fallbackNames,
    primitiveSpecSerializedFieldCount: countMatches(sceneText, /\n\s*mGeometryType:|\n\s*mArgs:/g),
    entityBindingCount: captureEntityBindings(sceneText).length,
    entityBindingNames: captureEntityBindings(sceneText),
    requiredManagerObjectCount: countMatches(sceneText, /\n\s*m_Name:\s*GMP_/g)
  };
  var source = sourceSnapshot(root);
  var phaseAssets = phasePresetFiles(root).map(function(file) { return rel(root, file); });

  return {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: root,
    sourceOfTruth: source,
    redline: 'storyboard2html HTML and final WebGL parity is the ultimate system invariant; Unity bake may not change phase, guideText, targetSequence, entity/resource/gate semantics.',
    strategy: {
      authority: 'AIBridge/UnityEditor pre-bake before programmer delivery',
      keepEntityBindingTableAsData: true,
      deleteRuntimeSceneGenerationCode: true,
      staticYamlFallbackIsDiagnosticOnly: true
    },
    scene: sceneStats,
    phasePresets: {
      assetCount: phaseAssets.length,
      assets: phaseAssets
    },
    generatedMeshes: {
      assetCount: meshes.length,
      sampleAssets: meshes.slice(0, 20)
    },
    temporaryRuntimeScripts: scripts,
    summarySignals: {
      sourcePrimitiveEntityCount: Number(summary.sourcePrimitiveEntityCount || 0),
      sourcePrimitiveRendererCount: Number(summary.sourcePrimitiveRendererCount || 0),
      sourcePrimitiveScriptsWritten: Number(summary.sourcePrimitiveScriptsWritten || 0),
      fallbackSourcePrimitiveEntityCount: Number(summary.fallbackSourcePrimitiveEntityCount || 0)
    },
    aibridge: {
      bakeScript: '.aibridge/code/blueprint_scene_bake.csx',
      expectedReport: 'SCENE_BAKE_REPORT.json',
      hydrationReport: 'MCP_HYDRATION_REPORT.json'
    },
    actions: buildBakeActions(summary, sceneStats, scripts)
  };
}

function writeSceneBakePlan(root, outPath, options) {
  var plan = buildSceneBakePlan(root, options || {});
  var target = outPath || path.join(path.resolve(root), 'SCENE_BAKE_PLAN.json');
  fs.writeFileSync(target, JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

function parseArgs(argv) {
  var args = { root: argv[2] || '', outPath: '', summaryPath: '' };
  for (var i = 3; i < argv.length; i++) {
    var item = argv[i];
    if (item === '--out') args.outPath = argv[++i] || '';
    else if (item === '--summary') args.summaryPath = argv[++i] || '';
    else usage();
  }
  if (!args.root) usage();
  args.root = path.resolve(args.root);
  args.outPath = args.outPath ? path.resolve(args.outPath) : path.join(args.root, 'SCENE_BAKE_PLAN.json');
  args.summaryPath = args.summaryPath ? path.resolve(args.summaryPath) : path.join(args.root, 'PROGRAMMER_DELIVERY_SUMMARY.json');
  return args;
}

if (require.main === module) {
  var args = parseArgs(process.argv);
  var plan = writeSceneBakePlan(args.root, args.outPath, { summaryPath: args.summaryPath });
  console.log(JSON.stringify(plan, null, 2));
}

module.exports = {
  KIND: KIND,
  SCHEMA_VERSION: SCHEMA_VERSION,
  buildSceneBakePlan: buildSceneBakePlan,
  writeSceneBakePlan: writeSceneBakePlan
};
