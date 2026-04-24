const assert = require('assert');

const helpers = require('../engine/helpers.cjs');

{
  const html = '<html><body><canvas id="application-canvas"></canvas></body></html>';
  const out = helpers.injectGameStateBridgeHtml(html);
  assert.match(out, /__AUTOPLAY_ON__/);
  assert.match(out, /__CUA_OBSERVER_READY__/);
  assert.match(out, /_observerReadyFlagCreated/);
  assert.match(out, /window\.__gameState/);
  assert.ok(out.indexOf('</body>') > out.indexOf('__CUA_OBSERVER_READY__'));
}

{
  const html = Buffer.from('<html><body>ok</body></html>', 'utf8');
  const out = helpers.injectGameStateBridgeHtml(html);
  assert.ok(Buffer.isBuffer(out));
  const text = out.toString('utf8');
  assert.match(text, /__AUTOPLAY_ON__/);
  assert.match(text, /__CUA_OBSERVER_READY__/);
}

{
  const html = helpers.injectGameStateBridgeHtml('<html><body>once</body></html>');
  const out = helpers.injectGameStateBridgeHtml(html);
  assert.strictEqual(out, html);
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
