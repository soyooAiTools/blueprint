'use strict';
const { generateAutoPlay } = require('../adapters/templates/autoplay-mirror.cjs');

describe('autoplay-mirror — switch dispatch (post-W1a)', () => {
  const schema = {
    phases: [
      { phaseId: 'phaseA', trigger: { type: 'resource_collected', resource: 'X', amount: 1 }, onComplete: [] },
      { phaseId: 'phaseB', trigger: { type: 'click_entity', entity: 'Target' }, onComplete: [] },
      { phaseId: 'phaseC', trigger: null, onComplete: [] },
    ],
    entities: [],
  };

  test('uses switch(currentPhaseName) with case per phase', () => {
    const code = generateAutoPlay(schema);
    expect(code).toMatch(/switch\s*\(\s*currentPhaseName\s*\)/);
    expect(code).toMatch(/case\s+"phaseA"\s*:/);
    expect(code).toMatch(/case\s+"phaseB"\s*:/);
    expect(code).toMatch(/case\s+"phaseC"\s*:/);
    // No parallel `if (currentPhaseName == ...)` chain — those are the bad pattern W1a removed.
    const parallelIf = (code.match(/if \(currentPhaseName ==/g) || []).length;
    expect(parallelIf).toBe(0);
  });
});

describe('codegen-template-engine TODO_UPDATE — dispatch shape (post-W1a/W1b)', () => {
  test('TODO_UPDATE body delegates to Phase_OnTap (W1b) instead of inline if-chain', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../adapters/codegen-template-engine.cjs'), 'utf8');
    // Post-W1b: tap dispatch is `Phase_OnTap()` in Flow partial; codegen must reference it.
    expect(src).toMatch(/Phase_OnTap\(\)/);
    // Must not re-introduce the legacy if/else-if ladder generator.
    expect(src).not.toMatch(/pi === 0 \? ['"]if['"] : ['"]else if['"]/);
  });
});
