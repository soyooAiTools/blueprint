'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var sceneBakePlan = require('../lib/programmer-delivery-scene-bake-plan.cjs');
var tempCodeAudit = require('../lib/programmer-delivery-temp-code-audit.cjs');

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-scene-bake-plan-'));
try {
  writeFile(path.join(root, 'source-scene-ir.json'), JSON.stringify({
    schemaVersion: 'source-scene-ir.v1',
    entities: [{ id: '_gold' }],
    phases: [{ phaseId: 'p1', guideText: 'Collect gold' }]
  }, null, 2) + '\n');
  writeFile(path.join(root, 'PROGRAMMER_DELIVERY_SUMMARY.json'), JSON.stringify({
    sourcePrimitiveEntityCount: 1,
    sourcePrimitiveRendererCount: 1,
    sourcePrimitiveScriptsWritten: 2,
    fallbackSourcePrimitiveEntityCount: 1
  }, null, 2) + '\n');
  writeFile(path.join(root, 'MCP_HYDRATION_REPORT.json'), JSON.stringify({
    kind: 'blueprint.programmerDeliverySceneHydration',
    schemaVersion: 1,
    mode: 'static-unity-yaml',
    toolLayer: 'aibridge-compatible',
    passed: true
  }, null, 2) + '\n');
  writeFile(path.join(root, 'Assets', 'Scripts', 'Tool', 'GMP_PrimitiveSpec.cs'), 'public class GMP_PrimitiveSpec {}\n');
  writeFile(path.join(root, 'Assets', 'Scripts', 'Tool', 'GMP_PrimitiveBuilder.cs'), 'public static class GMP_PrimitiveBuilder {}\n');
  writeFile(path.join(root, 'Assets', 'Scripts', 'Game', 'Phases', 'Phase_p1.asset'), '%YAML 1.1\n');
  writeFile(path.join(root, 'Assets', 'Scenes', 'Game.unity'), [
    '%YAML 1.1',
    '--- !u!1 &100',
    'GameObject:',
    '  m_Name: SourcePrimitive_Gold_Fallback_00',
    '--- !u!114 &101',
    'MonoBehaviour:',
    '  mGeometryType: "CylinderGeometry"',
    '  mArgs: []',
    '  mBindings:',
    '  - mEntityName: "_gold"',
    ''
  ].join('\n'));

  var plan = sceneBakePlan.writeSceneBakePlan(root);
  assert.strictEqual(plan.kind, sceneBakePlan.KIND);
  assert.strictEqual(plan.sourceOfTruth.phaseCount, 1);
  assert.strictEqual(plan.scene.entityBindingCount, 1);
  assert.strictEqual(plan.scene.fallbackPrimitiveObjectNames.length, 1);
  assert.ok(plan.actions.some(function(action) { return action.id === 'bake-primitive-spec-components'; }));
  assert.ok(plan.actions.some(function(action) { return action.id === 'preserve-storyboard-webgl-parity'; }));

  var failingAudit = tempCodeAudit.writeTempCodeAudit(root);
  assert.strictEqual(failingAudit.passed, false);
  assert.ok(failingAudit.errors.some(function(issue) { return issue.code === 'temporary-primitive-runtime-scripts'; }));
  assert.ok(failingAudit.errors.some(function(issue) { return issue.code === 'temporary-primitive-scene-components'; }));
  assert.ok(failingAudit.warnings.some(function(issue) { return issue.code === 'fallback-source-primitives'; }));
  assert.ok(failingAudit.warnings.some(function(issue) { return issue.code === 'static-hydration-evidence'; }));

  fs.rmSync(path.join(root, 'Assets', 'Scripts', 'Tool', 'GMP_PrimitiveSpec.cs'), { force: true });
  fs.rmSync(path.join(root, 'Assets', 'Scripts', 'Tool', 'GMP_PrimitiveBuilder.cs'), { force: true });
  writeFile(path.join(root, 'Assets', 'GeneratedMeshes', '0000_SourcePrimitive_Gold_Fallback_00.asset'), '%YAML 1.1\n--- !u!43 &4300000\nMesh:\n  m_Name: baked\n');
  writeFile(path.join(root, 'SCENE_BAKE_REPORT.json'), JSON.stringify({
    kind: 'blueprint.programmerDeliverySceneBakeReport',
    schemaVersion: 1,
    passed: true,
    primitiveSpecComponentsFound: 1,
    primitiveSpecComponentsRemoved: 1,
    generatedMeshAssetCount: 1,
    tempScriptsDeleted: 2,
    errors: []
  }, null, 2) + '\n');
  writeFile(path.join(root, 'Assets', 'Scenes', 'Game.unity'), [
    '%YAML 1.1',
    '--- !u!1 &100',
    'GameObject:',
    '  m_Name: SourcePrimitive_Gold_Fallback_00',
    '--- !u!33 &101',
    'MeshFilter:',
    '  m_Mesh: {fileID: 4300000, guid: 11111111111111111111111111111111, type: 2}',
    '  mBindings:',
    '  - mEntityName: "_gold"',
    ''
  ].join('\n'));
  sceneBakePlan.writeSceneBakePlan(root);
  var passingAudit = tempCodeAudit.writeTempCodeAudit(root);
  assert.strictEqual(passingAudit.passed, true);
  assert.strictEqual(passingAudit.summary.generatedMeshAssetCount, 1);
  assert.ok(passingAudit.warnings.some(function(issue) { return issue.code === 'fallback-source-primitives'; }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('programmer delivery scene bake plan and temporary code audit tests passed');
