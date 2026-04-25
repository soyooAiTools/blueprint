const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'linux-bridge-build.js'), 'utf8');

const fallbackIdx = source.indexOf('function _dispatchStandaloneStart()');
const startGameGuardIdx = source.indexOf("typeof window.startGame !== 'function'", fallbackIdx);
const lunaStartIdx = source.indexOf('window.dispatchEvent(new Event("luna:start"))', fallbackIdx);

assert.ok(fallbackIdx >= 0, 'standalone start fallback should use a named retry function');
assert.ok(startGameGuardIdx > fallbackIdx, 'fallback should wait until startGame is parsed');
assert.ok(lunaStartIdx > startGameGuardIdx, 'luna:start should be dispatched only after the startGame guard');
assert.ok(source.includes('_sgAttempts < 240'), 'fallback should retry long enough for large inline HTML parsing');
assert.ok(!source.includes('var _sgTimer = setTimeout(function() {'), 'fallback must not fire once before startGame exists');

console.log('linux bridge start fallback tests passed');
