const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  patchForHeadless,
  buildPlayableAgentPreviewUrl,
  buildHasSourceIrVisual,
} = require('../worker/worker-playableagent.js');

const normal = patchForHeadless([
  'if (this.phaseTimer >= 12.0) this.EnterPhase(1, "phase2", true, true);',
  'if (this.phaseTimer >= 90.0 && this.TryReportStuckPhase()) return;',
].join('\n'), 'index.html').content;

assert.ok(normal.includes('this.phaseTimer >= 2.0) this.EnterPhase'));
assert.ok(normal.includes('this.phaseTimer >= 90.0 && this.TryReportStuckPhase()'));

const previewUrl = buildPlayableAgentPreviewUrl(1234, 'index.html', 'autoplay=1');
assert.strictEqual(
  previewUrl,
  'http://127.0.0.1:1234/index.html?autoplay=1&sourceOverlay=0&sourceRuntime=0&sourceVisual=0'
);
const manualUrl = buildPlayableAgentPreviewUrl(5678, 'iframe.html', '?manual=1&autoplay=0');
assert.strictEqual(
  manualUrl,
  'http://127.0.0.1:5678/iframe.html?manual=1&autoplay=0&sourceOverlay=0&sourceRuntime=0&sourceVisual=0'
);
const sourceIrUrl = buildPlayableAgentPreviewUrl(2345, 'index.html', 'autoplay=1', { sourceIrVisual: true });
assert.strictEqual(
  sourceIrUrl,
  'http://127.0.0.1:2345/index.html?autoplay=1&sourceOverlay=1'
);
assert.ok(sourceIrUrl.indexOf('sourceVisual=0') < 0, 'SourceIR CUA must not disable the delivered source visual layer');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-source-ir-visual-'));
fs.writeFileSync(path.join(tmp, 'index.html'), '<script>window.__BP_SOURCE_IR__ = {};</script>');
assert.strictEqual(buildHasSourceIrVisual(tmp, 'index.html'), true);
const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-legacy-visual-'));
fs.writeFileSync(path.join(legacy, 'index.html'), '<html></html>');
assert.strictEqual(buildHasSourceIrVisual(legacy, 'index.html'), false);

console.log('worker playableagent patch tests passed');
