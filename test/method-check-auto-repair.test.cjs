const assert = require('assert');

const methodCheck = require('../engine/stages/method-check.cjs');

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    GameObject Worker1;',
      '    void Update()',
      '    {',
      '        AutoWorkerTick(Worker1, ref _carry, ref _state);',
      '    }',
      '    int _carry;',
      '    int _state;',
      '}',
    ].join('\n'),
    extraFiles: {},
  };

  const beforeMissing = methodCheck.checkCompleteness(ctx.csCode, ctx.extraFiles);
  assert.deepStrictEqual(beforeMissing, ['AutoWorkerTick']);

  const changed = methodCheck.injectMissingHelpers(ctx, beforeMissing);
  assert.strictEqual(changed, true);
  assert.match(ctx.csCode, /void AutoWorkerTick\(GameObject worker, ref int carry, ref int state\)/);

  const afterMissing = methodCheck.checkCompleteness(ctx.csCode, ctx.extraFiles);
  assert.deepStrictEqual(afterMissing, []);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    void Update()',
      '    {',
      '        ShowCTA();',
      '    }',
      '}',
    ].join('\n'),
    extraFiles: {},
  };
  const missing = methodCheck.checkCompleteness(ctx.csCode, ctx.extraFiles);
  assert.deepStrictEqual(missing, []);
  const changed = methodCheck.injectMissingHelpers(ctx, missing);
  assert.strictEqual(changed, false);
}

console.log('method-check auto-repair tests passed');
