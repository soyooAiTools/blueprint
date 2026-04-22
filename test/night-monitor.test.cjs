const assert = require('assert');

const nightMonitor = require('../engine/night-monitor.cjs');

{
  const project = {
    statusMessage: 'Permanently failed after 29 code retries',
    lastFailure: { failReason: 'Codegen contract failed: duplicate-state-fields' },
  };
  assert.strictEqual(nightMonitor.isPermanentFailure(project), true);
}

{
  const project = {
    statusMessage: 'Outer-retry fingerprint FATAL: "[Linux] Error: [method-check] Codegen contract failed: duplicate-state-fields"',
    lastFailure: { failReason: 'Codegen contract failed: duplicate-state-fields' },
  };
  assert.strictEqual(nightMonitor.isPermanentFailure(project), false);
}

{
  const should = nightMonitor.shouldResubmit({
    sameFingerprintCount: 1,
    lastResubmitAt: null,
    lastResubmitHead: null,
  }, 'head-a');
  assert.strictEqual(should, true);
}

{
  const should = nightMonitor.shouldResubmit({
    sameFingerprintCount: 3,
    lastResubmitAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    lastResubmitHead: 'head-a',
  }, 'head-a');
  assert.strictEqual(should, false);
}

{
  const should = nightMonitor.shouldResubmit({
    sameFingerprintCount: 4,
    lastResubmitAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    lastResubmitHead: 'head-a',
  }, 'head-b');
  assert.strictEqual(should, true);
}

console.log('night-monitor tests passed');
