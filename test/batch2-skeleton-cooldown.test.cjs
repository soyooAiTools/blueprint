const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

// Minimal idle-game spec that triggers isIdleGame gate
function makeSpecs(collectCooldown) {
  var specs = [{
    phaseId: 'p1',
    phaseName: 'Phase 1',
    title: 'collect',
    duration: { min: 3, max: 3 },
    entities: ['Player', 'MetalShard'],
    entitiesRequired: [{ name: 'MetalShard', terminalState: 1 }],
    requiredInteractions: ['move_to:MetalShard', 'collect:MetalShard'],
    triggerNext: { condition: 'p1InteractionDone', description: '' },
    endCondition: 'MetalShardCarried >= 3',
    playerMustAct: true,
    autoAllowed: false,
  }];
  if (collectCooldown !== undefined) {
    specs.gameConfig = { collectCooldown: collectCooldown };
  }
  return specs;
}

describe('batch2 skeleton cooldown infrastructure', () => {
  test('collectCooldownInterval field emitted with default 0.3f', () => {
    var out = generateSkeleton(makeSpecs());
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/float\s+collectCooldownInterval\s*=\s*0\.3f\s*;/);
  });

  test('_collectCooldown field emitted as 0f', () => {
    var out = generateSkeleton(makeSpecs());
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/float\s+_collectCooldown\s*=\s*0f\s*;/);
  });

  test('_lastScoreText field emitted as empty string', () => {
    var out = generateSkeleton(makeSpecs());
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/string\s+_lastScoreText\s*=\s*""\s*;/);
  });

  test('Update() decrements _collectCooldown when > 0', () => {
    var out = generateSkeleton(makeSpecs());
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/if\s*\(\s*_collectCooldown\s*>\s*0f\s*\)\s*_collectCooldown\s*-=\s*Time\.deltaTime\s*;/);
  });

  test('collectCooldownInterval respects schema gameConfig.collectCooldown', () => {
    var out = generateSkeleton(makeSpecs(0.5));
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/float\s+collectCooldownInterval\s*=\s*0\.5f\s*;/);
  });
});
