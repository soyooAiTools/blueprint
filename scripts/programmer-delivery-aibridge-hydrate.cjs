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

function bakeScriptPath(root) {
  return path.join(root, '.aibridge', 'code', 'blueprint_scene_bake.csx');
}

function bakeScriptRelPath() {
  return path.join('.aibridge', 'code', 'blueprint_scene_bake.csx').split(path.sep).join('/');
}

function buildSceneBakeCode() {
  return [
    'using System;',
    'using System.Collections.Generic;',
    'using System.IO;',
    'using System.Reflection;',
    'using System.Text;',
    'using UnityEditor;',
    'using UnityEditor.SceneManagement;',
    'using UnityEngine;',
    'using UnityEngine.SceneManagement;',
    '',
    'string ProjectRoot()',
    '{',
    '    return Directory.GetParent(Application.dataPath).FullName;',
    '}',
    '',
    'string JsonEscape(string value)',
    '{',
    '    if (value == null) return "";',
    '    return value.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\n", "\\\\n").Replace("\\r", "\\\\r");',
    '}',
    '',
    'string Sanitize(string value)',
    '{',
    '    if (string.IsNullOrEmpty(value)) return "Mesh";',
    '    var builder = new StringBuilder();',
    '    for (int i = 0; i < value.Length; i++)',
    '    {',
    '        char ch = value[i];',
    '        builder.Append(char.IsLetterOrDigit(ch) || ch == \'_\' || ch == \'-\' ? ch : \'_\');',
    '    }',
    '    return builder.Length == 0 ? "Mesh" : builder.ToString();',
    '}',
    '',
    'void EnsureFolder(string folder)',
    '{',
    '    if (string.IsNullOrEmpty(folder) || folder == "Assets" || AssetDatabase.IsValidFolder(folder)) return;',
    '    string parent = Path.GetDirectoryName(folder).Replace("\\\\", "/");',
    '    EnsureFolder(parent);',
    '    AssetDatabase.CreateFolder(string.IsNullOrEmpty(parent) ? "Assets" : parent, Path.GetFileName(folder));',
    '}',
    '',
    'var errors = new List<string>();',
    'var bakedAssetPaths = new List<string>();',
    'int primitiveSpecComponentsFound = 0;',
    'int primitiveSpecComponentsRemoved = 0;',
    'int generatedMeshAssetCount = 0;',
    'int tempScriptsDeleted = 0;',
    '',
    'try',
    '{',
    '    var scene = SceneManager.GetActiveScene();',
    '    EnsureFolder("Assets/GeneratedMeshes");',
    '',
    '    var specs = new List<MonoBehaviour>();',
    '    foreach (var root in scene.GetRootGameObjects())',
    '    {',
    '        var behaviours = root.GetComponentsInChildren<MonoBehaviour>(true);',
    '        for (int i = 0; i < behaviours.Length; i++)',
    '        {',
    '            var behaviour = behaviours[i];',
    '            if (behaviour == null) continue;',
    '            if (behaviour.GetType().Name == "GMP_PrimitiveSpec") specs.Add(behaviour);',
    '        }',
    '    }',
    '',
    '    primitiveSpecComponentsFound = specs.Count;',
    '    for (int i = 0; i < specs.Count; i++)',
    '    {',
    '        var spec = specs[i];',
    '        if (spec == null) continue;',
    '        var go = spec.gameObject;',
    '        var filter = go.GetComponent<MeshFilter>();',
    '        var rebuild = spec.GetType().GetMethod("Rebuild", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);',
    '        if (rebuild != null) rebuild.Invoke(spec, null);',
    '        if (filter == null || filter.sharedMesh == null)',
    '        {',
    '            errors.Add("Primitive spec has no mesh after rebuild: " + go.name);',
    '            continue;',
    '        }',
    '',
    '        string assetPath = "Assets/GeneratedMeshes/" + i.ToString("0000") + "_" + Sanitize(go.name) + ".asset";',
    '        var meshCopy = UnityEngine.Object.Instantiate(filter.sharedMesh);',
    '        meshCopy.name = Path.GetFileNameWithoutExtension(assetPath);',
    '        var existing = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);',
    '        if (existing != null)',
    '        {',
    '            EditorUtility.CopySerialized(meshCopy, existing);',
    '            filter.sharedMesh = existing;',
    '            UnityEngine.Object.DestroyImmediate(meshCopy);',
    '        }',
    '        else',
    '        {',
    '            AssetDatabase.CreateAsset(meshCopy, assetPath);',
    '            filter.sharedMesh = meshCopy;',
    '            generatedMeshAssetCount++;',
    '        }',
    '        bakedAssetPaths.Add(assetPath);',
    '        UnityEngine.Object.DestroyImmediate(spec, true);',
    '        primitiveSpecComponentsRemoved++;',
    '        EditorUtility.SetDirty(go);',
    '    }',
    '',
    '    string[] tempScripts = new string[]',
    '    {',
    '        "Assets/Scripts/Tool/GMP_PrimitiveSpec.cs",',
    '        "Assets/Scripts/Tool/GMP_PrimitiveBuilder.cs"',
    '    };',
    '    for (int i = 0; i < tempScripts.Length; i++)',
    '    {',
    '        if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(tempScripts[i]) != null && AssetDatabase.DeleteAsset(tempScripts[i])) tempScriptsDeleted++;',
    '    }',
    '',
    '    AssetDatabase.SaveAssets();',
    '    EditorSceneManager.MarkSceneDirty(scene);',
    '    EditorSceneManager.SaveScene(scene);',
    '    AssetDatabase.Refresh();',
    '}',
    'catch (Exception ex)',
    '{',
    '    errors.Add(ex.GetType().Name + ": " + ex.Message);',
    '}',
    '',
    'var json = new StringBuilder();',
    'json.AppendLine("{");',
    'json.AppendLine("  \\"kind\\": \\"blueprint.programmerDeliverySceneBakeReport\\",");',
    'json.AppendLine("  \\"schemaVersion\\": 1,");',
    'json.AppendLine("  \\"generatedAt\\": \\"" + DateTime.UtcNow.ToString("o") + "\\",");',
    'json.AppendLine("  \\"activeScene\\": \\"" + JsonEscape(SceneManager.GetActiveScene().path) + "\\",");',
    'json.AppendLine("  \\"primitiveSpecComponentsFound\\": " + primitiveSpecComponentsFound + ",");',
    'json.AppendLine("  \\"primitiveSpecComponentsRemoved\\": " + primitiveSpecComponentsRemoved + ",");',
    'json.AppendLine("  \\"generatedMeshAssetCount\\": " + generatedMeshAssetCount + ",");',
    'json.AppendLine("  \\"tempScriptsDeleted\\": " + tempScriptsDeleted + ",");',
    'json.AppendLine("  \\"bakedAssetPaths\\": [");',
    'for (int i = 0; i < bakedAssetPaths.Count; i++)',
    '{',
    '    json.Append("    \\"").Append(JsonEscape(bakedAssetPaths[i])).Append("\\"");',
    '    json.AppendLine(i + 1 < bakedAssetPaths.Count ? "," : "");',
    '}',
    'json.AppendLine("  ],");',
    'json.AppendLine("  \\"errors\\": [");',
    'for (int i = 0; i < errors.Count; i++)',
    '{',
    '    json.Append("    \\"").Append(JsonEscape(errors[i])).Append("\\"");',
    '    json.AppendLine(i + 1 < errors.Count ? "," : "");',
    '}',
    'json.AppendLine("  ],");',
    'json.AppendLine("  \\"passed\\": " + (errors.Count == 0 ? "true" : "false"));',
    'json.AppendLine("}");',
    '',
    'File.WriteAllText(Path.Combine(ProjectRoot(), "SCENE_BAKE_REPORT.json"), json.ToString());',
    'return new Dictionary<string, object>',
    '{',
    '    { "primitiveSpecComponentsFound", primitiveSpecComponentsFound },',
    '    { "primitiveSpecComponentsRemoved", primitiveSpecComponentsRemoved },',
    '    { "generatedMeshAssetCount", generatedMeshAssetCount },',
    '    { "tempScriptsDeleted", tempScriptsDeleted },',
    '    { "errorCount", errors.Count }',
    '};',
    ''
  ].join('\n');
}

function ensureSceneBakeScript(root) {
  var file = bakeScriptPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildSceneBakeCode() + '\n');
  return file;
}

function buildCommands(root, scenePath, timeoutMs) {
  ensureSceneBakeScript(root);
  var commands = [
    makeCommand('scene load', ['scene', 'load', '--scenePath', scenePath, '--mode', 'single']),
    makeCommand('compile unity before scene bake', ['compile', 'unity', '--timeout', String(timeoutMs || DEFAULT_TIMEOUT_MS)]),
    makeCommand('code execute blueprint scene bake', ['code', 'execute', '--file', bakeScriptRelPath(), '--timeout', String(timeoutMs || DEFAULT_TIMEOUT_MS)]),
    makeCommand('scene save after scene bake', ['scene', 'save']),
    makeCommand('compile unity after scene bake', ['compile', 'unity', '--timeout', String(timeoutMs || DEFAULT_TIMEOUT_MS)]),
    makeCommand('scene get_active', ['scene', 'get_active']),
    makeCommand('scene get_hierarchy', ['scene', 'get_hierarchy', '--depth', '8', '--includeInactive', 'true'])
  ];
  hydration.REQUIRED_SCENE_SCRIPTS.forEach(function(item) {
    commands.push(makeCommand('inspector get_components ' + item.objectName, ['inspector', 'get_components', '--path', item.objectName]));
  });
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
  report.summary.sceneBakeRan = commandResults.some(function(item) {
    return item.label === 'code execute blueprint scene bake' && item.passed;
  });
  return report;
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function runHydration(options) {
  var cli = resolveCli(options.root);
  var commandResults = [];
  if (cli) {
    var probeTimeout = Math.min(Math.max(1000, options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS), DEFAULT_PROBE_TIMEOUT_MS);
    var probe = runCliCommand(cli, options.root, buildReadinessProbeCommand(probeTimeout), probeTimeout + 2000);
    commandResults.push(probe);
    if (probe.passed) {
      buildCommands(options.root, options.scenePath, options.timeoutMs).forEach(function(command) {
        commandResults.push(runCliCommand(cli, options.root, command, options.timeoutMs));
      });
    }
  }

  var report = hydration.validateHydration(options.root, {
    mode: cli ? 'aibridge-cli' : 'static-unity-yaml'
  });
  var sceneBakeReport = readJsonIfExists(path.join(options.root, 'SCENE_BAKE_REPORT.json'));
  if (sceneBakeReport) {
    report.sceneBake = sceneBakeReport;
    if (sceneBakeReport.passed === false) {
      report.errors.push('SCENE_BAKE_REPORT.json says scene bake failed');
      report.passed = false;
    }
  } else if (cli && commandResults.some(function(item) { return item.label === 'code execute blueprint scene bake' && item.passed; })) {
    report.warnings.push('AIBridge scene bake command passed but SCENE_BAKE_REPORT.json was not written');
  }
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
