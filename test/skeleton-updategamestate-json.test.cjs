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
  const phaseTimestampsLine = lines.find(line => line.indexOf('\\"phaseTimestamps\\":{') >= 0);
  assert.ok(entityStatesLine, 'entityStates JSON bridge line should exist');
  assert.ok(variablesLine, 'variables JSON bridge line should exist');
  assert.ok(uiStateLine, 'uiState JSON bridge line should exist');
  assert.ok(cameraStateLine, 'cameraState JSON bridge line should exist');
  assert.ok(phaseTimestampsLine, 'phaseTimestamps JSON bridge line should exist');
  assert.ok(entityStatesLine.indexOf('BuildEntityStatesJson()') >= 0, 'entityStates line should call helper');
  assert.ok(variablesLine.indexOf('BuildVariablesJson()') >= 0, 'variables line should call helper');
  assert.ok(phaseTimestampsLine.trimEnd().endsWith('{"'), 'phaseTimestamps line must close the C# string literal');
  assert.ok(String(code).indexOf('BuildEntityStatesJson()') >= 0, 'entity state helper should be used');
  assert.ok(String(code).indexOf('BuildUiStateJson()') >= 0, 'ui state helper should be used');
  assert.ok(String(code).indexOf('BuildCameraStateJson()') >= 0, 'camera state helper should be used');
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
}

console.log('skeleton UpdateGameState JSON tests passed');
