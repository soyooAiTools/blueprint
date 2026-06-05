const assert = require('assert');
const fs = require('fs');
const path = require('path');

const visualCheck = require('../engine/stages/visual-check.cjs');

assert.strictEqual(
  visualCheck._isVisualInfraFailureReason('Vision CLI unavailable: Exit code 143'),
  true
);

assert.strictEqual(
  visualCheck._isVisualInfraFailureReason('MODEL_FATAL: Vision CLI returned empty response (likely auth/quota failure)'),
  true
);

assert.strictEqual(
  visualCheck._isVisualInfraFailureReason('solid color screen with no visible objects'),
  false
);

assert.throws(
  () => visualCheck._assertVisualCheckPassed({ passed: false, reason: 'all frames identical' }),
  /Visual check failed: all frames identical/,
  'visual-check must hard-fail when the fix-loop result is a failed visual result'
);

assert.deepStrictEqual(
  visualCheck._assertVisualCheckPassed({ passed: true, rounds: 1 }),
  { passed: true, rounds: 1 },
  'visual-check should pass through successful results'
);

const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'stages', 'visual-check.cjs'), 'utf8');
assert.ok(
  src.indexOf('Vision backend degraded after preview capture — failing closed') >= 0,
  'visual backend degradation must fail closed, not continue as warning'
);
assert.ok(
  src.indexOf('MODEL_FATAL: Visual backend unavailable; fail-closed') >= 0,
  'visual backend degradation should throw MODEL_FATAL to stop the pipeline'
);
assert.ok(
  src.indexOf('loop.run(ctx).then(assertVisualCheckPassed)') >= 0,
  'failed visual-check results must not be treated as completed'
);

console.log('visual-check infra fallback tests passed');
