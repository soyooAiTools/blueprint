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

// W1b 默认开启 5-partial 拆分 — Idle 采集冷却字段从 main 迁移到 Resource partial。
// 这些断言依然校验 cooldown 基础设施齐全，只是要按拆分后的归属去查（fields 在 resource，
// Update 中的 decrement 调度仍在 main）。
function combinedSource(out) {
  if (typeof out === 'string') return out;
  return [out.main, out.flow, out.input, out.resource, out.ui, out.scene]
    .filter(Boolean)
    .join('\n');
}

describe('batch2 skeleton cooldown infrastructure', () => {
  test('collectCooldownInterval field emitted with default 0.3f', () => {
    var combined = combinedSource(generateSkeleton(makeSpecs()));
    expect(combined).toMatch(/float\s+collectCooldownInterval\s*=\s*0\.3f\s*;/);
  });

  test('_collectCooldown field emitted as 0f', () => {
    var combined = combinedSource(generateSkeleton(makeSpecs()));
    expect(combined).toMatch(/float\s+_collectCooldown\s*=\s*0f\s*;/);
  });

  test('_lastScoreText field emitted as empty string', () => {
    var combined = combinedSource(generateSkeleton(makeSpecs()));
    expect(combined).toMatch(/string\s+_lastScoreText\s*=\s*""\s*;/);
  });

  test('Update() decrements _collectCooldown when > 0', () => {
    var out = generateSkeleton(makeSpecs());
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/if\s*\(\s*_collectCooldown\s*>\s*0f\s*\)\s*_collectCooldown\s*-=\s*Time\.deltaTime\s*;/);
  });

  test('collectCooldownInterval respects schema gameConfig.collectCooldown', () => {
    var combined = combinedSource(generateSkeleton(makeSpecs(0.5)));
    expect(combined).toMatch(/float\s+collectCooldownInterval\s*=\s*0\.5f\s*;/);
  });
});
