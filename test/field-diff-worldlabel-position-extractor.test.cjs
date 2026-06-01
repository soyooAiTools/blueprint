#!/usr/bin/env node
'use strict';

// v1.4e Stage 4: WEBGL extractor surfaces target world-label screen rects in
// observed.worldLabels so Stage 5 can diff projectedWorldLabels without reading
// private DOM state.

var assert = require('assert');
var fd = require('../engine/stages/lib/field-diff.cjs');

function withGlobals(windowValue, documentValue, fn) {
  var prevWindow = global.window;
  var prevDocument = global.document;
  global.window = windowValue;
  global.document = documentValue;
  try {
    return fn();
  } finally {
    global.window = prevWindow;
    global.document = prevDocument;
  }
}

var extractor = fd.WEBGL_PAGE_EXTRACTOR;

// Bridge path: worker exposes baseline-coordinate rects at __targetWorldLabels.
var bridgeOut = withGlobals({
  innerWidth: 1280,
  innerHeight: 720,
  __gameState: { entity_states: { Player: { visible: true } } },
  __targetWorldLabels: {
    Player: { x: 100, y: 42, width: 64, height: 24, centerX: 132, centerY: 54 }
  }
}, {
  querySelector: function() { return null; },
  querySelectorAll: function() { return []; }
}, function() {
  return extractor({ phaseId: 'phase1' });
});

assert.deepStrictEqual(bridgeOut.worldLabels.Player, {
  text: undefined,
  x: 100,
  y: 42,
  width: 64,
  height: 24,
  centerX: 132,
  centerY: 54,
  visible: true
});
assert.strictEqual(bridgeOut.entityDetails.Player && bridgeOut.entityDetails.Player.worldLabel, undefined,
  'strict runtime bridge should not leak text; DOM extraction owns the existing text bucket');

// DOM fallback path: normalize viewport rect back to the 1280x720 contract
// baseline when the worker bridge is absent.
var domEl = {
  textContent: '飞船',
  getAttribute: function(name) { return name === 'data-entity' ? 'SpaceShip' : null; },
  getBoundingClientRect: function() {
    return { left: 50, top: 20, width: 100, height: 30 };
  }
};
var domOut = withGlobals({
  innerWidth: 640,
  innerHeight: 360,
  __gameState: { entity_states: { SpaceShip: { visible: true } } },
  getComputedStyle: function() { return { display: 'block', visibility: 'visible', opacity: '1' }; }
}, {
  querySelector: function() { return null; },
  querySelectorAll: function(sel) {
    return sel === '#bp-storyboard-worldlabels .bp-worldlabel[data-entity]' ? [domEl] : [];
  }
}, function() {
  return extractor({ phaseId: 'phase1' });
});

assert.deepStrictEqual(domOut.worldLabels.SpaceShip, {
  text: '飞船',
  x: 100,
  y: 40,
  width: 200,
  height: 60,
  centerX: 200,
  centerY: 70,
  visible: true
});
assert.strictEqual(domOut.entityDetails.SpaceShip.worldLabel, '飞船',
  'DOM fallback should keep text bucket compatibility');

console.log('field-diff-worldlabel-position-extractor.test.cjs PASS');
