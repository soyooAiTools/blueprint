var assert = require('assert');
var review = require('../engine/stages/review.cjs');

(function testDirectTransformPositionIsGuarded() {
  var input = [
    'partial class GameFlowManagerMain {',
    '  void F() {',
    '    ShowFloatingText(player.transform.position, "ok", Color.yellow);',
    '  }',
    '}',
  ].join('\n');
  var out = review.guardFloatingTextTransformPosition(input);
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.fixes, 1);
  assert.ok(out.code.indexOf('ShowFloatingText(player != null ? player.transform.position : Vector3.zero, "ok", Color.yellow);') >= 0);
})();

(function testOffsetTransformPositionIsGuarded() {
  var input = [
    'partial class GameFlowManagerMain {',
    '  void F() {',
    '    ShowFloatingText(Player.transform.position + new Vector3(0f, 1.8f, 0f), "tap", Color.yellow);',
    '  }',
    '}',
  ].join('\n');
  var out = review.guardFloatingTextTransformPosition(input);
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.fixes, 1);
  assert.ok(out.code.indexOf('ShowFloatingText(Player != null ? Player.transform.position + new Vector3(0f, 1.8f, 0f) : Vector3.zero, "tap", Color.yellow);') >= 0);
})();

(function testAlreadyGuardedIsNoop() {
  var input = 'ShowFloatingText(player != null ? player.transform.position : Vector3.zero, "ok", Color.yellow);';
  var out = review.guardFloatingTextTransformPosition(input);
  assert.strictEqual(out.changed, false);
  assert.strictEqual(out.code, input);
})();

(function testPlayerDistanceReadIsGuardedInVoidMethod() {
  var input = [
    'void UpdateEnemy(float dt) {',
    '    if (Enemy == null) return;',
    '    float dist = Vector3.Distance(Enemy.transform.position, player.transform.position);',
    '    Vector3 dir = (player.transform.position - Enemy.transform.position).normalized;',
    '}',
  ].join('\n');
  var out = review.guardPlayerTransformDistanceReads(input);
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.fixes, 1);
  assert.ok(out.code.indexOf('var __safePlayer = player;') >= 0);
  assert.ok(out.code.indexOf('if (__safePlayer == null || Enemy == null) return;') >= 0);
  assert.ok(out.code.indexOf('Vector3.Distance(Enemy.transform.position, __safePlayer.transform.position)') >= 0);
  assert.ok(out.code.indexOf('__safePlayer.transform.position - Enemy.transform.position') >= 0);
})();

(function testPlayerDistanceReadNoopsInValueReturnMethod() {
  var input = 'float GetDist() { return Vector3.Distance(Enemy.transform.position, player.transform.position); }';
  var out = review.guardPlayerTransformDistanceReads(input);
  assert.strictEqual(out.changed, false);
})();

var bundle = require('../engine/lib/static-rule-prerepair.cjs').SHARED_BUNDLE;
assert.ok(bundle.some(function(e) { return e[0] === 'guardFloatingTextTransformPosition' && e[1] === 'FloatingTextNullGuard'; }));
assert.ok(bundle.some(function(e) { return e[0] === 'guardPlayerTransformDistanceReads' && e[1] === 'PlayerTransformDistanceGuard'; }));

console.log('review floating text null guard: 6 cases passed');
