#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var emitter = require('../lib/unitycomponent-v1-emitter.cjs');
var smoke = require('./unitycomponent-v1-unity-smoke.cjs');

var KIND = 'blueprint.unityNativeWebglBuildReport';
var SCHEMA_VERSION = 1;
var WEBGL_TEMPLATE_NAME = 'BlueprintPlayable';
var WEBGL_TEMPLATE_ID = 'PROJECT:' + WEBGL_TEMPLATE_NAME;
var WEBGL_TEMPLATE_DEVICE_PIXEL_RATIO = 0.45;
var WEBGL_TEMPLATE_TARGET_RENDER_WIDTH = 480;
var WEBGL_TEMPLATE_MIN_DEVICE_PIXEL_RATIO = 0.35;

function parseArgs(argv) {
  var args = argv || process.argv.slice(2);
  var out = {
    artifactsDir: '',
    unityOut: '',
    webglOut: '',
    unity: process.env.UNITY_EDITOR || process.env.UNITY_PATH || '',
    report: '',
    parityReport: '',
    paritySnapshot: '',
    parityTimeoutMs: 60000,
    log: '',
    required: false,
    dryRun: false,
    generatedAt: ''
  };
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (arg === '--artifacts-dir') out.artifactsDir = String(args[++i] || '');
    else if (arg === '--unity-out') out.unityOut = String(args[++i] || '');
    else if (arg === '--webgl-out') out.webglOut = String(args[++i] || '');
    else if (arg === '--unity') out.unity = String(args[++i] || '');
    else if (arg === '--report') out.report = String(args[++i] || '');
    else if (arg === '--parity-report') out.parityReport = String(args[++i] || '');
    else if (arg === '--parity-snapshot') out.paritySnapshot = String(args[++i] || '');
    else if (arg === '--parity-timeout-ms') out.parityTimeoutMs = Math.max(1000, Number(args[++i] || 0) || 60000);
    else if (arg === '--log') out.log = String(args[++i] || '');
    else if (arg === '--required') out.required = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--generated-at') out.generatedAt = String(args[++i] || '');
    else throw new Error('Unexpected argument: ' + arg);
  }
  if (!out.artifactsDir || !out.unityOut || !out.webglOut) {
    throw new Error('Usage: node scripts/unity-native-webgl-build.cjs --artifacts-dir <source-ir-artifacts> --unity-out <unity-project-dir> --webgl-out <webgl-dir> [--unity /path/to/Unity] [--report out.json] [--parity-report out.json] [--parity-snapshot out.json] [--parity-timeout-ms N] [--log unity.log] [--required] [--dry-run]');
  }
  return out;
}

function executableExists(file) {
  if (!file) return false;
  if (file.indexOf(path.sep) >= 0) return fs.existsSync(file);
  try {
    childProcess.execFileSync('which', [file], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (err) {
    return false;
  }
}

function findUnity(explicit) {
  var candidates = [
    explicit,
    'Unity',
    '/opt/unity-2022.3.14/Editor/Unity',
    '/opt/Unity/Editor/Unity'
  ].filter(Boolean);
  for (var i = 0; i < candidates.length; i++) {
    if (executableExists(candidates[i])) return candidates[i];
  }
  return '';
}

function unityEditorDir(unity) {
  if (!unity || unity.indexOf(path.sep) < 0) return '';
  return path.dirname(path.resolve(unity));
}

function webglSupportStatus(unity) {
  var editorDir = unityEditorDir(unity);
  var webglSupportPath = editorDir ? path.join(editorDir, 'Data', 'PlaybackEngines', 'WebGLSupport') : '';
  return {
    unity: unity || '',
    editorDir: editorDir,
    webglSupportPath: webglSupportPath,
    present: !!(webglSupportPath && fs.existsSync(webglSupportPath))
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readJsonIfExists(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function runParityGate(artifactsDir, webglOut, specHash, parityReportPath, runtimeSnapshotPath, timeoutMs) {
  var scriptPath = path.join(__dirname, 'unity-native-webgl-parity.cjs');
  var args = [
    scriptPath,
    '--source-ir',
    path.join(artifactsDir, 'source-ir.json'),
    '--webgl-dir',
    webglOut,
    '--out',
    parityReportPath,
    '--runtime-snapshot-out',
    runtimeSnapshotPath,
    '--unity-delivery-spec-semantic-hash',
    specHash,
    '--timeout-ms',
    String(timeoutMs || 60000)
  ];
  var result = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    reportPath: parityReportPath,
    runtimeSnapshotPath: runtimeSnapshotPath,
    report: null
  };
  try {
    result.stdout = childProcess.execFileSync(process.execPath, args, {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    result.exitCode = typeof err.status === 'number' ? err.status : 1;
    result.stdout = err.stdout ? String(err.stdout) : '';
    result.stderr = err.stderr ? String(err.stderr) : '';
  }
  result.report = readJsonIfExists(parityReportPath);
  return result;
}

function validateArtifactsDir(artifactsDir) {
  var dir = path.resolve(artifactsDir);
  var missing = [];
  ['source-ir.json'].forEach(function(name) {
    if (!fs.existsSync(path.join(dir, name))) missing.push(name);
  });
  return {
    dir: dir,
    missing: missing,
    warnings: ['playable-scene-ir.json', 'asset-manifest.json'].filter(function(name) {
      return !fs.existsSync(path.join(dir, name));
    })
  };
}

function editorBuildScriptText() {
  return [
    'using System;',
    'using System.IO;',
    'using UnityEditor;',
    'using UnityEditor.Build.Reporting;',
    'using UnityEditor.SceneManagement;',
    'using UnityEngine;',
    '',
    'public static class BlueprintNativeWebGLBuild',
    '{',
    '    private const string ScenePath = "Assets/Scenes/Game.unity";',
    '    private const string GameEntryPrefabPath = "Assets/SLGFrameWork/Scripts/Prefab/GameEntry.prefab";',
    '',
    '    public static void Build()',
    '    {',
    '        string outputPath = Environment.GetEnvironmentVariable("BLUEPRINT_NATIVE_WEBGL_OUT");',
    '        string reportPath = Environment.GetEnvironmentVariable("BLUEPRINT_NATIVE_WEBGL_EDITOR_REPORT");',
    '        string sourceHash = Environment.GetEnvironmentVariable("BLUEPRINT_SOURCE_IR_SEMANTIC_HASH") ?? string.Empty;',
    '        string specHash = Environment.GetEnvironmentVariable("BLUEPRINT_UNITY_DELIVERY_SPEC_SEMANTIC_HASH") ?? string.Empty;',
    '        DateTime startedAt = DateTime.UtcNow;',
    '        try',
    '        {',
    '            if (string.IsNullOrEmpty(outputPath)) throw new InvalidOperationException("BLUEPRINT_NATIVE_WEBGL_OUT is required.");',
    '            Directory.CreateDirectory(outputPath);',
    '            EnsureBuildScene();',
    '            BuildPlayerOptions options = new BuildPlayerOptions();',
    '            options.scenes = new[] { ScenePath };',
    '            options.locationPathName = outputPath;',
    '            options.target = BuildTarget.WebGL;',
    '            options.options = BuildOptions.None;',
    '            BuildReport buildReport = BuildPipeline.BuildPlayer(options);',
    '            BuildSummary summary = buildReport.summary;',
    '            string status = summary.result == BuildResult.Succeeded ? "passed" : "failed";',
    '            WriteReport(reportPath, status, outputPath, sourceHash, specHash, summary.result.ToString(), summary.totalErrors, summary.totalWarnings, startedAt, string.Empty);',
    '            if (summary.result != BuildResult.Succeeded) throw new InvalidOperationException("Unity WebGL build failed: " + summary.result);',
    '        }',
    '        catch (Exception err)',
    '        {',
    '            WriteReport(reportPath, "failed", outputPath, sourceHash, specHash, "Exception", 1, 0, startedAt, err.ToString());',
    '            throw;',
    '        }',
    '    }',
    '',
    '    private static void EnsureBuildScene()',
    '    {',
    '        Directory.CreateDirectory("Assets/Scenes");',
    '        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);',
    '        GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(GameEntryPrefabPath);',
    '        if (prefab == null) throw new InvalidOperationException("Missing GameEntry prefab: " + GameEntryPrefabPath);',
    '        PrefabUtility.InstantiatePrefab(prefab);',
    '        GameObject cameraGo = new GameObject("Main Camera");',
    '        Camera camera = cameraGo.AddComponent<Camera>();',
    '        cameraGo.tag = "MainCamera";',
    '        camera.transform.position = new Vector3(0f, 8f, -12f);',
    '        camera.transform.rotation = Quaternion.Euler(35f, 0f, 0f);',
    '        GameObject lightGo = new GameObject("Directional Light");',
    '        Light light = lightGo.AddComponent<Light>();',
    '        light.type = LightType.Directional;',
    '        light.transform.rotation = Quaternion.Euler(50f, -30f, 0f);',
    '        EditorSceneManager.SaveScene(EditorSceneManager.GetActiveScene(), ScenePath);',
    '        AssetDatabase.SaveAssets();',
    '    }',
    '',
    '    private static void WriteReport(string reportPath, string status, string outputPath, string sourceHash, string specHash, string result, int errors, int warnings, DateTime startedAt, string error)',
    '    {',
    '        if (string.IsNullOrEmpty(reportPath)) return;',
    '        Directory.CreateDirectory(Path.GetDirectoryName(reportPath));',
    '        string json = "{" +',
    '            "\\n  \\"kind\\": \\"blueprint.unityNativeWebglEditorBuildReport\\"," +',
    '            "\\n  \\"schemaVersion\\": 1," +',
    '            "\\n  \\"status\\": " + Json(status) + "," +',
    '            "\\n  \\"unityVersion\\": " + Json(Application.unityVersion) + "," +',
    '            "\\n  \\"target\\": \\"WebGL\\"," +',
    '            "\\n  \\"outputPath\\": " + Json(outputPath) + "," +',
    '            "\\n  \\"scenePath\\": " + Json(ScenePath) + "," +',
    '            "\\n  \\"sourceIrSemanticHash\\": " + Json(sourceHash) + "," +',
    '            "\\n  \\"unityDeliverySpecSemanticHash\\": " + Json(specHash) + "," +',
    '            "\\n  \\"result\\": " + Json(result) + "," +',
    '            "\\n  \\"totalErrors\\": " + errors + "," +',
    '            "\\n  \\"totalWarnings\\": " + warnings + "," +',
    '            "\\n  \\"startedAt\\": " + Json(startedAt.ToString("o")) + "," +',
    '            "\\n  \\"finishedAt\\": " + Json(DateTime.UtcNow.ToString("o")) + "," +',
    '            "\\n  \\"error\\": " + Json(error) + "\\n}\\n";',
    '        File.WriteAllText(reportPath, json);',
    '    }',
    '',
    '    private static string Json(string value)',
    '    {',
    '        if (value == null) return "\\"\\"";',
    '        return "\\"" + value.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\n", "\\\\n").Replace("\\r", "\\\\r") + "\\"";',
    '    }',
    '}',
    ''
  ].join('\n');
}

function injectEditorBuildScript(projectPath) {
  var file = path.join(projectPath, 'Assets', 'Editor', 'BlueprintNativeWebGLBuild.cs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, editorBuildScriptText());
  return file;
}

function webglTemplateIndexHtmlText() {
  return [
    '<!DOCTYPE html>',
    '<html lang="en-us">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
    '  <meta name="viewport" content="width=device-width, height=device-height, initial-scale=1.0, user-scalable=no, shrink-to-fit=yes">',
    '  <title>{{{ PRODUCT_NAME }}}</title>',
    '  <style>',
    '    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #05070a; }',
    '    #unity-container { position: fixed; inset: 0; width: 100%; height: 100%; overflow: hidden; }',
    '    #unity-canvas { width: 100%; height: 100%; display: block; background: #05070a; outline: none; }',
    '    #unity-warning { position: fixed; left: 12px; right: 12px; bottom: 12px; color: #fff; font: 12px/1.4 sans-serif; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div id="unity-container">',
    '    <canvas id="unity-canvas" width="{{{ WIDTH }}}" height="{{{ HEIGHT }}}" tabindex="-1"></canvas>',
    '    <div id="unity-warning"></div>',
    '  </div>',
    '  <script>',
    '    var canvas = document.querySelector("#unity-canvas");',
    '    var warningBanner = document.querySelector("#unity-warning");',
    '    function unityShowBanner(msg, type) {',
    '      if (!warningBanner) return;',
    '      var div = document.createElement("div");',
    '      div.textContent = msg;',
    '      div.style.background = type === "error" ? "#b00020" : "#333";',
    '      div.style.padding = "8px";',
    '      div.style.marginTop = "4px";',
    '      warningBanner.appendChild(div);',
    '      if (type !== "error") setTimeout(function() { if (div.parentNode) div.parentNode.removeChild(div); }, 5000);',
    '    }',
    '    var buildUrl = "Build";',
    '    var loaderUrl = buildUrl + "/{{{ LOADER_FILENAME }}}";',
    '    var config = {',
    '      dataUrl: buildUrl + "/{{{ DATA_FILENAME }}}",',
    '      frameworkUrl: buildUrl + "/{{{ FRAMEWORK_FILENAME }}}",',
    '#if USE_THREADS',
    '      workerUrl: buildUrl + "/{{{ WORKER_FILENAME }}}",',
    '#endif',
    '#if USE_WASM',
    '      codeUrl: buildUrl + "/{{{ CODE_FILENAME }}}",',
    '#endif',
    '#if MEMORY_FILENAME',
    '      memoryUrl: buildUrl + "/{{{ MEMORY_FILENAME }}}",',
    '#endif',
    '#if SYMBOLS_FILENAME',
    '      symbolsUrl: buildUrl + "/{{{ SYMBOLS_FILENAME }}}",',
    '#endif',
    '      streamingAssetsUrl: "StreamingAssets",',
    '      companyName: {{{ JSON.stringify(COMPANY_NAME) }}},',
    '      productName: {{{ JSON.stringify(PRODUCT_NAME) }}},',
    '      productVersion: {{{ JSON.stringify(PRODUCT_VERSION) }}},',
    '      showBanner: unityShowBanner,',
    '      devicePixelRatio: Math.min(' + WEBGL_TEMPLATE_DEVICE_PIXEL_RATIO + ', Math.max(' + WEBGL_TEMPLATE_MIN_DEVICE_PIXEL_RATIO + ', ' + WEBGL_TEMPLATE_TARGET_RENDER_WIDTH + ' / Math.max(window.innerWidth || 1, 1)))',
    '    };',
    '    var script = document.createElement("script");',
    '    script.src = loaderUrl;',
    '    script.onload = function() {',
    '      createUnityInstance(canvas, config).catch(function(message) { unityShowBanner(message, "error"); });',
    '    };',
    '    document.body.appendChild(script);',
    '  </script>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

function injectWebglTemplate(projectPath) {
  var templateDir = path.join(projectPath, 'Assets', 'WebGLTemplates', WEBGL_TEMPLATE_NAME);
  var indexHtml = path.join(templateDir, 'index.html');
  fs.mkdirSync(templateDir, { recursive: true });
  fs.writeFileSync(indexHtml, webglTemplateIndexHtmlText());

  var projectSettings = path.join(projectPath, 'ProjectSettings', 'ProjectSettings.asset');
  var projectSettingsPatched = false;
  if (fs.existsSync(projectSettings)) {
    var text = fs.readFileSync(projectSettings, 'utf8');
    var next = /(^\s*webGLTemplate:\s*).+$/m.test(text)
      ? text.replace(/(^\s*webGLTemplate:\s*).+$/m, '$1' + WEBGL_TEMPLATE_ID)
      : text.replace(/\s*$/g, '') + '\n  webGLTemplate: ' + WEBGL_TEMPLATE_ID + '\n';
    if (next !== text) {
      fs.writeFileSync(projectSettings, next);
      projectSettingsPatched = true;
    }
  }

  return {
    id: WEBGL_TEMPLATE_ID,
    name: WEBGL_TEMPLATE_NAME,
    indexHtml: indexHtml,
    devicePixelRatio: WEBGL_TEMPLATE_DEVICE_PIXEL_RATIO,
    minDevicePixelRatio: WEBGL_TEMPLATE_MIN_DEVICE_PIXEL_RATIO,
    targetRenderWidth: WEBGL_TEMPLATE_TARGET_RENDER_WIDTH,
    projectSettingsPath: projectSettings,
    projectSettingsPatched: projectSettingsPatched
  };
}

function baseReport(status, opts, extra) {
  var report = Object.assign({
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    status: status,
    profile: 'unitycomponent-v1',
    artifactsDir: path.resolve(opts.artifactsDir),
    unityProjectPath: path.resolve(opts.unityOut),
    webglOut: path.resolve(opts.webglOut),
    reportPath: opts._reportPath ? path.resolve(opts._reportPath) : '',
    required: !!opts.required,
    dryRun: !!opts.dryRun
  }, extra || {});
  report.passed = report.status === 'passed';
  return report;
}

function runNativeWebglBuild(opts) {
  opts = opts || {};
  var artifacts = validateArtifactsDir(opts.artifactsDir);
  var unityOut = path.resolve(opts.unityOut);
  var webglOut = path.resolve(opts.webglOut);
  var reportPath = path.resolve(opts.report || path.join(webglOut, 'UNITY_NATIVE_WEBGL_BUILD_REPORT.json'));
  var parityReportPath = path.resolve(opts.parityReport || path.join(webglOut, 'UNITY_NATIVE_WEBGL_PARITY_REPORT.json'));
  var paritySnapshotPath = path.resolve(opts.paritySnapshot || path.join(webglOut, 'UNITY_NATIVE_WEBGL_RUNTIME_SNAPSHOT.json'));
  var logPath = path.resolve(opts.log || path.join(os.tmpdir(), 'unity-native-webgl-build-' + process.pid + '.log'));
  opts = Object.assign({}, opts, { _reportPath: reportPath });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.mkdirSync(path.dirname(parityReportPath), { recursive: true });
  fs.mkdirSync(path.dirname(paritySnapshotPath), { recursive: true });
  fs.mkdirSync(webglOut, { recursive: true });

  if (artifacts.missing.length) {
    var missingReport = baseReport('failed', opts, {
      reason: 'source-ir-artifacts-missing',
      missingArtifacts: artifacts.missing,
      artifactWarnings: artifacts.warnings
    });
    writeJson(reportPath, missingReport);
    throw new Error('Unity native WebGL build requires SourceIR artifacts: ' + artifacts.missing.join(', '));
  }

  var emitted = emitter.emitFromArtifacts(artifacts.dir, unityOut, { generatedAt: opts.generatedAt });
  var editorScript = injectEditorBuildScript(unityOut);
  var webglTemplate = injectWebglTemplate(unityOut);
  var unity = findUnity(opts.unity);
  var support = webglSupportStatus(unity);
  var sourceHash = emitted.spec.source && emitted.spec.source.sourceIrSemanticHash || '';
  var specHash = emitted.spec.semanticHash || '';

  if (opts.dryRun) {
    var dryRunReport = baseReport('dry-run', opts, {
      unity: unity,
      webglSupport: support,
      editorBuildScript: editorScript,
      webglTemplate: webglTemplate,
      parityReportPath: parityReportPath,
      paritySnapshotPath: paritySnapshotPath,
      sourceIrSemanticHash: sourceHash,
      unityDeliverySpecSemanticHash: specHash,
      unityComponentValidation: emitted.report.summary,
      artifactWarnings: artifacts.warnings
    });
    writeJson(reportPath, dryRunReport);
    return dryRunReport;
  }

  if (!unity) {
    var skipped = baseReport('blocked', opts, {
      reason: 'unity-editor-not-found',
      detail: 'Set UNITY_EDITOR/UNITY_PATH or pass --unity. Native WebGL output must come from Unity Editor BuildTarget.WebGL.',
      editorBuildScript: editorScript,
      webglTemplate: webglTemplate,
      parityReportPath: parityReportPath,
      paritySnapshotPath: paritySnapshotPath,
      sourceIrSemanticHash: sourceHash,
      unityDeliverySpecSemanticHash: specHash,
      unityComponentValidation: emitted.report.summary,
      artifactWarnings: artifacts.warnings
    });
    writeJson(reportPath, skipped);
    if (opts.required) throw new Error(skipped.detail);
    return skipped;
  }

  if (!support.present) {
    var blocked = baseReport('blocked', opts, {
      reason: 'unity-webgl-support-missing',
      detail: 'Unity Editor is installed but WebGL Build Support is missing; cannot produce native Unity WebGL output on this host.',
      unity: unity,
      webglSupport: support,
      editorBuildScript: editorScript,
      webglTemplate: webglTemplate,
      parityReportPath: parityReportPath,
      paritySnapshotPath: paritySnapshotPath,
      sourceIrSemanticHash: sourceHash,
      unityDeliverySpecSemanticHash: specHash,
      unityComponentValidation: emitted.report.summary,
      artifactWarnings: artifacts.warnings
    });
    writeJson(reportPath, blocked);
    if (opts.required) throw new Error(blocked.detail + ' Expected: ' + support.webglSupportPath);
    return blocked;
  }

  var editorReportPath = path.join(unityOut, 'UNITY_NATIVE_WEBGL_BUILD_REPORT.editor.json');
  var args = [
    '-batchmode',
    '-quit',
    '-nographics',
    '-projectPath',
    unityOut,
    '-executeMethod',
    'BlueprintNativeWebGLBuild.Build',
    '-logFile',
    logPath
  ];
  var exitCode = 0;
  try {
    childProcess.execFileSync(unity, args, {
      cwd: unityOut,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        BLUEPRINT_NATIVE_WEBGL_OUT: webglOut,
        BLUEPRINT_NATIVE_WEBGL_EDITOR_REPORT: editorReportPath,
        BLUEPRINT_SOURCE_IR_SEMANTIC_HASH: sourceHash,
        BLUEPRINT_UNITY_DELIVERY_SPEC_SEMANTIC_HASH: specHash
      })
    });
  } catch (err) {
    exitCode = typeof err.status === 'number' ? err.status : 1;
  }

  var logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  var logAudit = smoke.auditUnityLog(logText, unityOut);
  var editorReport = readJsonIfExists(editorReportPath);
  var hasIndex = fs.existsSync(path.join(webglOut, 'index.html'));
  var hasBuildDir = fs.existsSync(path.join(webglOut, 'Build'));
  var parityResult = null;
  var failed = exitCode !== 0 || !logAudit.passed || !editorReport || editorReport.status !== 'passed' || !hasIndex || !hasBuildDir ||
    /error CS\d+|Scripts have compiler errors|Compiler errors|Failed to compile/i.test(logText);
  var failureReason = failed ? 'unity-native-webgl-editor-build-failed' : '';
  if (!failed) {
    parityResult = runParityGate(artifacts.dir, webglOut, specHash, parityReportPath, paritySnapshotPath, opts.parityTimeoutMs);
    if (parityResult.exitCode !== 0 || !parityResult.report || parityResult.report.passed !== true) {
      failed = true;
      failureReason = 'unity-native-webgl-parity-failed';
    }
  }
  var report = baseReport(failed ? 'failed' : 'passed', opts, {
    reason: failureReason,
    unity: unity,
    webglSupport: support,
    editorBuildScript: editorScript,
    webglTemplate: webglTemplate,
    sourceIrSemanticHash: sourceHash,
    unityDeliverySpecSemanticHash: specHash,
    unityComponentValidation: emitted.report.summary,
    artifactWarnings: artifacts.warnings,
    exitCode: exitCode,
    logPath: logPath,
    logAudit: logAudit,
    editorReportPath: editorReportPath,
    editorReport: editorReport,
    parityReportPath: parityReportPath,
    paritySnapshotPath: paritySnapshotPath,
    parityGate: parityResult,
    outputChecks: {
      indexHtml: hasIndex,
      buildDir: hasBuildDir,
      parityReport: !!(parityResult && parityResult.report && parityResult.report.passed === true),
      runtimeSnapshot: fs.existsSync(paritySnapshotPath)
    }
  });
  writeJson(reportPath, report);
  if (failed) throw new Error('Unity native WebGL build failed; see ' + reportPath + ' and ' + logPath);
  return report;
}

function main(argv) {
  var result = runNativeWebglBuild(parseArgs(argv || process.argv.slice(2)));
  process.stdout.write(JSON.stringify({
    ok: result.passed,
    status: result.status,
    reason: result.reason || '',
    report: path.resolve(result.outPath || result.reportPath || '')
  }, null, 2) + '\n');
  if (result.status === 'failed') process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  }
}

module.exports = {
  KIND: KIND,
  SCHEMA_VERSION: SCHEMA_VERSION,
  parseArgs: parseArgs,
  findUnity: findUnity,
  webglSupportStatus: webglSupportStatus,
  editorBuildScriptText: editorBuildScriptText,
  injectEditorBuildScript: injectEditorBuildScript,
  webglTemplateIndexHtmlText: webglTemplateIndexHtmlText,
  injectWebglTemplate: injectWebglTemplate,
  runNativeWebglBuild: runNativeWebglBuild
};
