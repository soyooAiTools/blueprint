#!/usr/bin/env node
/**
 * Stage regression test runner
 *
 * Runs stages against fixture files that have expectedResult.
 * Usage:
 *   node test/stage-regression.cjs                    # run all
 *   node test/stage-regression.cjs --stage review     # run one stage
 *   node test/stage-regression.cjs --stage static-check  # run static-check tests
 */

var fs = require('fs');
var path = require('path');
var assert = require('assert');

var fixturesDir = path.join(__dirname, '..', 'fixtures');

function parseArgs() {
    var args = process.argv.slice(2);
    var result = {};
    for (var i = 0; i < args.length; i++) {
        if (args[i] === '--stage' && args[i + 1]) result.stage = args[++i];
    }
    return result;
}

function runStaticCheckTests() {
    var staticCheck;
    try { staticCheck = require('../engine/static-check.cjs').staticCheck; } catch(e) {
        console.error('  Cannot load static-check.cjs: ' + e.message);
        return { passed: 0, failed: 0, errors: 1 };
    }

    var testDir = path.join(fixturesDir, 'static-check');
    if (!fs.existsSync(testDir)) {
        console.log('  No fixtures found at ' + testDir);
        return { passed: 0, failed: 0, errors: 0 };
    }

    var files = fs.readdirSync(testDir).filter(function(f) { return f.endsWith('.json'); });
    var passed = 0, failed = 0;

    for (var fi = 0; fi < files.length; fi++) {
        var fixture = JSON.parse(fs.readFileSync(path.join(testDir, files[fi]), 'utf-8'));
        var result = staticCheck(fixture.csCode);

        if (fixture.expectedResult) {
            try {
                if (fixture.expectedResult.passed !== undefined) {
                    assert.strictEqual(result.passed, fixture.expectedResult.passed, 'passed mismatch');
                }
                if (fixture.expectedResult.issueRules) {
                    var actualRules = result.issues.map(function(i) { return i.rule; }).sort();
                    var expectedRules = fixture.expectedResult.issueRules.slice().sort();
                    assert.deepStrictEqual(actualRules, expectedRules, 'issue rules mismatch');
                }
                if (fixture.expectedResult.minIssues !== undefined) {
                    assert.ok(result.issues.length >= fixture.expectedResult.minIssues,
                        'Expected >= ' + fixture.expectedResult.minIssues + ' issues, got ' + result.issues.length);
                }
                console.log('  PASS: ' + files[fi]);
                passed++;
            } catch(e) {
                console.log('  FAIL: ' + files[fi] + ' — ' + e.message);
                failed++;
            }
        } else {
            console.log('  SKIP: ' + files[fi] + ' (no expectedResult)');
        }
    }

    return { passed: passed, failed: failed, errors: 0 };
}

function runComplexityGateTests() {
    var cg;
    try { cg = require('../engine/stages/complexity-gate.cjs'); } catch(e) {
        console.error('  Cannot load complexity-gate.cjs: ' + e.message);
        return { passed: 0, failed: 0, errors: 1 };
    }

    var testDir = path.join(fixturesDir, 'complexity-gate');
    if (!fs.existsSync(testDir)) {
        console.log('  No fixtures found at ' + testDir);
        return { passed: 0, failed: 0, errors: 0 };
    }

    var files = fs.readdirSync(testDir).filter(function(f) { return f.endsWith('.json'); });
    var passed = 0, failed = 0;

    for (var fi = 0; fi < files.length; fi++) {
        var fixture = JSON.parse(fs.readFileSync(path.join(testDir, files[fi]), 'utf-8'));
        if (!fixture.expectedResult) {
            console.log('  SKIP: ' + files[fi] + ' (no expectedResult)');
            continue;
        }

        try {
            var result = cg.computeScore(fixture.input.specs, fixture.input.entities);
            if (fixture.expectedResult.scoreMustExceed !== undefined) {
                assert.ok(result.total > fixture.expectedResult.scoreMustExceed,
                    'Expected total ' + result.total + ' > ' + fixture.expectedResult.scoreMustExceed);
            }
            if (fixture.expectedResult.scoreMustNotExceed !== undefined) {
                assert.ok(result.total <= fixture.expectedResult.scoreMustNotExceed,
                    'Expected total ' + result.total + ' <= ' + fixture.expectedResult.scoreMustNotExceed);
            }
            console.log('  PASS: ' + files[fi] + ' (score=' + result.total + ')');
            passed++;
        } catch(e) {
            console.log('  FAIL: ' + files[fi] + ' — ' + e.message);
            failed++;
        }
    }

    return { passed: passed, failed: failed, errors: 0 };
}

function runMethodCheckTests() {
    var mc;
    try { mc = require('../engine/stages/method-check.cjs'); } catch(e) {
        console.error('  Cannot load method-check.cjs: ' + e.message);
        return { passed: 0, failed: 0, errors: 1 };
    }

    var testDir = path.join(fixturesDir, 'method-check');
    if (!fs.existsSync(testDir)) {
        console.log('  No fixtures found at ' + testDir);
        return { passed: 0, failed: 0, errors: 0 };
    }

    var files = fs.readdirSync(testDir).filter(function(f) { return f.endsWith('.json'); });
    var passed = 0, failed = 0;

    for (var fi = 0; fi < files.length; fi++) {
        var fixture = JSON.parse(fs.readFileSync(path.join(testDir, files[fi]), 'utf-8'));
        if (!fixture.expectedResult) {
            console.log('  SKIP: ' + files[fi] + ' (no expectedResult)');
            continue;
        }

        try {
            var missing = mc.checkCompleteness(fixture.input.csCode);
            var expectedMissing = fixture.expectedResult.missing;
            assert.strictEqual(missing.length, expectedMissing.length,
                'missing length mismatch: got [' + missing.join(', ') + '] expected [' + expectedMissing.join(', ') + ']');
            for (var mi = 0; mi < expectedMissing.length; mi++) {
                assert.ok(missing.indexOf(expectedMissing[mi]) >= 0,
                    'Expected "' + expectedMissing[mi] + '" in missing list, got: [' + missing.join(', ') + ']');
            }
            console.log('  PASS: ' + files[fi] + ' (missing=' + JSON.stringify(missing) + ')');
            passed++;
        } catch(e) {
            console.log('  FAIL: ' + files[fi] + ' — ' + e.message);
            failed++;
        }
    }

    return { passed: passed, failed: failed, errors: 0 };
}

function runStageTests(stageName) {
    if (stageName === 'static-check') return runStaticCheckTests();
    if (stageName === 'complexity-gate') return runComplexityGateTests();
    if (stageName === 'method-check') return runMethodCheckTests();

    var stage;
    try { stage = require('../engine/stages/' + stageName + '.cjs'); } catch(e) {
        console.error('  Cannot load stage ' + stageName + ': ' + e.message);
        return { passed: 0, failed: 0, errors: 1 };
    }

    var testDir = path.join(fixturesDir, stageName);
    if (!fs.existsSync(testDir)) {
        console.log('  No fixtures found at ' + testDir);
        return { passed: 0, failed: 0, errors: 0 };
    }

    var files = fs.readdirSync(testDir).filter(function(f) { return f.endsWith('.json'); });
    var passed = 0, failed = 0;

    // For stages, we mainly test assertBefore (synchronous, no API calls needed)
    for (var fi = 0; fi < files.length; fi++) {
        var fixture = JSON.parse(fs.readFileSync(path.join(testDir, files[fi]), 'utf-8'));
        if (!fixture.testAssertBefore) continue;

        var { PipelineContext } = require('../engine/pipeline.cjs');
        var task = { id: fixture.taskId || 'test', blueprint_json: JSON.stringify(fixture.blueprint || {}) };
        var ctx = new PipelineContext(task, {}, {});
        ctx.csCode = fixture.csCode || null;
        ctx.htmlOutput = fixture.htmlOutput || null;
        ctx.extraFiles = fixture.extraFiles || {};

        try {
            if (stage.assertBefore) stage.assertBefore(ctx);
            if (fixture.expectedResult && fixture.expectedResult.assertBeforeFails) {
                console.log('  FAIL: ' + files[fi] + ' — expected assertBefore to throw but it passed');
                failed++;
            } else {
                console.log('  PASS: ' + files[fi]);
                passed++;
            }
        } catch(e) {
            if (fixture.expectedResult && fixture.expectedResult.assertBeforeFails) {
                console.log('  PASS: ' + files[fi] + ' (assertBefore correctly threw: ' + e.message.slice(0, 60) + ')');
                passed++;
            } else {
                console.log('  FAIL: ' + files[fi] + ' — unexpected assertBefore error: ' + e.message);
                failed++;
            }
        }
    }

    return { passed: passed, failed: failed, errors: 0 };
}

// Main
var args = parseArgs();
var totalPassed = 0, totalFailed = 0, totalErrors = 0;

if (args.stage) {
    console.log('Running tests for stage: ' + args.stage);
    var r = runStageTests(args.stage);
    totalPassed += r.passed; totalFailed += r.failed; totalErrors += r.errors;
} else {
    // Run all stages that have fixtures
    var stages = ['static-check', 'complexity-gate', 'method-check', 'spec-validate', 'review', 'compile', 'visual-check', 'cua-verify'];
    for (var si = 0; si < stages.length; si++) {
        var stName = stages[si];
        var stDir = path.join(fixturesDir, stName);
        if (fs.existsSync(stDir)) {
            console.log('\n=== ' + stName + ' ===');
            var r = runStageTests(stName);
            totalPassed += r.passed; totalFailed += r.failed; totalErrors += r.errors;
        }
    }
}

console.log('\n--- Results ---');
console.log('Passed: ' + totalPassed + ', Failed: ' + totalFailed + ', Errors: ' + totalErrors);
process.exit(totalFailed + totalErrors > 0 ? 1 : 0);
