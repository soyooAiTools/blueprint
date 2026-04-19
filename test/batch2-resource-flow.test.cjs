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
