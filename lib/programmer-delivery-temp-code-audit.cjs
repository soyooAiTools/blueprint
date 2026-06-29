'use strict';

var fs = require('fs');
var path = require('path');

var KIND = 'blueprint.programmerDeliveryTemporaryCodeAudit';
var SCHEMA_VERSION = 1;

function usage() {
  console.error('Usage: node lib/programmer-delivery-temp-code-audit.cjs <delivery-root> [--summary PROGRAMMER_DELIVERY_SUMMARY.json] [--hydration MCP_HYDRATION_REPORT.json] [--scene-bake-plan SCENE_BAKE_PLAN.json] [--out PROGRAMMER_TEMP_CODE_AUDIT.json] [--strict-aibridge]');
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

function listFiles(dir) {
  var out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
    var file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'Library' || entry.name === 'Temp' || entry.name === 'Obj' || entry.name === '.git') return;
      if (/\/Packages\/(?:AIBridge|cn\.lys\.aibridge)(?:\/|$)/.test(file.split(path.sep).join('/'))) return;
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

function addIssue(list, code, message, evidence) {
  list.push({
    code: code,
    message: message,
    evidence: evidence || []
  });
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

function countMatches(text, re) {
  var count = 0;
  String(text || '').replace(re, function() {
    count++;
    return '';
  });
  return count;
}

function runtimePrimitiveScripts(root) {
  return listFiles(path.join(root, 'Assets', 'Scripts')).filter(function(file) {
    return /\/GMP_Primitive(?:Builder|Spec)\.cs$/i.test(file.split(path.sep).join('/')) ||
      /\/SourceIrVisualAssetBaker\.cs$/i.test(file.split(path.sep).join('/'));
  }).map(function(file) {
    return rel(root, file);
  }).sort();
}

function generatedMeshAssetCount(root) {
  return listFiles(path.join(root, 'Assets', 'GeneratedMeshes')).filter(function(file) {
    return /\.asset$/i.test(file);
  }).length;
}

function auditProgrammerDeliveryTempCode(root, options) {
  root = path.resolve(root);
  options = options || {};
  var errors = [];
  var warnings = [];
  var summaryPath = options.summaryPath || path.join(root, 'PROGRAMMER_DELIVERY_SUMMARY.json');
  var hydrationPath = options.hydrationPath || path.join(root, 'MCP_HYDRATION_REPORT.json');
  var summary = options.summary || readJsonIfExists(summaryPath) || {};
  var hydration = options.hydrationReport || readJsonIfExists(hydrationPath) || null;
  var bakeReport = options.sceneBakeReport || readJsonIfExists(options.sceneBakeReportPath || path.join(root, 'SCENE_BAKE_REPORT.json')) || null;
  var bakePlan = options.sceneBakePlan || readJsonIfExists(options.sceneBakePlanPath || path.join(root, 'SCENE_BAKE_PLAN.json')) || null;
  var scenePath = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  var sceneText = fs.existsSync(scenePath) ? fs.readFileSync(scenePath, 'utf8') : '';
  var scripts = runtimePrimitiveScripts(root);
  var primitiveSpecFieldCount = countMatches(sceneText, /\n\s*mGeometryType:|\n\s*mArgs:/g);
  var primitiveSpecScriptGuidRefs = countMatches(sceneText, /m_Script:\s*\{fileID:\s*11500000,\s*guid:\s*[0-9a-fA-F]{32},\s*type:\s*3\}[\s\S]{0,240}?\n\s*mGeometryType:/g);
  var fallbackNames = captureSceneObjectNames(sceneText, /^SourcePrimitive_.*_Fallback_/);
  var meshCount = generatedMeshAssetCount(root);

  if (scripts.length) {
    addIssue(errors, 'temporary-primitive-runtime-scripts', 'Temporary primitive/source visual baker scripts remain in delivered Assets/Scripts; bake them in Editor and delete them before handoff.', scripts);
  }
  if (primitiveSpecFieldCount > 0 || primitiveSpecScriptGuidRefs > 0) {
    addIssue(errors, 'temporary-primitive-scene-components', 'Scene still contains GMP_PrimitiveSpec serialized fields/components; MeshFilter should reference baked Assets/GeneratedMeshes assets instead.', [
      'Assets/Scenes/Game.unity',
      'primitiveSpecSerializedFieldCount=' + primitiveSpecFieldCount
    ]);
  }
  if (bakeReport && bakeReport.passed === false) {
    addIssue(errors, 'scene-bake-report-failed', 'SCENE_BAKE_REPORT.json reports a failed Editor bake.', bakeReport.errors || []);
  }
  if (Number(summary.sourcePrimitiveScriptsWritten || 0) > 0 && !bakeReport && (scripts.length || primitiveSpecFieldCount > 0)) {
    addIssue(errors, 'scene-bake-report-missing', 'Cleaner wrote temporary primitive scripts but no SCENE_BAKE_REPORT.json proves they were baked and removed.', [
      'sourcePrimitiveScriptsWritten=' + summary.sourcePrimitiveScriptsWritten
    ]);
  }

  if (fallbackNames.length || Number(summary.fallbackSourcePrimitiveEntityCount || 0) > 0) {
    addIssue(warnings, 'fallback-source-primitives', 'Fallback SourcePrimitive objects are still present; prefer sourceEntityContract-backed visual primitives or explicit missing-asset failure.', fallbackNames);
  }
  if (hydration && (/static/i.test(String(hydration.mode || '')) || /static/i.test(String(hydration.toolLayer || '')))) {
    var issue = {
      code: 'static-hydration-evidence',
      message: 'Hydration report was produced by static YAML evidence; use real AIBridge/Editor hydration for final programmer delivery.',
      evidence: [String(hydration.mode || ''), String(hydration.toolLayer || '')].filter(Boolean)
    };
    if (options.strictAibridge) errors.push(issue);
    else warnings.push(issue);
  }
  if (!bakePlan) {
    addIssue(warnings, 'scene-bake-plan-missing', 'SCENE_BAKE_PLAN.json missing; generate it so AIBridge/Editor bake intent is explicit and reviewable.', []);
  }

  return {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: root,
    passed: errors.length === 0,
    errors: errors,
    warnings: warnings,
    summary: {
      temporaryRuntimeScriptCount: scripts.length,
      primitiveSpecSerializedFieldCount: primitiveSpecFieldCount,
      fallbackPrimitiveObjectCount: fallbackNames.length,
      generatedMeshAssetCount: meshCount,
      sourcePrimitiveScriptsWritten: Number(summary.sourcePrimitiveScriptsWritten || 0),
      sceneBakeReportPresent: !!bakeReport,
      sceneBakePlanPresent: !!bakePlan,
      hydrationMode: hydration ? String(hydration.mode || '') : '',
      hydrationToolLayer: hydration ? String(hydration.toolLayer || '') : ''
    },
    files: {
      temporaryRuntimeScripts: scripts,
      fallbackPrimitiveObjectNames: fallbackNames
    },
    redline: 'Final delivery must not use runtime scene generation or fallback code to mask storyboard2html/WebGL semantic drift.'
  };
}

function writeTempCodeAudit(root, outPath, options) {
  var report = auditProgrammerDeliveryTempCode(root, options || {});
  var target = outPath || path.join(path.resolve(root), 'PROGRAMMER_TEMP_CODE_AUDIT.json');
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  return report;
}

function parseArgs(argv) {
  var args = {
    root: argv[2] || '',
    outPath: '',
    summaryPath: '',
    hydrationPath: '',
    sceneBakePlanPath: '',
    strictAibridge: false
  };
  for (var i = 3; i < argv.length; i++) {
    var item = argv[i];
    if (item === '--out') args.outPath = argv[++i] || '';
    else if (item === '--summary') args.summaryPath = argv[++i] || '';
    else if (item === '--hydration') args.hydrationPath = argv[++i] || '';
    else if (item === '--scene-bake-plan') args.sceneBakePlanPath = argv[++i] || '';
    else if (item === '--strict-aibridge') args.strictAibridge = true;
    else usage();
  }
  if (!args.root) usage();
  args.root = path.resolve(args.root);
  args.outPath = args.outPath ? path.resolve(args.outPath) : path.join(args.root, 'PROGRAMMER_TEMP_CODE_AUDIT.json');
  args.summaryPath = args.summaryPath ? path.resolve(args.summaryPath) : path.join(args.root, 'PROGRAMMER_DELIVERY_SUMMARY.json');
  args.hydrationPath = args.hydrationPath ? path.resolve(args.hydrationPath) : path.join(args.root, 'MCP_HYDRATION_REPORT.json');
  args.sceneBakePlanPath = args.sceneBakePlanPath ? path.resolve(args.sceneBakePlanPath) : path.join(args.root, 'SCENE_BAKE_PLAN.json');
  return args;
}

if (require.main === module) {
  var args = parseArgs(process.argv);
  var report = writeTempCodeAudit(args.root, args.outPath, {
    summaryPath: args.summaryPath,
    hydrationPath: args.hydrationPath,
    sceneBakePlanPath: args.sceneBakePlanPath,
    strictAibridge: args.strictAibridge
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}

module.exports = {
  KIND: KIND,
  SCHEMA_VERSION: SCHEMA_VERSION,
  auditProgrammerDeliveryTempCode: auditProgrammerDeliveryTempCode,
  writeTempCodeAudit: writeTempCodeAudit
};
