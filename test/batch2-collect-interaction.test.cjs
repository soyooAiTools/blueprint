const { generateCollectUpdate } = require('../adapters/templates/interactions/collect-interaction.cjs');

function makeSchema() {
  return {
    resources: [
      { name: 'Metal', entity: 'MetalSource', maxStock: 10 },
    ],
    gameConfig: { collectRange: 2, maxCarry: 10 },
  };
}

describe('batch2 collect-interaction cooldown', () => {
  test('collect block has _collectCooldown <= 0f gate', () => {
    var out = generateCollectUpdate(makeSchema());
    expect(out).toMatch(/_collectCooldown\s*<=\s*0f/);
  });

  test('collect block sets _collectCooldown = collectCooldownInterval', () => {
    var out = generateCollectUpdate(makeSchema());
    expect(out).toMatch(/_collectCooldown\s*=\s*collectCooldownInterval/);
  });

  test('Done flag still set (anti-regression for dual-path rule)', () => {
    var out = generateCollectUpdate(makeSchema());
    expect(out).toMatch(/MetalSourceDone\s*=\s*true/);
  });
});
