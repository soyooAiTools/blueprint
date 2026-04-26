#!/usr/bin/env node
'use strict';

// Unified test runner. Discovers test/*.test.cjs and:
//   - runs jest-BDD style files with the shim in test/jest-shim.cjs
//   - runs plain assert-based files via direct require
//   - finally runs the legacy fixture-based stage-regression driver
//
// Replaces the prior `npm test` (which only ran stage-regression and
// silently ignored 78 *.test.cjs files).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const testDir = __dirname;
const shim = require('./jest-shim.cjs');

function discover() {
  return fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.cjs'))
    .sort();
}

function isJestStyle(file) {
  // Cheap text sniff — avoids loading the file.
  const src = fs.readFileSync(path.join(testDir, file), 'utf8');
  return /^\s*(describe|test|it)\s*\(/m.test(src);
}

function runJestStyleFile(file) {
  shim.reset();
  shim.install();
  const fp = path.join(testDir, file);
  // Fresh require — clear cache so per-file describe() registrations are
  // independent and module-level top-level code re-runs cleanly.
  delete require.cache[fp];
  const t0 = Date.now();
  let loadErr = null;
  try { require(fp); } catch (e) { loadErr = e; }
  if (loadErr) {
    return { file, kind: 'jest', pass: 0, fail: 1, ms: Date.now() - t0, failures: [{ suite: ['<load>'], name: file, message: loadErr.message, stack: loadErr.stack }] };
  }
  const res = shim.runCollected();
  return { file, kind: 'jest', pass: res.pass, fail: res.fail, ms: Date.now() - t0, failures: res.failures };
}

function runPlainFile(file) {
  // Run in a child to keep require state and process exits isolated.
  const fp = path.join(testDir, file);
  const t0 = Date.now();
  const r = spawnSync('node', [fp], { encoding: 'utf8', timeout: 60000, cwd: repoRoot });
  const ms = Date.now() - t0;
  if (r.status === 0) return { file, kind: 'plain', pass: 1, fail: 0, ms, failures: [] };
  const tail = ((r.stderr || '') + (r.stdout || '')).split('\n').slice(-15).join('\n');
  return { file, kind: 'plain', pass: 0, fail: 1, ms, failures: [{ suite: ['<exit>'], name: file, message: 'exit ' + r.status, stack: tail }] };
}

function runStageRegression() {
  const t0 = Date.now();
  const r = spawnSync('node', [path.join(testDir, 'stage-regression.cjs')], { encoding: 'utf8', timeout: 120000, cwd: repoRoot });
  const ms = Date.now() - t0;
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  return { file: 'stage-regression.cjs', kind: 'stage', pass: r.status === 0 ? 1 : 0, fail: r.status === 0 ? 0 : 1, ms, failures: r.status === 0 ? [] : [{ suite: ['<stage>'], name: 'stage-regression', message: 'exit ' + r.status, stack: '' }] };
}

const onlyArg = process.argv.indexOf('--only');
const filter = onlyArg >= 0 ? process.argv[onlyArg + 1] : null;

const files = discover().filter(f => !filter || f.includes(filter));
const results = [];
const startAll = Date.now();

for (const f of files) {
  const result = isJestStyle(f) ? runJestStyleFile(f) : runPlainFile(f);
  results.push(result);
  const tag = result.fail ? 'FAIL' : 'PASS';
  process.stdout.write(`${tag}  ${f.padEnd(56)} ${result.kind.padEnd(5)} pass=${result.pass} fail=${result.fail} (${result.ms}ms)\n`);
}

if (!filter) {
  console.log('\n=== stage-regression ===');
  results.push(runStageRegression());
}

const totalPass = results.reduce((s, r) => s + r.pass, 0);
const totalFail = results.reduce((s, r) => s + r.fail, 0);
const elapsed = Date.now() - startAll;

console.log('\n--- Summary ---');
console.log(`pass=${totalPass} fail=${totalFail} files=${results.length} elapsed=${elapsed}ms`);

const failed = results.filter(r => r.fail);
if (failed.length) {
  console.log('\n--- Failures ---');
  for (const r of failed) {
    console.log(`\n### ${r.file} (${r.kind})`);
    for (const f of r.failures) {
      const suite = f.suite && f.suite.length ? f.suite.join(' › ') + ' › ' : '';
      console.log(`  - ${suite}${f.name}: ${f.message}`);
      if (f.stack && process.env.TEST_VERBOSE) console.log(f.stack.split('\n').slice(0, 6).map(l => '      ' + l).join('\n'));
    }
  }
}

process.exit(totalFail > 0 ? 1 : 0);
