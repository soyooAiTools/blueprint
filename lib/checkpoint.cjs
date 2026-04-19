/**
 * Checkpoint filesystem helpers.
 *
 * Checkpoint files live at server-data/checkpoints/<taskId>/checkpoint.json
 * (mirror of the path hardcoded in worker/linux-worker-client.js:CHECKPOINT_DIR).
 *
 * Written by worker on pipeline progress + graceful shutdown; read back by
 * worker.processTask() to resume completedStages. When a task is cancelled or
 * freshly re-submitted, the checkpoint must be cleared — otherwise resume
 * silently skips codegen and feeds stale csCode into downstream stages.
 */

var fs = require('fs');
var path = require('path');

var CHECKPOINT_ROOT = path.join(__dirname, '..', 'server-data', 'checkpoints');

function checkpointDirFor(taskId) {
  return path.join(CHECKPOINT_ROOT, taskId);
}

function clearCheckpoint(taskId) {
  var dir = checkpointDirFor(taskId);
  if (!fs.existsSync(dir)) return { cleared: false, reason: 'not-exists' };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { cleared: true };
  } catch (e) {
    return { cleared: false, reason: e.message };
  }
}

module.exports = { clearCheckpoint: clearCheckpoint, checkpointDirFor: checkpointDirFor };
