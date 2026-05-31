'use strict';
// Wave 3 Step 2 (2026-05-31) — Option C source-faithful Luna build.
// Headless-renders source.html and captures the L9 `window.meshOps` contract as JSON,
// attaching it to ctx.blueprint.sourceMeshOps for the skeleton generator (Step 3) to
// emit composite meshes matching the three.js source geometry.
//
// Position in pipeline: AFTER fidelity-contract-synthesize, BEFORE clone.
// FLAG-GATED default-off via OPTION_C_SOURCE_FAITHFUL_BUILD. When off, or when there is
// no sourceHtmlPath, or when meshOps is missing/invalid, the stage is a no-op and the
// build falls back to the existing pooled-primitive overlay path (engineered fallback,
// see incident doc §3 Step 2 / R1).
//
// Design: docs/incidents/option-c-source-faithful-luna-build-2026-05-31.md §3 Step 2.

var fs = require('fs');
var fidelitySourceDiff = require('./fidelity-source-diff.cjs');

var FIDELITY_READY_TIMEOUT_MS = 8000;
var VALID_KINDS = { box: 1, sphere: 1, cylinder: 1, cone: 1, plane: 1, torus: 1, icosahedron: 1 };
var MAX_OPS_PER_ENTITY = 32;   // sanity cap (incident doc §3 Step 2)
var MAX_STRING_FIELD = 64;

// Validate the extracted meshOps against the (optional) fidelity contract entity set.
// Returns { valid, reason, entityCount, totalOps }. Defensive: meshOps comes from
// page.evaluate JSON, so it is plain data, but the LLM that produced source.html may
// have emitted partial / malformed ops.
function validateMeshOps(meshOps, fidelityContract) {
  if (!meshOps || typeof meshOps !== 'object' || Array.isArray(meshOps)) {
    return { valid: false, reason: 'meshOps not a plain object' };
  }
  var keys = Object.keys(meshOps);
  if (keys.length === 0) return { valid: false, reason: 'meshOps empty' };

  var totalOps = 0;
  for (var i = 0; i < keys.length; i++) {
    var name = keys[i];
    if (name.length > MAX_STRING_FIELD) return { valid: false, reason: 'entity name too long: ' + name.slice(0, 32) };
    var ops = meshOps[name];
    if (!Array.isArray(ops) || ops.length === 0) return { valid: false, reason: 'entity ' + name + ' has no ops' };
    if (ops.length > MAX_OPS_PER_ENTITY) return { valid: false, reason: 'entity ' + name + ' has ' + ops.length + ' ops (> ' + MAX_OPS_PER_ENTITY + ')' };
    for (var j = 0; j < ops.length; j++) {
      var op = ops[j];
      if (!op || typeof op !== 'object') return { valid: false, reason: name + '[' + j + '] not an object' };
      if (!VALID_KINDS[op.kind]) return { valid: false, reason: name + '[' + j + '] invalid kind: ' + op.kind };
      if (!isFiniteVec(op.position, 3)) return { valid: false, reason: name + '[' + j + '] position not [x,y,z] finite' };
      if (op.rotation !== undefined && !isFiniteVec(op.rotation, 3)) return { valid: false, reason: name + '[' + j + '] bad rotation' };
      if (op.scale !== undefined && !isFiniteVec(op.scale, 3)) return { valid: false, reason: name + '[' + j + '] bad scale' };
      if (op.size !== undefined && !isFiniteVec(op.size, null)) return { valid: false, reason: name + '[' + j + '] bad size' };
      var nums = ['color', 'emissive', 'emissiveIntensity', 'metalness', 'roughness', 'opacity'];
      for (var n = 0; n < nums.length; n++) {
        if (op[nums[n]] !== undefined && !Number.isFinite(op[nums[n]])) {
          return { valid: false, reason: name + '[' + j + '] non-finite ' + nums[n] };
        }
      }
      totalOps++;
    }
  }

  // Coverage check against the fidelity contract entity set, if available. We do not
  // hard-fail on partial coverage (per-entity fallback handles missing ones), but a
  // total mismatch (0 contract entities covered) is treated as invalid.
  var entities = fidelityContract && Array.isArray(fidelityContract.entities) ? fidelityContract.entities : null;
  if (entities && entities.length) {
    var covered = 0;
    for (var e = 0; e < entities.length; e++) {
      var en = entities[e] && (entities[e].name || entities[e].id);
      if (en && Array.isArray(meshOps[en]) && meshOps[en].length) covered++;
    }
    if (covered === 0) return { valid: false, reason: 'meshOps covers 0 of ' + entities.length + ' contract entities' };
  }

  return { valid: true, entityCount: keys.length, totalOps: totalOps };
}

function isFiniteVec(v, len) {
  if (!Array.isArray(v)) return false;
  if (len !== null && v.length !== len) return false;
  if (len === null && (v.length < 1 || v.length > 3)) return false;
  for (var i = 0; i < v.length; i++) { if (!Number.isFinite(v[i])) return false; }
  return true;
}

function execute(ctx) {
  var sourceHtmlPath = ctx && ctx.sourceHtmlPath;
  // canSkip already guards the common skip cases; double-check here for direct calls.
  if (!sourceHtmlPath || !fs.existsSync(sourceHtmlPath)) {
    ctx && ctx.addLog && ctx.addLog('source-mesh-extract', 'no sourceHtmlPath — skip (fallback to overlay path)');
    return Promise.resolve({ skipped: true, reason: 'no-source-html' });
  }

  return (async function () {
    var playwright = require('/opt/blueprint-editor/node_modules/playwright');
    var browser = null;
    var server = null;
    try {
      server = await fidelitySourceDiff.serveSingleFile(sourceHtmlPath);
      browser = await playwright.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      var page = await browser.newPage();
      await page.goto(server.url, { waitUntil: 'load' });
      // L8.5 contract guarantees __fidelityReady fires after one render tick; if it
      // times out we still try to read meshOps (it is declared at top level).
      try {
        await page.waitForFunction('window.__fidelityReady === true', { timeout: FIDELITY_READY_TIMEOUT_MS });
      } catch (e) {
        ctx.addLog && ctx.addLog('source-mesh-extract', 'WARN — __fidelityReady timeout after ' + FIDELITY_READY_TIMEOUT_MS + 'ms; reading meshOps anyway');
      }
      var meshOps = await page.evaluate(function () {
        try { return JSON.parse(JSON.stringify(window.meshOps || {})); } catch (err) { return null; }
      });

      var report = validateMeshOps(meshOps, ctx.blueprint && ctx.blueprint.fidelityContract);
      if (!report.valid) {
        ctx.addLog && ctx.addLog('source-mesh-extract', 'invalid meshOps (' + report.reason + ') — falling back to overlay path');
        return { skipped: true, reason: report.reason };
      }

      ctx.blueprint = ctx.blueprint || {};
      ctx.blueprint.sourceMeshOps = meshOps;
      ctx.blueprint.sourceMeshOpsReport = {
        entityCount: report.entityCount,
        totalOps: report.totalOps,
        producerVersion: 'source-mesh-extract@0.1',
      };
      ctx.addLog && ctx.addLog('source-mesh-extract', 'extracted ' + report.entityCount + ' entities, ' + report.totalOps + ' ops');
      return { extracted: true, entityCount: report.entityCount, totalOps: report.totalOps };
    } finally {
      if (browser) { try { await browser.close(); } catch (e) {} }
      if (server && server.server) { try { server.server.close(); } catch (e) {} }
    }
  })();
}

module.exports = {
  name: 'source-mesh-extract',
  canRetry: false,
  canSkip: function (ctx) {
    if (process.env.OPTION_C_SOURCE_FAITHFUL_BUILD !== 'true') return true; // flag-gated default-off
    if (!ctx || !ctx.sourceHtmlPath) return true;                          // soft-mode upstream (no source.html)
    return false;
  },
  execute: execute,
  validateMeshOps: validateMeshOps, // exported for unit tests
};
