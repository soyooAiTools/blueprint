const assert = require('assert');
const policy = require('../lib/shot-duration-policy.cjs');

assert.deepStrictEqual(
  policy.normalizeReviewShotDuration({ min: 3, max: 8 }).duration,
  { min: 10, max: 12 }
);

assert.deepStrictEqual(
  policy.normalizeReviewShotDuration({ min: 12, max: 30 }).duration,
  { min: 12, max: 15 }
);

assert.deepStrictEqual(
  policy.normalizeReviewShotDuration({ min: 20, max: 30 }).duration,
  { min: 15, max: 15 }
);

assert.deepStrictEqual(
  policy.normalizeReviewShotDuration(null).duration,
  { min: 10, max: 15 }
);

console.log('shot duration policy tests passed');
