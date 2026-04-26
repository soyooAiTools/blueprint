var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var TaskQueue = require('../lib/task-queue.cjs');

var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-task-queue-preview-'));
var dbPath = path.join(tmpRoot, 'blueprint.db');
var queue = new TaskQueue(dbPath);

try {
  var taskId = 'proj_preview_lifecycle';
  queue.enqueue(taskId, taskId, 'Preview lifecycle', { entities: [{ id: 'Player' }] }, {});

  var claimed = queue.claim('linux-worker-test');
  assert.strictEqual(claimed.id, taskId, 'worker should claim pending task');
  assert.strictEqual(claimed.status, 'assigned');

  var processing = queue.report(taskId, 'processing', {
    workerId: 'linux-worker-test',
    message: '[Linux] AI coding...',
  });
  assert.strictEqual(processing.status, 'processing');

  var preview = queue.report(taskId, 'preview_ready', {
    workerId: 'linux-worker-test',
    message: '[Linux] preview generated',
    previewUrl: 'https://example.invalid/webgl/proj_preview_lifecycle/index.html',
  });
  assert.strictEqual(preview.status, 'preview_ready');
  assert.strictEqual(preview.assigned_to, 'linux-worker-test');
  assert.ok(preview.preview_url, 'preview URL should be retained');

  queue.db.prepare('UPDATE tasks SET retry_after = ? WHERE id = ?').run(Date.now() + 60000, taskId);
  var activeAgain = queue.report(taskId, 'processing', {
    workerId: 'linux-worker-test',
    message: '[Linux] Runtime contract verifying...',
  });
  assert.strictEqual(activeAgain.status, 'processing', 'queue should become active after preview milestone');
  assert.strictEqual(activeAgain.assigned_to, 'linux-worker-test');
  assert.strictEqual(activeAgain.retry_after, null, 'active report should clear stale retry_after');

  var staleTaskId = 'proj_preview_stale';
  queue.enqueue(staleTaskId, staleTaskId, 'Stale preview', { entities: [{ id: 'Player' }] }, {});
  queue.claim('linux-worker-stale');
  queue.report(staleTaskId, 'processing', {
    workerId: 'linux-worker-stale',
    message: '[Linux] AI coding...',
  });
  queue.report(staleTaskId, 'preview_ready', {
    workerId: 'linux-worker-stale',
    message: '[Linux] Runtime contract verifying...',
  });
  queue.db.prepare(
    "UPDATE tasks SET updated_at = datetime('now', '-2 hours') WHERE id = ?"
  ).run(staleTaskId);

  var reclaimed = queue.reclaimStale(60, 60);
  assert.strictEqual(reclaimed.count, 1, 'stale assigned preview_ready task should be reclaimed');
  var staleAfter = queue.get(staleTaskId);
  assert.strictEqual(staleAfter.status, 'pending');
  assert.strictEqual(staleAfter.assigned_to, null);

  console.log('task-queue preview lifecycle tests passed');
} finally {
  try { if (queue && typeof queue.close === 'function') queue.close(); } catch (_err) {}
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
