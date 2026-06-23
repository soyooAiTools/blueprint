#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var smoke = require('../scripts/unitycomponent-v1-unity-smoke.cjs');

var root = fs.mkdtempSync(path.join(os.tmpdir(), 'unitycomponent-v1-unity-smoke-test-'));
fs.mkdirSync(path.join(root, 'Assets'), { recursive: true });
fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });

var parsed = smoke.parseArgs([root, '--out', path.join(root, 'parsed.json'), '--log', path.join(root, 'unity.log')]);
assert.strictEqual(parsed.projectPath, root);
assert.strictEqual(parsed.log, path.join(root, 'unity.log'));

var reportPath = path.join(root, 'smoke.json');
var result = smoke.runSmoke({
  projectPath: root,
  unity: path.join(root, 'missing-unity'),
  required: false,
  out: reportPath
});
assert.strictEqual(result.status, 'skipped');
assert.ok(fs.existsSync(reportPath), 'skip report should be written');

assert.throws(function() {
  smoke.runSmoke({
    projectPath: root,
    unity: path.join(root, 'missing-unity'),
    required: true,
    out: path.join(root, 'required.json')
  });
}, /Unity executable not found/);

function writeFakeUnity(file, body) {
  fs.writeFileSync(file, '#!/bin/sh\nset -eu\n' + body);
  fs.chmodSync(file, 0o755);
}

var fakeUnityPass = path.join(root, 'fake-unity-pass.sh');
writeFakeUnity(fakeUnityPass, [
  'log=""',
  'project=""',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    -logFile) log="$2"; shift 2 ;;',
  '    -projectPath) project="$2"; shift 2 ;;',
  '    *) shift ;;',
  '  esac',
  'done',
  'cat > "$log" <<EOF',
  'BatchMode: 1',
  'COMMAND LINE ARGUMENTS:',
  'Unity',
  '-batchmode',
  '-quit',
  '-nographics',
  '-projectPath',
  '$project',
  'CompileScripts: 123.000ms',
  'EOF',
  'exit 0'
].join('\n'));

var passReport = smoke.runSmoke({
  projectPath: root,
  unity: fakeUnityPass,
  required: true,
  out: path.join(root, 'fake-pass.json'),
  log: path.join(root, 'fake-pass.log')
});
assert.strictEqual(passReport.status, 'passed');
assert.strictEqual(passReport.logAudit.passed, true);
assert.strictEqual(passReport.logAudit.projectPathReferenced, true);

var fakeUnityStale = path.join(root, 'fake-unity-stale.sh');
writeFakeUnity(fakeUnityStale, [
  'log=""',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    -logFile) log="$2"; shift 2 ;;',
  '    *) shift ;;',
  '  esac',
  'done',
  'cat > "$log" <<EOF',
  'BatchMode: 0',
  'COMMAND LINE ARGUMENTS:',
  'Unity.exe -openfile D:\\\\old-project\\\\Assets\\\\Scenes\\\\Game.unity',
  'CompileScripts: 99.000ms',
  'EOF',
  'exit 0'
].join('\n'));

var staleReportPath = path.join(root, 'fake-stale.json');
assert.throws(function() {
  smoke.runSmoke({
    projectPath: root,
    unity: fakeUnityStale,
    required: true,
    out: staleReportPath,
    log: path.join(root, 'fake-stale.log')
  });
}, /Unity batchmode import\/compile smoke failed/);
var staleReport = JSON.parse(fs.readFileSync(staleReportPath, 'utf8'));
assert.strictEqual(staleReport.status, 'failed');
assert.ok(staleReport.logAudit.errors.indexOf('unity-log-not-batchmode') >= 0);
assert.ok(staleReport.logAudit.errors.indexOf('unity-log-openfile-mode') >= 0);
assert.ok(staleReport.logAudit.errors.indexOf('unity-log-project-path-mismatch') >= 0);

console.log('unitycomponent v1 unity smoke tests passed');
