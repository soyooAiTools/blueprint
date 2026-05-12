/**
 * 2026-05-12: schema non-retryable error fingerprints.
 *
 * 根因: 当 Anthropic API 上游 unreachable 时, claude --print SDK 内部已经 retry 11 次
 * (~13min) 后 give up,返回 "API Error: Unable to connect to API (UND_ERR_SOCKET)"。
 * 外层 codegen-schema 又 retry 3 次 = ~39min 烧光只为等死的 API。
 *
 * 修法: 把这两个 fingerprint 加进 isSchemaNonRetryableError,让外层立即 throw,任务
 * 尽快进 FATAL 而不是叠加双层 retry。
 */

var assert = require('assert');
var codegenSchema = require('../engine/stages/codegen-schema.cjs');
var fn = codegenSchema._internals.isSchemaNonRetryableError;

// 真实生产报错样本(2026-05-12 13:28 stderr)
assert.strictEqual(fn('Schema generation failed: stdout: API Error: Unable to connect to API (UND_ERR_SOCKET)'), true,
  'real-world UND_ERR_SOCKET 必须 non-retryable');
console.log('  ✓ real-world: UND_ERR_SOCKET → non-retryable');

assert.strictEqual(fn('Schema generation failed: UND_ERR_SOCKET'), true, 'bare UND_ERR_SOCKET');
console.log('  ✓ bare UND_ERR_SOCKET');

assert.strictEqual(fn('Unable to connect to API'), true, 'case-insensitive match');
console.log('  ✓ Unable to connect to API');

// 仍然 retryable 的场景(避免误伤)
assert.strictEqual(fn('schema returned partial json'), false, 'partial JSON 应该 retry');
assert.strictEqual(fn('schema malformed'), false);
assert.strictEqual(fn(''), false);
assert.strictEqual(fn(null), false);
console.log('  ✓ regression-guard: partial/malformed/empty 仍 retry');

// 既有 non-retryable 的不要被破坏
assert.strictEqual(fn('Timed out after 600000ms; Exit code 143'), true);
assert.strictEqual(fn('MODEL_FATAL: Codex text runner auth/quota exceeded'), true);
console.log('  ✓ pre-existing non-retryable 保留');

console.log('\ncodegen-schema non-retryable: 7 cases passed');
