#!/usr/bin/env node

var assert = require('assert');
var { classify } = require('../engine/error-classifier.cjs');
var compileStage = require('../engine/stages/compile.cjs');

var tmpParentMissing = "ENOENT: no such file or directory, mkdtemp '/tmp/claude-0/luna-build-XXXXXX'";
assert.strictEqual(classify(tmpParentMissing).type, 'INFRA', 'mkdtemp parent ENOENT should classify as INFRA');
assert.strictEqual(compileStage._isBuildInfraError(tmpParentMissing), true, 'compile should route mkdtemp ENOENT as infra');

var normalCompileError = "msbuild failed: Sources/GameFlowManagerMain.cs(194,9): error CS0103: The name 'SafeSetText' does not exist in the current context [/tmp/luna-build-wpdl8e/Scripts/Scripts.csproj]";
assert.notStrictEqual(classify(normalCompileError).type, 'INFRA', 'normal CS errors with luna-build paths must not classify as INFRA');
assert.strictEqual(compileStage._isBuildInfraError(normalCompileError), false, 'compile must keep normal CS errors in the recode path');

console.log('build infra classification tests passed');
