const { generateResourceUpdate } = require('../adapters/templates/resource-flow.cjs');

function makeSchema() {
  return {
    resources: [
      { name: 'MetalShard', entity: 'MetalShard', convertRatio: 0 },
    ],
    phases: [],
    gameConfig: { collectRange: 1.5, maxCarry: 10 },
  };
}

describe('batch2 resource-flow buildCollectBlock', () => {
  test('collect block has _collectCooldown <= 0f gate', () => {
    var out = generateResourceUpdate(makeSchema());
    expect(out).toMatch(/_collectCooldown\s*<=\s*0f/);
  });

  test('collect block sets _collectCooldown = collectCooldownInterval after collecting', () => {
    var out = generateResourceUpdate(makeSchema());
    expect(out).toMatch(/_collectCooldown\s*=\s*collectCooldownInterval/);
  });

  test('scoreText update gated by _lastScoreText diff', () => {
    var out = generateResourceUpdate(makeSchema());
    // Must NOT directly assign scoreText.text from concat; must use diff pattern
    // Look for: if (_lastScoreText != <var>) { scoreText.text = <var>; _lastScoreText = <var>; }
    expect(out).toMatch(/_lastScoreText\s*!=/);
    expect(out).toMatch(/_lastScoreText\s*=\s*\w+\s*;/);
  });

  test('collect block does NOT have direct scoreText.text = concat (anti-regression)', () => {
    var out = generateResourceUpdate(makeSchema());
    // Should not have: scoreText.text = "..." + ... as top-level statement without diff gate
    // Match: scoreText.text = "lit" + at start of statement (not inside if (_lastScoreText != ...) context)
    var directConcat = /\n\s*scoreText\.text\s*=\s*"[^"]*"\s*\+/;
    expect(out).not.toMatch(directConcat);
  });
});

describe('batch2 resource-flow IsNear merge by target', () => {
  test('single IsNear(target) for multiple resources pointing to same target', () => {
    var schema = {
      resources: [
        { name: 'MetalShard', entity: 'MetalSource', convertRatio: 2 },
        { name: 'Gold', entity: 'MetalSource', convertRatio: 3 },
      ],
      phases: [
        { trigger: { type: 'entity_state_reached', entity: 'ForgeWorkshop', amount: 5 } },
      ],
    };
    var out = generateResourceUpdate(schema);
    // Count IsNear(ForgeWorkshop, ...) calls in delivery blocks.
    // Entity names preserve PascalCase per skeleton convention (see trigger-codegen.toLowerCamel identity).
    var matches = out.match(/IsNear\(ForgeWorkshop,\s*2f\)/g) || [];
    // Before merge: 2 (one per resource). After merge: 1.
    expect(matches.length).toBe(1);
  });

  test('multiple targets still get separate IsNear blocks', () => {
    var schema = {
      resources: [
        { name: 'A', entity: 'SourceA', convertRatio: 1 },
      ],
      phases: [
        { trigger: { type: 'entity_state_reached', entity: 'TargetA', amount: 1 } },
        { trigger: { type: 'entity_state_reached', entity: 'TargetB', amount: 1 } },
      ],
    };
    var out = generateResourceUpdate(schema);
    expect(out).toMatch(/IsNear\(TargetA,\s*2f\)/);
    expect(out).toMatch(/IsNear\(TargetB,\s*2f\)/);
  });

  test('missing trigger entity does not emit malformed IsNear call', () => {
    var schema = {
      resources: [
        { name: 'RocketDebris', entity: 'RocketDebris', convertRatio: 1 },
      ],
      phases: [
        { trigger: { type: 'entity_state_reached', entity: '', amount: 1 } },
      ],
    };
    var out = generateResourceUpdate(schema);
    expect(out).not.toMatch(/IsNear\(\s*,/);
  });

  test('missing resource entity skips collect block instead of emitting malformed IsNear call', () => {
    var schema = {
      resources: [
        { name: 'Gold', entity: '', convertRatio: 0 },
      ],
      phases: [],
    };
    var out = generateResourceUpdate(schema);
    expect(out).not.toMatch(/IsNear\(\s*,/);
  });
});
