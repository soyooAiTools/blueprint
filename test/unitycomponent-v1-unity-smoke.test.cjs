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

console.log('unitycomponent v1 unity smoke tests passed');
