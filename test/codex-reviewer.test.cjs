const assert = require('assert');

const codexReviewer = require('../worker/codex-reviewer.js');

{
  const args = codexReviewer._buildCodexReviewArgs('/tmp/review-work', '/tmp/review-work/out.txt');
  assert.deepStrictEqual(args, [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-m', process.env.CODEX_REVIEW_MODEL || process.env.CODEX_CODE_MODEL || 'gpt-5.5',
    '-c', 'model_reasoning_effort="' + (process.env.CODEX_REVIEW_REASONING_EFFORT || process.env.CODEX_REASONING_EFFORT || 'high') + '"',
    '-s', 'danger-full-access',
    '-C', '/tmp/review-work',
    '-o', '/tmp/review-work/out.txt',
  ]);
}

{
  const parsed = codexReviewer._parseReviewOutput('{"verdict":"PASS","issues":[],"summary":"ok"}');
  assert.strictEqual(parsed.verdict, 'PASS');
  assert.deepStrictEqual(parsed.issues, []);
}

console.log('codex reviewer tests passed');
