const assert = require('assert');

const { patchForHeadless } = require('../worker/worker-playableagent.js');

const normal = patchForHeadless([
  'if (this.phaseTimer >= 12.0) this.EnterPhase(1, "phase2", true, true);',
  'if (this.phaseTimer >= 90.0 && this.TryReportStuckPhase()) return;',
].join('\n'), 'index.html').content;

assert.ok(normal.includes('this.phaseTimer >= 2.0) this.EnterPhase'));
assert.ok(normal.includes('this.phaseTimer >= 90.0 && this.TryReportStuckPhase()'));

console.log('worker playableagent patch tests passed');
