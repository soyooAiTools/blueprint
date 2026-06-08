const assert = require('assert');

const { patchForHeadless, buildPlayableAgentPreviewUrl } = require('../worker/worker-playableagent.js');

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

console.log('worker playableagent patch tests passed');
