#!/usr/bin/env node
/**
 * 2026-05-31 Wave 3 Step 2 — source-mesh-extract stage.
 *
 * Covers the fast, deterministic surface: validateMeshOps (the core validation that
 * decides whether Option C engages or falls back), canSkip flag-gating, and the
 * no-source-html fast path of execute(). The playwright happy-path (render source.html
 * → read window.meshOps) is exercised by a separate manual integration check, not in
 * the always-run suite (chromium launch is slow/heavy for CI).
 */

var assert = require('assert');
var stage = require('../engine/stages/source-mesh-extract.cjs');
var validate = stage.validateMeshOps;

// ---- validateMeshOps: valid shapes ----
(function validShapes() {
  assert.strictEqual(validate({ Player: [{ kind: 'box', position: [0, 0, 0] }] }).valid, true, 'minimal valid op');
  var full = validate({
    Drill: [{
      kind: 'cylinder', position: [0, 0.2, 0], rotation: [90, 0, 0], scale: [1, 1, 1],
      size: [0.9, 1.1, 0.4], color: 0x888888, emissive: 0x111111, emissiveIntensity: 0.3,
      metalness: 0.7, roughness: 0.3, opacity: 1,
    }],
  });
  assert.strictEqual(full.valid, true, 'all optional fields finite → valid');
  assert.strictEqual(full.entityCount, 1);
  assert.strictEqual(full.totalOps, 1);
  // size variable length (sphere → [r]) is allowed
  assert.strictEqual(validate({ Ball: [{ kind: 'sphere', position: [0, 0, 0], size: [0.5] }] }).valid, true, 'sphere size [r]');
  console.log('  ✓ validateMeshOps: valid shapes accepted');
})();

// ---- validateMeshOps: invalid shapes ----
(function invalidShapes() {
  assert.strictEqual(validate({}).valid, false, 'empty object');
  assert.strictEqual(validate(null).valid, false, 'null');
  assert.strictEqual(validate([]).valid, false, 'array');
  assert.strictEqual(validate({ A: [] }).valid, false, 'entity with no ops');
  assert.strictEqual(validate({ A: 'nope' }).valid, false, 'non-array ops');
  assert.strictEqual(validate({ A: [{ kind: 'pyramid', position: [0, 0, 0] }] }).valid, false, 'invalid kind');
  assert.strictEqual(validate({ A: [{ kind: 'box', position: [0, NaN, 0] }] }).valid, false, 'non-finite position');
  assert.strictEqual(validate({ A: [{ kind: 'box', position: [0, 0] }] }).valid, false, 'position wrong length');
  assert.strictEqual(validate({ A: [{ kind: 'box', position: [0, 0, 0], color: 'red' }] }).valid, false, 'non-finite color');
  var many = []; for (var i = 0; i < 33; i++) many.push({ kind: 'box', position: [0, 0, 0] });
  assert.strictEqual(validate({ A: many }).valid, false, 'too many ops (>32)');
  console.log('  ✓ validateMeshOps: malformed shapes rejected');
})();

// ---- validateMeshOps: contract coverage ----
(function coverage() {
  var contract = { entities: [{ name: 'Foo' }, { name: 'Bar' }] };
  // 0 covered → invalid
  assert.strictEqual(validate({ Baz: [{ kind: 'box', position: [0, 0, 0] }] }, contract).valid, false, '0 coverage → invalid');
  // partial coverage → still valid (per-entity fallback handles the rest)
  assert.strictEqual(validate({ Foo: [{ kind: 'box', position: [0, 0, 0] }] }, contract).valid, true, 'partial coverage → valid');
  console.log('  ✓ validateMeshOps: contract coverage (0 → invalid, partial → valid)');
})();

// ---- canSkip flag gate ----
(function canSkipGate() {
  delete process.env.OPTION_C_SOURCE_FAITHFUL_BUILD;
  assert.strictEqual(stage.canSkip({ sourceHtmlPath: '/x' }), true, 'flag off → skip');
  process.env.OPTION_C_SOURCE_FAITHFUL_BUILD = 'true';
  assert.strictEqual(stage.canSkip({}), true, 'flag on but no sourceHtmlPath → skip');
  assert.strictEqual(stage.canSkip({ sourceHtmlPath: '/x' }), false, 'flag on + sourceHtmlPath → run');
  delete process.env.OPTION_C_SOURCE_FAITHFUL_BUILD;
  console.log('  ✓ canSkip: flag-gated default-off');
})();

// ---- execute: no source html → fast skip (no playwright) ----
(async function executeNoHtml() {
  var logs = [];
  var ctx = { sourceHtmlPath: '/nonexistent/source.html', addLog: function (s, m) { logs.push(s + ': ' + m); } };
  var res = await stage.execute(ctx);
  assert.ok(res && res.skipped, 'no html → skipped result');
  assert.strictEqual(res.reason, 'no-source-html');
  console.log('  ✓ execute: missing source.html skips fast (overlay fallback)');
})().then(function () {
  console.log('\nsource-mesh-extract: all fast cases passed');
}).catch(function (err) {
  console.error('FAIL:', err && err.message);
  process.exit(1);
});
