'use strict';
const { generateAutoPlay } = require('../adapters/templates/autoplay-mirror.cjs');

describe('autoplay-mirror — else if chain (T1-3)', () => {
  const schema = {
    phases: [
      { phaseId: 'phaseA', trigger: { type: 'resource_collected', resource: 'X', amount: 1 }, onComplete: [] },
      { phaseId: 'phaseB', trigger: { type: 'click_entity', entity: 'Target' }, onComplete: [] },
      { phaseId: 'phaseC', trigger: null, onComplete: [] },
    ],
    entities: [],
  };

  test('first phase uses bare `if`, subsequent phases use `else if`', () => {
    const code = generateAutoPlay(schema);
    expect(code).toMatch(/^\s*if \(currentPhaseName == "phaseA"\)/m);
    expect(code).toMatch(/\}\s*else if \(currentPhaseName == "phaseB"\)/);
    expect(code).toMatch(/\}\s*else if \(currentPhaseName == "phaseC"\)/);
    const bareIfCount = (code.match(/^\s+if \(currentPhaseName/gm) || []).length;
    expect(bareIfCount).toBe(1);
  });
});
