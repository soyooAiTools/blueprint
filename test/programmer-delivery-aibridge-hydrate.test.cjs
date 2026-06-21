'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

var hydrateScript = path.join(__dirname, '..', 'scripts', 'programmer-delivery-aibridge-hydrate.cjs');

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function guidFor(rel) {
  return crypto.createHash('sha1').update(rel).digest('hex').slice(0, 32);
}

function writeScript(root, rel, code) {
  writeFile(path.join(root, rel), code);
  writeFile(path.join(root, rel + '.meta'), [
    'fileFormatVersion: 2',
    'guid: ' + guidFor(rel),
    'MonoImporter:',
    '  externalObjects: {}',
    ''
  ].join('\n'));
}

function sceneObject(name, rel, index, audio) {
  var go = 1000 + index * 100;
  var tr = go + 1;
  var mb = go + 2;
  var lines = [
    '--- !u!1 &' + go,
    'GameObject:',
    '  m_Component:',
    '  - component: {fileID: ' + tr + '}',
    '  - component: {fileID: ' + mb + '}'
  ];
  if (audio) {
    for (var a = 0; a < 4; a++) lines.push('  - component: {fileID: ' + (go + 10 + a) + '}');
  }
  lines = lines.concat([
    '  m_Name: ' + name,
    '--- !u!4 &' + tr,
    'Transform:',
    '  m_GameObject: {fileID: ' + go + '}',
    '--- !u!114 &' + mb,
    'MonoBehaviour:',
    '  m_GameObject: {fileID: ' + go + '}',
    '  m_Script: {fileID: 11500000, guid: ' + guidFor(rel) + ', type: 3}'
  ]);
  if (audio) {
    for (var i = 0; i < 4; i++) {
      lines = lines.concat([
        '--- !u!82 &' + (go + 10 + i),
        'AudioSource:',
        '  m_GameObject: {fileID: ' + go + '}'
      ]);
    }
  }
  return lines.join('\n');
}

function makeRoot() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-aibridge-hydrate-'));
  var required = [
    { name: 'GMP_MainManager', rel: 'Assets/Scripts/Core/Modules/GMP_MainManager.cs' },
    { name: 'GMP_PhaseController', rel: 'Assets/Scripts/Core/Modules/GMP_PhaseController.cs' },
    { name: 'GMP_Audio', rel: 'Assets/Scripts/Core/Modules/GMP_Audio.cs', audio: true },
    { name: 'GMP_UIManager', rel: 'Assets/Scripts/Core/Modules/GMP_UIManager.cs' },
    { name: 'GMP_HudController', rel: 'Assets/Scripts/Core/Modules/GMP_HudController.cs' },
    { name: 'GMP_EventModule', rel: 'Assets/Scripts/Core/Modules/GMP_EventModule.cs' },
    { name: 'GMP_CameraController', rel: 'Assets/Scripts/Tool/GMP_CameraController.cs' },
    { name: 'GMP_SceneEntityRefs', rel: 'Assets/Scripts/Game/Level/GMP_SceneEntityRefs.cs' },
    { name: 'GMP_LevelRuleEngine', rel: 'Assets/Scripts/Game/Level/GMP_LevelRuleEngine.cs' },
    { name: 'GMP_Player', rel: 'Assets/Scripts/Game/Player/GMP_Player.cs' },
    { name: 'GMP_AutoPlayDriver', rel: 'Assets/Scripts/Game/AutoPlay/GMP_AutoPlayDriver.cs' }
  ];
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Tool'), { recursive: true });
  required.forEach(function(item) {
    writeScript(root, item.rel, 'using UnityEngine;\npublic class ' + item.name + ' : MonoBehaviour {}\n');
  });
  writeFile(path.join(root, 'Assets', 'Scenes', 'Game.unity'), ['%YAML 1.1'].concat(required.map(function(item, index) {
    return sceneObject(item.name, item.rel, index + 1, item.audio);
  }), ['']).join('\n'));
  writeFile(path.join(root, 'source-scene-ir.json'), JSON.stringify({
    schemaVersion: 'source-scene-ir.v1',
    entities: [{ id: '_chef', label: 'Chef' }],
    phases: [{ phaseId: 'serve', guideText: 'Serve' }]
  }, null, 2) + '\n');
  return root;
}

function makeMockCli(root) {
  var log = path.join(root, 'aibridge-calls.jsonl');
  var cli = path.join(root, 'mock-aibridge-cli.js');
  writeFile(cli, [
    '#!/usr/bin/env node',
    "'use strict';",
    "var fs = require('fs');",
    'var args = process.argv.slice(2);',
    "fs.appendFileSync(process.env.AIBRIDGE_MOCK_LOG, JSON.stringify(args) + '\\n');",
    "process.stdout.write(JSON.stringify({ success: true, args: args }) + '\\n');",
    ''
  ].join('\n'));
  fs.chmodSync(cli, 493);
  return { cli: cli, log: log };
}

function makeFailingMockCli(root) {
  var log = path.join(root, 'aibridge-failing-calls.jsonl');
  var cli = path.join(root, 'mock-failing-aibridge-cli.js');
  writeFile(cli, [
    '#!/usr/bin/env node',
    "'use strict';",
    "var fs = require('fs');",
    'var args = process.argv.slice(2);',
    "fs.appendFileSync(process.env.AIBRIDGE_MOCK_LOG, JSON.stringify(args) + '\\n');",
    "process.stderr.write('Unity Editor is not ready for AIBridge commands\\n');",
    'process.exit(2);',
    ''
  ].join('\n'));
  fs.chmodSync(cli, 493);
  return { cli: cli, log: log };
}

function readCalls(log) {
  return fs.readFileSync(log, 'utf8').trim().split(/\n/).filter(Boolean).map(function(line) {
    return JSON.parse(line);
  });
}

var root = makeRoot();
try {
  var mock = makeMockCli(root);
  var out = path.join(root, 'MCP_HYDRATION_REPORT.json');
  var result = childProcess.spawnSync(process.execPath, [
    hydrateScript,
    root,
    '--out', out,
    '--require-aibridge',
    '--timeout-ms', '5000'
  ], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      AIBRIDGE_CLI: mock.cli,
      AIBRIDGE_MOCK_LOG: mock.log,
      BLUEPRINT_REQUIRE_AIBRIDGE: '0'
    })
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  var report = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(report.aibridge.ran, true);
  assert.strictEqual(report.summary.aibridgeRan, true);
  assert.strictEqual(report.aibridge.failedCommandCount, 0);
  var calls = readCalls(mock.log);
  assert.ok(calls.some(function(args) { return args[0] === 'scene' && args[1] === 'load'; }));
  assert.ok(calls.some(function(args) { return args[0] === 'scene' && args[1] === 'get_hierarchy'; }));
  assert.ok(calls.some(function(args) { return args[0] === 'inspector' && args[1] === 'get_components' && args.indexOf('GMP_MainManager') >= 0; }));
  assert.ok(calls.some(function(args) { return args[0] === 'compile' && args[1] === 'unity'; }));
  assert.ok(calls.some(function(args) { return args[0] === 'get_logs' && args.indexOf('Error') >= 0; }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

var cliUnavailableRoot = makeRoot();
try {
  var failingMock = makeFailingMockCli(cliUnavailableRoot);
  var fallbackOut = path.join(cliUnavailableRoot, 'MCP_HYDRATION_REPORT.json');
  var fallback = childProcess.spawnSync(process.execPath, [
    hydrateScript,
    cliUnavailableRoot,
    '--out', fallbackOut,
    '--timeout-ms', '5000'
  ], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      AIBRIDGE_CLI: failingMock.cli,
      AIBRIDGE_MOCK_LOG: failingMock.log,
      BLUEPRINT_REQUIRE_AIBRIDGE: '0'
    })
  });
  assert.strictEqual(fallback.status, 0, fallback.stderr || fallback.stdout);
  var fallbackReport = JSON.parse(fs.readFileSync(fallbackOut, 'utf8'));
  assert.strictEqual(fallbackReport.aibridge.ran, true);
  assert.ok(fallbackReport.aibridge.failedCommandCount > 0);
  assert.strictEqual(fallbackReport.mode, 'static-unity-yaml');
  assert.strictEqual(fallbackReport.toolLayer, 'aibridge-cli-attempted-static-fallback');
  assert.ok(fallbackReport.warnings.some(function(warning) { return warning.indexOf('static YAML hydration fallback') >= 0; }));

  var requiredOut = path.join(cliUnavailableRoot, 'MCP_HYDRATION_REQUIRED_REPORT.json');
  var required = childProcess.spawnSync(process.execPath, [
    hydrateScript,
    cliUnavailableRoot,
    '--out', requiredOut,
    '--require-aibridge',
    '--timeout-ms', '5000'
  ], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      AIBRIDGE_CLI: failingMock.cli,
      AIBRIDGE_MOCK_LOG: failingMock.log,
      BLUEPRINT_REQUIRE_AIBRIDGE: '0'
    })
  });
  assert.strictEqual(required.status, 1);
  var requiredReport = JSON.parse(fs.readFileSync(requiredOut, 'utf8'));
  assert.strictEqual(requiredReport.aibridge.required, true);
  assert.ok(requiredReport.errors.some(function(error) { return error.indexOf('AIBridgeCLI hydration commands failed') >= 0; }));
} finally {
  fs.rmSync(cliUnavailableRoot, { recursive: true, force: true });
}

var missingRoot = makeRoot();
try {
  var missingOut = path.join(missingRoot, 'MCP_HYDRATION_REPORT.json');
  var missing = childProcess.spawnSync(process.execPath, [
    hydrateScript,
    missingRoot,
    '--out', missingOut,
    '--require-aibridge'
  ], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      AIBRIDGE_CLI: '',
      BLUEPRINT_REQUIRE_AIBRIDGE: '0'
    })
  });
  assert.strictEqual(missing.status, 1);
  assert.ok(fs.existsSync(missingOut));
  var missingReport = JSON.parse(fs.readFileSync(missingOut, 'utf8'));
  assert.strictEqual(missingReport.aibridge.ran, false);
  assert.strictEqual(missingReport.aibridge.required, true);
} finally {
  fs.rmSync(missingRoot, { recursive: true, force: true });
}

console.log('programmer delivery AIBridge hydration tests passed');
