const assert = require('assert');
const checkpoint = require('../lib/checkpoint.cjs');

function testAllowsOwnedActiveTask() {
  const result = checkpoint.shouldSaveCheckpointOnShutdown({
    id: 't1',
    status: 'processing',
    assigned_to: 'linux-worker-1',
  }, 'linux-worker-1');
  assert.deepStrictEqual(result, { ok: true, reason: 'owned-active' });
}

function testRejectsUnassignedTask() {
  const result = checkpoint.shouldSaveCheckpointOnShutdown({
    id: 't1',
    status: 'pending',
    assigned_to: null,
  }, 'linux-worker-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'unassigned');
}

function testRejectsStaleOwnership() {
  const result = checkpoint.shouldSaveCheckpointOnShutdown({
    id: 't1',
    status: 'processing',
    assigned_to: 'linux-worker-2',
  }, 'linux-worker-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'owned-by-linux-worker-2');
}

function testRejectsInactiveStatus() {
  const result = checkpoint.shouldSaveCheckpointOnShutdown({
    id: 't1',
    status: 'cancelled',
    assigned_to: 'linux-worker-1',
  }, 'linux-worker-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'inactive-status-cancelled');
}

testAllowsOwnedActiveTask();
testRejectsUnassignedTask();
testRejectsStaleOwnership();
testRejectsInactiveStatus();

console.log('checkpoint-shutdown-guard.test.cjs passed');
