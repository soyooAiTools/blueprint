const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const coder = require('../worker/codex-code-coder.js');

{
  const text = coder.buildFeedbackText({
    rule: 'player-alias-drift',
    message: 'Normalize all player references to `player`.',
    data: {
      text: 'Normalize all player references to `player`.',
    },
  });
  assert.strictEqual(text, 'Normalize all player references to `player`.');
}

{
  const text = coder.buildFeedbackText({
    rule: 'duplicate-state-fields',
    message: 'Reuse skeleton-owned state fields instead of redeclaring them.',
    data: ['LaserTurretState'],
  });
  assert.strictEqual(text, 'Reuse skeleton-owned state fields instead of redeclaring them.');
}

/* existing postfix tests unchanged */

{
  const banner = 'Reading prompt from stdin...\nOpenAI Codex v0.128.0 (research preview)';
  const stderr = 'Quota exceeded: weekly usage limit reached';
  assert.strictEqual(coder._internals.resolveRunnerErrorBody(banner, stderr, 'Exit code 1'), stderr);
  assert.strictEqual(
    coder._internals.resolveRunnerErrorBody('', banner + '\n' + stderr, 'Exit code 1'),
    stderr
  );
  assert.strictEqual(
    coder._internals.resolveRunnerErrorBody(banner + '\n' + stderr, '', 'Exit code 1'),
    stderr
  );
  assert.strictEqual(coder._internals.resolveRunnerErrorBody(banner, '', 'Exit code 1'), banner);
  assert.strictEqual(
    coder._internals.resolveRunnerErrorBody(
      banner,
      'OpenAI Codex v0.128.0 (research preview)\nSelected model gpt-5.5 may not exist',
      'Exit code 1'
    ),
    'Selected model gpt-5.5 may not exist'
  );
  assert.strictEqual(
    coder._internals.selectRunnerErrorLine(
      banner,
      'Reading prompt from stdin...\nQuota exceeded: weekly usage limit reached'
    ),
    stderr
  );
  assert.strictEqual(coder._internals.isModelFatalStream('Your organization has disabled Claude subscription access'), true);
}

console.log('codex-code-coder post-fix tests passed');