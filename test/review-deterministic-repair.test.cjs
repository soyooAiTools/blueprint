const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const reviewFile = '/opt/blueprint-editor/engine/stages/review.cjs';
const source = fs.readFileSync(reviewFile, 'utf8');

function extractFunction(name) {
  const sig = 'function ' + name + '(';
  const start = source.indexOf(sig);
  if (start < 0) throw new Error('Missing function ' + name);
  let i = source.indexOf('{', start) + 1;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return source.slice(start, i);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  extractFunction('rewriteHotPathVectorAllocations'),
  extractFunction('normalizeSetScaleCalls'),
  extractFunction('stripInteractionFlagShortcutsFromPhaseGates'),
  extractFunction('shouldUsePatchRecode'),
].join('\n'), sandbox);

{
  const result = sandbox.rewriteHotPathVectorAllocations(
    'void Update(){ foo.transform.position += new Vector3(1f, 0, -2f); ' +
    'Vector3 p = bar.transform.position + new Vector3(0, 3f, 0); ' +
    'baz.transform.position = new Vector3(baz.transform.position.x + 1f, baz.transform.position.y, baz.transform.position.z - 4f); }'
  );
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /foo\.transform\.position = __hpPos1;/);
  assert.match(result.code, /Vector3 p = bar\.transform\.position; p\.y \+= 3f;/);
  assert.match(result.code, /baz\.transform\.position = __hpPos3;/);
  assert.doesNotMatch(result.code, /foo\.transform\.position \+= new Vector3/);
}

{
  const result = sandbox.normalizeSetScaleCalls(
    'void Apply(){ SetScale(Player, scale, scale, scale); SetScale(Crate, 1f, 2f, 3f, 1f); }'
  );
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /SetScale\(Player, scale\);/);
  assert.match(result.code, /SetScale\(Crate, 1f, 2f, 3f\);/);
  assert.doesNotMatch(result.code, /SetScale\(Player, scale, scale, scale\)/);
  assert.doesNotMatch(result.code, /SetScale\(Crate, 1f, 2f, 3f, 1f\)/);
}

{
  const result = sandbox.stripInteractionFlagShortcutsFromPhaseGates(
    'if (!ruleTriggered[2] && (EntityAdvanced(Box, _snap_BoxPos) || boxDone || harvestPlayerActed) && phaseTimer > 3f) {}',
    { specs: [{ phaseId: 'a' }, { phaseId: 'b' }, { phaseId: 'c' }, { phaseId: 'd' }] }
  );
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /\(EntityAdvanced\(Box, _snap_BoxPos\)\)/);
  assert.doesNotMatch(result.code, /boxDone|harvestPlayerActed/);
}

{
  assert.strictEqual(sandbox.shouldUsePatchRecode({
    source: 'static-precheck',
    issues: [{ line: 10, rule: 'phase-entity-init-only' }],
  }), false);
  assert.strictEqual(sandbox.shouldUsePatchRecode({
    source: 'codex-review',
    issues: [{ line: 10, rule: 'custom-warning' }],
  }), true);
}

console.log('review deterministic repair tests passed');
