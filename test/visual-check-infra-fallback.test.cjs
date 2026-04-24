const assert = require('assert');

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

console.log('visual-check infra fallback tests passed');
