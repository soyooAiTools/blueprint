/**
 * Codex coder adapter.
 *
 * This round only unifies the worker entry name. The implementation still
 * delegates to the underlying coder implementation underneath.
 */

var legacyCoder = require('./codex-code-coder.js');

function generateWithCodex(blueprint, clientDir, log, taskId, engine) {
  return (legacyCoder.generateWithCodex || legacyCoder.generateWithClaudeCode)(blueprint, clientDir, log, taskId, engine);
}

function runCodexText(opts) {
  return (legacyCoder.runCodexText || legacyCoder.runClaudeCodeText)(opts);
}

module.exports = {
  generateWithCodex: generateWithCodex,
  runCodexText: runCodexText,

  // Legacy export names kept for call sites not migrated yet.
  generateWithClaudeCode: generateWithCodex,
  runClaudeCodeText: runCodexText,
};
