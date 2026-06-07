const assert = require('assert');

const helpers = require('../engine/helpers.cjs');

{
  const html = '<html><body><canvas id="application-canvas"></canvas></body></html>';
  const out = helpers.injectGameStateBridgeHtml(html);
  assert.match(out, /__AUTOPLAY_ON__/);
  assert.match(out, /__CUA_OBSERVER_READY__/);
  assert.match(out, /manual-default-autoplay-param-v1/);
  assert.doesNotMatch(out, /_publicPreviewAutoPlay/);
  assert.match(out, /_autoPlayRequested=_cuaAutoPlayRequested/);
  assert.match(out, /_cuaAutoPlayRequested=_autoplayParam==='1'&&!_manualRequested/);
  assert.match(out, /_observerReadyRequested=_params\.get\('observerReady'\)==='1'\|\|_params\.get\('cuaObserverReady'\)==='1'/);
  assert.match(out, /_autoplayParam==='0'\|\|_params\.get\('manual'\)==='1'/);
  assert.match(out, /function syncUnityAbsoluteUrl\(\)/);
  assert.match(out, /syncUnityAbsoluteUrl\(\);\s*function createRuntimeFlag/);
  assert.match(out, /function createRuntimeFlag\(name\)/);
  assert.match(out, /UnityEngine\.Application\.absoluteURL=window\.location\.href/);
  assert.match(out, /var made=false;\s*syncUnityAbsoluteUrl\(\);/);
  assert.match(out, /new UnityEngine\.GameObject\.\$ctor2\(name\)/);
  assert.match(out, /_autoPlayFlagCreated=createRuntimeFlag\('__AUTOPLAY_ON__'\)/);
  assert.match(out, /window\.__CUA_OBSERVER_READY__ = !!window\.__CUA_OBSERVER_READY__ \|\| _observerReadyRequested/);
  assert.match(out, /_observerReadyFlagCreated/);
  assert.match(out, /window\.__gameState/);
  assert.match(out, /scoreState/);
  assert.match(out, /completedPhases/);
  assert.match(out, /window\.__gameState=best\.state/);
  assert.ok(out.indexOf('</body>') > out.indexOf('__CUA_OBSERVER_READY__'));
}

{
  const html = Buffer.from('<html><body>ok</body></html>', 'utf8');
  const out = helpers.injectGameStateBridgeHtml(html);
  assert.ok(Buffer.isBuffer(out));
  const text = out.toString('utf8');
  assert.match(text, /__AUTOPLAY_ON__/);
  assert.match(text, /__CUA_OBSERVER_READY__/);
  assert.match(text, /manual-default-autoplay-param-v1/);
}

{
  const html = helpers.injectGameStateBridgeHtml('<html><body>once</body></html>');
  const out = helpers.injectGameStateBridgeHtml(html);
  assert.strictEqual(out, html);
}

{
  const oldBridge = [
    '<html><body>',
    '<script>',
    '(function(){',
    '  var _autoPlayFlagCreated=false;',
    '  var _observerReadyFlagCreated=false;',
    '  window.__CUA_OBSERVER_READY__ = !!window.__CUA_OBSERVER_READY__;',
    '  function scan(node,best){return best;}',
    '  window.__gameState=best.state;',
    '})();',
    '</script>',
    '</body></html>',
  ].join('');
  const out = helpers.injectGameStateBridgeHtml(oldBridge);
  assert.notStrictEqual(out, oldBridge);
  assert.match(out, /manual-default-autoplay-param-v1/);
  assert.doesNotMatch(out, /public-preview-autoplay-v1/);
  assert.ok(out.indexOf('manual-default-autoplay-param-v1') > out.indexOf('_autoPlayFlagCreated=false'));
}

{
  const base = [
    '<html><body>',
    '<script>',
    'if (!this._observerReady && GameObject.Find("__CUA_OBSERVER_READY__") != null) { this._observerReady = true; }',
    '</script>',
    '</body></html>',
  ].join('');
  const out = helpers.injectGameStateBridgeHtml(base);
  assert.match(out, /_observerReadyFlagCreated/);
  assert.match(out, /window\.__CUA_OBSERVER_READY__ = !!window\.__CUA_OBSERVER_READY__/);
}

console.log('build-html bridge tests passed');
