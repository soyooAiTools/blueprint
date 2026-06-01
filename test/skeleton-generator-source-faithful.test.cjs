#!/usr/bin/env node
/**
 * 2026-05-31 Wave 3 Step 3 — source-faithful composite mesh emission (Option C).
 *
 * When OPTION_C_SOURCE_FAITHFUL_BUILD=true and opts.sourceMeshOps is present,
 * generateSkeleton emits BuildSourceFaithfulMeshes() + per-entity BuildEntity_<name>()
 * that re-bind each entity from its pooled primitive to a composite of GFM_Create
 * primitives matching the three.js source geometry. When the flag is off (or no
 * sourceMeshOps), NOTHING is emitted (byte-identical to today). The new Vector3 calls
 * live at Start()/scene-init, so they must NOT trip the update-new-vector-in-hot-path
 * rule (incident doc R4).
 */

var assert = require('assert');
var { generateSkeleton } = require('../adapters/skeleton-generator.cjs');
var { staticCheck } = require('../engine/static-check.cjs');

function joinAll(out) {
  if (typeof out === 'string') return out;
  if (out && out.files && typeof out.files === 'object') return Object.keys(out.files).map(function (k) { return out.files[k]; }).join('\n');
  if (out && typeof out === 'object') return Object.keys(out).map(function (k) { return out[k]; }).filter(function (v) { return typeof v === 'string'; }).join('\n');
  return String(out);
}

var SPECS = [{
  phaseId: 'collect', phaseName: 'Collect',
  entitiesRequired: [{ name: 'Player' }, { name: 'DrillStation' }],
  requiredInteractions: [{ verb: 'collect', target: 'DrillStation' }],
  triggerNext: { condition: 'true' }, duration: { min: 1, max: 2 },
  playerMustAct: true, playerInstruction: 'go',
}];

var SOURCE_MESH_OPS = {
  Player: [
    { kind: 'cylinder', position: [0, 0.6, 0], size: [0.3, 0.3, 1.2], color: 0x66ccff },
    { kind: 'sphere', position: [0, 1.4, 0], size: [0.35], color: 0xffe0bd },
    { kind: 'icosahedron', position: [0, 2.0, 0], size: [0.2], color: 0x88ff88 },
  ],
  DrillStation: [
    { kind: 'box', position: [0, 0.2, 0], size: [0.9, 0.4, 0.9], color: 0x888888, metalness: 0.7, roughness: 0.3 },
    { kind: 'cone', position: [0, 1.95, 0], size: [0.28, 0, 0.9], color: 0xffdd22, emissive: 0x886600, emissiveIntensity: 0.3 },
    { kind: 'torus', position: [0, 0.06, 0], rotation: [90, 0, 0], size: [0.9, 0.09], color: 0x6666cc, metalness: 0.8 },
  ],
};

function gen(withFlag, withOps) {
  if (withFlag) process.env.OPTION_C_SOURCE_FAITHFUL_BUILD = 'true';
  else delete process.env.OPTION_C_SOURCE_FAITHFUL_BUILD;
  var opts = {
    entityPoolMap: { Player: '__Pool_Player', DrillStation: '__Pool_Drill' },
    entities: [{ name: 'Player' }, { name: 'DrillStation' }],
    w1bSplit: false,
  };
  if (withOps) opts.sourceMeshOps = SOURCE_MESH_OPS;
  var out = joinAll(generateSkeleton(SPECS, opts));
  delete process.env.OPTION_C_SOURCE_FAITHFUL_BUILD;
  return out;
}

// 1. Flag ON + sourceMeshOps → methods emitted + wired into Start
(function emitsWhenActive() {
  var code = gen(true, true);
  assert.match(code, /void BuildSourceFaithfulMeshes\(\)/, 'emits BuildSourceFaithfulMeshes');
  assert.match(code, /BuildSourceFaithfulMeshes\(\);/, 'calls it from Start');
  assert.match(code, /void BuildEntity_Player\(\)/, 'emits BuildEntity_Player');
  assert.match(code, /void BuildEntity_DrillStation\(\)/, 'emits BuildEntity_DrillStation');
  // composite root is named after the ENTITY (pool-name collision breaks rendering) and
  // re-registered; the old object is moved off-screen (NOT SetActive(false), which drops the
  // composite from the render set) and its TAG is preserved (so GFM_Player finds the player by tag).
  assert.match(code, /GameSceneCtrl\.instance\.Register\("Player", "Player"\)/, 're-binds Player by entity name');
  assert.match(code, /GameObject __root = new GameObject\("DrillStation"\)/, 'composite root named after the entity');
  assert.match(code, /__root\.tag = __tag/, 'preserves existing object tag (player lookup by tag=Player)');
  assert.match(code, /__existing\.transform\.position = new Vector3\(0f, -9999f, 0f\)/, 'old object moved off-screen, not SetActive(false)');
  assert.doesNotMatch(code, /SetActive\(false\)/, 'must NOT SetActive(false) (drops composite from render set)');
  // copies position from existing pooled primitive
  assert.match(code, /Vector3 __pos = __existing != null \? __existing\.transform\.position : Vector3\.zero/, 'copies pooled position');
  console.log('  ✓ flag on + meshOps: methods emitted + wired into Start');
})();

// 2. Kind → primitive mappings (cone→Cylinder, icosahedron→Sphere, torus→AddTorusRing)
(function kindMappings() {
  var code = gen(true, true);
  assert.match(code, /GFM_Create\.AddCompositePart\(__root, PrimitiveType\.Sphere/, 'sphere → Sphere');
  assert.match(code, /GFM_Create\.AddCompositePart\(__root, PrimitiveType\.Cube/, 'box → Cube');
  assert.match(code, /GFM_Create\.AddCompositePart\(__root, PrimitiveType\.Cylinder/, 'cylinder/cone → Cylinder');
  assert.match(code, /GFM_Create\.AddTorusRing\(__root,/, 'torus → AddTorusRing');
  // icosahedron is approximated by a Sphere (≥2 Sphere parts: real sphere + icosahedron)
  var sphereCount = (code.match(/PrimitiveType\.Sphere/g) || []).length;
  assert.ok(sphereCount >= 2, 'sphere + icosahedron both map to Sphere (got ' + sphereCount + ')');
  // emissive op carries non-zero emissive intensity
  assert.match(code, /AddCompositePart\(__root, PrimitiveType\.Cylinder[^\n]*0\.3f/, 'cone op keeps emissiveIntensity 0.3');
  console.log('  ✓ kind mappings: cone→Cylinder, icosahedron→Sphere, torus→AddTorusRing');
})();

// 3. Flag OFF → nothing emitted (byte-identical regression)
(function flagOffByteIdentical() {
  var on = gen(true, true);
  var off = gen(false, true);     // sourceMeshOps present but flag off
  var noOps = gen(true, false);   // flag on but no sourceMeshOps
  assert.doesNotMatch(off, /BuildSourceFaithfulMeshes/, 'flag off → no emission');
  assert.doesNotMatch(noOps, /BuildSourceFaithfulMeshes/, 'no meshOps → no emission');
  assert.strictEqual(off, noOps, 'flag-off and no-meshOps produce identical output (the existing skeleton)');
  assert.notStrictEqual(on, off, 'flag-on output differs (the new methods)');
  console.log('  ✓ flag off / no meshOps: byte-identical to existing skeleton');
})();

// 4. R4 — the new-Vector3 calls in BuildEntity_* must NOT add hot-path violations
(function hotPathSafe() {
  var on = gen(true, true);
  var off = gen(false, true);
  function hotHits(code) {
    return staticCheck(code).issues.filter(function (i) { return i.rule === 'update-new-vector-in-hot-path'; }).length;
  }
  assert.strictEqual(hotHits(on), hotHits(off),
    'BuildSourceFaithfulMeshes new Vector3 must not add update-new-vector-in-hot-path violations (R4)');
  console.log('  ✓ R4: composite-mesh new Vector3 does not trip the hot-path rule (' + hotHits(on) + ' hits, unchanged)');
})();

console.log('\nskeleton-generator source-faithful (Option C): all cases passed');
