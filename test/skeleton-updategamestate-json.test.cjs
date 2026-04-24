const assert = require('assert');

const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

function makeSpec(phaseId, entityName) {
  return {
    phaseId,
    phaseName: phaseId,
    entitiesRequired: [{ name: entityName }],
    requiredInteractions: ['click:' + entityName],
    triggerNext: { condition: entityName + '.done' },
    duration: { min: 1, max: 3 },
    playerMustAct: true,
  };
}

function assertUpdateGameStateJsonLines(code) {
  const lines = String(code).split('\n');
  const entityStatesLine = lines.find(line => line.indexOf('\\"entityStates\\":') >= 0);
  const variablesLine = lines.find(line => line.indexOf('\\"variables\\":') >= 0);
  const uiStateLine = lines.find(line => line.indexOf('\\"uiState\\":') >= 0);
  const cameraStateLine = lines.find(line => line.indexOf('\\"cameraState\\":') >= 0);
  const phaseEvidenceLine = lines.find(line => line.indexOf('\\"phaseEvidence\\":') >= 0);
  const phaseTimestampsLine = lines.find(line => line.indexOf('\\"phaseTimestamps\\":{') >= 0);
  assert.ok(entityStatesLine, 'entityStates JSON bridge line should exist');
  assert.ok(variablesLine, 'variables JSON bridge line should exist');
  assert.ok(uiStateLine, 'uiState JSON bridge line should exist');
  assert.ok(cameraStateLine, 'cameraState JSON bridge line should exist');
  assert.ok(phaseEvidenceLine, 'phaseEvidence JSON bridge line should exist');
  assert.ok(phaseTimestampsLine, 'phaseTimestamps JSON bridge line should exist');
  assert.ok(entityStatesLine.indexOf('BuildEntityStatesJson()') >= 0, 'entityStates line should call helper');
  assert.ok(variablesLine.indexOf('BuildVariablesJson()') >= 0, 'variables line should call helper');
  assert.ok(phaseEvidenceLine.indexOf('BuildPhaseEvidenceJson()') >= 0, 'phaseEvidence line should call helper');
  assert.ok(phaseTimestampsLine.trimEnd().endsWith('{"'), 'phaseTimestamps line must close the C# string literal');
  assert.ok(String(code).indexOf('BuildEntityStatesJson()') >= 0, 'entity state helper should be used');
  assert.ok(String(code).indexOf('BuildUiStateJson()') >= 0, 'ui state helper should be used');
  assert.ok(String(code).indexOf('BuildCameraStateJson()') >= 0, 'camera state helper should be used');
  assert.ok(String(code).indexOf('BuildPhaseEvidenceJson()') >= 0, 'phase evidence helper should be used');
  assert.ok(String(code).indexOf('if (phaseJson.Length > 0)') >= 0, 'phase evidence should only serialize recorded module evidence');
  assert.ok(
    String(code).indexOf('phaseJson = AppendSignalEvidenceJson(phaseJson, "distance_to_target_below_threshold"') < 0,
    'phase evidence bridge must not synthesize default distance evidence'
  );
}

{
  const out = generateSkeleton([
    makeSpec('phaseOne', 'Ore'),
    makeSpec('phaseTwo', 'Forge'),
  ], {
    entityPoolMap: { Ore: '__Pool_Ore', Forge: '__Pool_Forge' },
    entities: [{ name: 'Ore' }, { name: 'Forge' }],
    w1bSplit: false,
  });
  assert.strictEqual(typeof out, 'string');
  assertUpdateGameStateJsonLines(out);
  assert.ok(out.indexOf('        // TODO_CUSTOM_END\n        UpdateGameState();') >= 0, 'Update should export fresh gameState every frame');
}

{
  const specs = [];
  const entityPoolMap = {};
  const entities = [];
  for (let i = 0; i < 11; i++) {
    const entityName = 'Entity' + i;
    specs.push(makeSpec('phase' + i, entityName));
    entityPoolMap[entityName] = '__Pool_' + entityName;
    entities.push({ name: entityName });
  }
  const out = generateSkeleton(specs, { entityPoolMap, entities });
  assert.ok(out && typeof out === 'object' && typeof out.ui === 'string', 'split skeleton should include ui partial');
  assertUpdateGameStateJsonLines(out.ui);
  assert.ok(out.main.indexOf('        // TODO_CUSTOM_END\n        UpdateGameState();') >= 0, 'split main Update should export fresh gameState every frame');
}

console.log('skeleton UpdateGameState JSON tests passed');
