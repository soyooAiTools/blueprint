const { generateScoreDisplay } = require('../adapters/templates/interactions/score-display.cjs');

describe('batch2 score-display diff gate', () => {
  test('scoreText.text assignment gated by _lastScoreText diff', () => {
    var schema = { resources: [{ name: 'Metal', entity: 'MetalSource' }] };
    var out = generateScoreDisplay(schema);
    expect(out).toMatch(/_lastScoreText\s*!=\s*display/);
    expect(out).toMatch(/_lastScoreText\s*=\s*display/);
    expect(out).not.toMatch(/\bgold\b/);
  });

  test('empty resources produces empty output (no regression)', () => {
    var out = generateScoreDisplay({ resources: [] });
    expect(out).toBe('');
  });
});
