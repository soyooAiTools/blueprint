#!/usr/bin/env node
/**
 * Standalone stage runner — run any pipeline stage with fixture input
 *
 * Usage:
 *   node engine/standalone.cjs --stage review --input fixtures/review/task-123.json
 *   node engine/standalone.cjs --stage compile --input fixtures/compile/case-001.json
 *   node engine/standalone.cjs --stage spec-validate --input fixtures/spec-validate/test.json
 */

var fs = require('fs');
var path = require('path');
var { PipelineContext } = require('./pipeline.cjs');

function parseArgs() {
    var args = process.argv.slice(2);
    var result = {};
    for (var i = 0; i < args.length; i++) {
        if (args[i] === '--stage' && args[i + 1]) { result.stage = args[++i]; }
        else if (args[i] === '--input' && args[i + 1]) { result.input = args[++i]; }
        else if (args[i] === '--output' && args[i + 1]) { result.output = args[++i]; }
    }
    return result;
}

function run() {
    var args = parseArgs();
    if (!args.stage || !args.input) {
        console.error('Usage: node engine/standalone.cjs --stage <name> --input <fixture.json> [--output <result.json>]');
        process.exit(1);
    }

    // Load stage
    var stagePath = path.join(__dirname, 'stages', args.stage + '.cjs');
    if (!fs.existsSync(stagePath)) {
        console.error('Stage not found: ' + stagePath);
        process.exit(1);
    }
    var stage = require(stagePath);

    // Load fixture
    var fixture;
    try {
        fixture = JSON.parse(fs.readFileSync(args.input, 'utf-8'));
    } catch(e) {
        console.error('Failed to load fixture: ' + e.message);
        process.exit(1);
    }

    // Build minimal PipelineContext from fixture
    var task = { id: fixture.taskId || 'standalone-test', blueprint_json: JSON.stringify(fixture.blueprint || {}) };
    var ctx = new PipelineContext(task, {}, fixture.workerConfig || {});
    ctx.csCode = fixture.csCode || null;
    ctx.htmlOutput = fixture.htmlOutput || null;
    ctx.extraFiles = fixture.extraFiles || {};
    ctx.workDir = fixture.workDir || null;

    // Override reportStatus to no-op in standalone mode
    ctx.reportStatus = function() { return Promise.resolve(); };

    console.log('[standalone] Running stage: ' + stage.name);
    console.log('[standalone] Input fixture: ' + args.input);

    // Run assertBefore
    if (stage.assertBefore) {
        try {
            stage.assertBefore(ctx);
        } catch(e) {
            console.error('[standalone] assertBefore failed: ' + e.message);
            process.exit(2);
        }
    }

    // Execute stage
    var startTime = Date.now();
    Promise.resolve().then(function() {
        return stage.execute(ctx);
    }).then(function(result) {
        var elapsed = Date.now() - startTime;
        console.log('[standalone] Stage completed in ' + elapsed + 'ms');
        console.log('[standalone] Result:', JSON.stringify(result, null, 2));

        if (args.output) {
            var output = {
                stage: stage.name,
                elapsed: elapsed,
                result: result,
                csCode: ctx.csCode,
                log: ctx.log,
            };
            fs.writeFileSync(args.output, JSON.stringify(output, null, 2));
            console.log('[standalone] Output saved to: ' + args.output);
        }

        process.exit(0);
    }).catch(function(err) {
        var elapsed = Date.now() - startTime;
        console.error('[standalone] Stage failed after ' + elapsed + 'ms: ' + err.message);
        process.exit(1);
    });
}

run();
