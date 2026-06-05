#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var failures = [];

function abs(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8');
}

function activeLines(rel) {
  var text = read(rel);
  var isEnv = rel === '.env' || rel.endsWith('/.env');
  var inBlock = false;
  return text.split(/\r?\n/).map(function(line, idx) {
    var active = line;
    if (isEnv) {
      active = /^\s*#/.test(active) ? '' : active;
    } else {
      if (inBlock) {
        var end = active.indexOf('*/');
        if (end < 0) active = '';
        else {
          active = active.slice(end + 2);
          inBlock = false;
        }
      }
      var start = active.indexOf('/*');
      while (start >= 0) {
        var close = active.indexOf('*/', start + 2);
        if (close < 0) {
          active = active.slice(0, start);
          inBlock = true;
          break;
        }
        active = active.slice(0, start) + active.slice(close + 2);
        start = active.indexOf('/*');
      }
      var slash = active.indexOf('//');
      if (slash >= 0) active = active.slice(0, slash);
    }
    return { number: idx + 1, text: active };
  });
}

function fail(rel, line, message) {
  failures.push(rel + (line ? ':' + line : '') + ' ' + message);
}

function assertActiveMatch(rel, pattern, message) {
  var lines = activeLines(rel);
  for (var i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i].text)) return;
  }
  fail(rel, 0, message);
}

function assertNoActiveMatch(rel, pattern, message) {
  var lines = activeLines(rel);
  for (var i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i].text)) {
      fail(rel, lines[i].number, message + ' :: ' + lines[i].text.trim());
    }
  }
}

function assertNoRuntimeClaudeCallsites() {
  var migratedCallsites = [
    'engine/stages/codegen-schema.cjs',
    'engine/recode.cjs',
    'engine/auto-fix.cjs',
    'engine/stages/visual-check.cjs',
    'api/storyboard.cjs',
    'scripts/storyboard2html-generate.cjs',
    'engine/storyboard2html-prompt.cjs',
  ];

  migratedCallsites.forEach(function(rel) {
    assertNoActiveMatch(rel, /\bbackend\s*:\s*['"]claude-print['"]/, 'active callsite routes to claude-print');
    assertNoActiveMatch(rel, /\bmodel\s*:\s*['"]claude-[^'"]+['"]/, 'active callsite uses Claude model');
    assertNoActiveMatch(rel, /\bcreateProvider\s*\(\s*['"]claude['"]/, 'active callsite creates Claude provider');
  });

  assertNoActiveMatch('engine/stages/visual-check.cjs', /\brunCodexText\b/, 'visual-check must use Doubao vision API directly');
  assertNoActiveMatch('engine/stages/visual-check.cjs', /Vision CLI/, 'visual-check still refers to CLI vision transport');
  assertNoActiveMatch('python/blueprint_converter.py', /anthropic|api\.anthropic\.com|\/v1\/messages|x-api-key/i, 'Python converter still contains Anthropic API path');
}

function assertConfig() {
  var configFiles = [
    '.env',
    'worker/.env',
    'ecosystem.config.cjs',
    'worker/ecosystem.linux.config.cjs',
  ];
  configFiles.forEach(function(rel) {
    assertActiveMatch(rel, /\bBLUEPRINT_DISABLE_CLAUDE\b\s*[:=]\s*['"]?1['"]?/, 'must set BLUEPRINT_DISABLE_CLAUDE=1');
    assertNoActiveMatch(rel, /\bBLUEPRINT_ENABLE_CLAUDE\b\s*[:=]\s*['"]?1['"]?/, 'must not enable Claude runtime');
    assertNoActiveMatch(rel, /\bBLUEPRINT_ENABLE_CLAUDE_FALLBACK\b\s*[:=]\s*['"]?1['"]?/, 'must not enable Claude fallback');
    assertNoActiveMatch(rel, /\bSCHEMA_PRIMARY_BACKEND\b\s*[:=]\s*['"]?claude-print['"]?/, 'must not force schema primary to claude-print');
  });
}

async function assertRuntimeGuards() {
  var savedDisable = process.env.BLUEPRINT_DISABLE_CLAUDE;
  var savedEnable = process.env.BLUEPRINT_ENABLE_CLAUDE;
  delete process.env.BLUEPRINT_DISABLE_CLAUDE;
  delete process.env.BLUEPRINT_ENABLE_CLAUDE;
  try {
    var modelProvider = require('../lib/model-provider.cjs');
    if (!modelProvider.isClaudeDisabled || !modelProvider.isClaudeDisabled()) {
      fail('lib/model-provider.cjs', 0, 'Claude provider must be disabled by default');
    }
    try {
      modelProvider.createProvider('claude');
      fail('lib/model-provider.cjs', 0, 'createProvider("claude") should throw when Claude is not explicitly enabled');
    } catch (_) {}
    try {
      await new modelProvider.ClaudeProvider({}).generate('test', { timeoutMs: 1 });
      fail('lib/model-provider.cjs', 0, 'direct ClaudeProvider.generate() should reject when Claude is not explicitly enabled');
    } catch (err) {
      if (!/Claude provider disabled/i.test(String(err && err.message || ''))) {
        fail('lib/model-provider.cjs', 0, 'direct ClaudeProvider.generate() rejected for unexpected reason: ' + String(err && err.message || err));
      }
    }
    try {
      await new modelProvider.ClaudeProvider({}).generateVision('', 'test', { timeoutMs: 1 });
      fail('lib/model-provider.cjs', 0, 'direct ClaudeProvider.generateVision() should reject when Claude is not explicitly enabled');
    } catch (err) {
      if (!/Claude vision provider disabled/i.test(String(err && err.message || ''))) {
        fail('lib/model-provider.cjs', 0, 'direct ClaudeProvider.generateVision() rejected for unexpected reason: ' + String(err && err.message || err));
      }
    }

    var coder = require('../worker/codex-code-coder.js');
    if (!coder._internals || !coder._internals.isClaudeDisabled || !coder._internals.isClaudeDisabled()) {
      fail('worker/codex-code-coder.js', 0, 'Claude code/text backend must be disabled by default');
    }
    var textResult = await coder.runCodexText({
      systemPrompt: 'test',
      userPrompt: 'test',
      backend: 'claude-print',
      taskId: 'assert-no-claude-runtime',
      log: function() {},
    });
    if (!textResult || textResult.ok || !/Claude text backend disabled/i.test(String(textResult.error || ''))) {
      fail('worker/codex-code-coder.js', 0, 'runCodexText({backend:"claude-print"}) must fail before spawning Claude');
    }

    var workerCoder = require('../worker/worker-coder.js');
    try {
      await workerCoder.callClaude('test', 'test', 1);
      fail('worker/worker-coder.js', 0, 'legacy callClaude should reject when Claude is not explicitly enabled');
    } catch (err) {
      if (!/Claude backend disabled/i.test(String(err && err.message || ''))) {
        fail('worker/worker-coder.js', 0, 'legacy callClaude rejected for unexpected reason: ' + String(err && err.message || err));
      }
    }
  } finally {
    if (savedDisable === undefined) delete process.env.BLUEPRINT_DISABLE_CLAUDE;
    else process.env.BLUEPRINT_DISABLE_CLAUDE = savedDisable;
    if (savedEnable === undefined) delete process.env.BLUEPRINT_ENABLE_CLAUDE;
    else process.env.BLUEPRINT_ENABLE_CLAUDE = savedEnable;
  }
}

async function main() {
  assertConfig();
  assertNoRuntimeClaudeCallsites();
  await assertRuntimeGuards();

  if (failures.length > 0) {
    console.error('Claude runtime assertion failed:');
    failures.forEach(function(item) { console.error(' - ' + item); });
    process.exit(1);
  }
  console.log('OK: Blueprint Claude runtime routes are disabled; active callsites use Codex/Doubao.');
}

main().catch(function(err) {
  console.error('assert-no-claude-runtime failed:', err && err.stack || err);
  process.exit(1);
});
