#!/usr/bin/env node
'use strict';

const assert = require('assert');

const { injectVisualOverlay } = require('../adapters/demo2spec/visual-overlay.js');

const html = '<html><body><canvas id="application-canvas"></canvas></body></html>';
const manifest = {
  sourceEntityContract: {
    entities: [],
    entityStyles: {},
    entityComposites: {
      Hero: {
        entityName: 'Hero',
        label: 'Hero',
        position: { x: 0, y: 0, z: 0 },
        primitives: [
          {
            geometry: { type: 'BoxGeometry', args: [1, 1, 1] },
            material: { diffuseColor: '#3B82F6' },
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
      },
    },
  },
  sourcePhaseContract: {
    phaseCount: 1,
    phases: [{ id: 'phase1', showEntities: ['Hero'], steps: [] }],
  },
  entityBindings: {},
  assets: [],
};

const out = injectVisualOverlay(html, manifest);

assert.notStrictEqual(out, html, 'visual overlay should still inject when entityStyles is empty');
assert.match(out, /function sourceEntityNames\(contract\)/);
assert.match(out, /Object\.keys\(composites\)/);
assert.match(out, /var names = sourceEntityNames\(contract\);/);
assert.match(out, /Three\.js source visual overlay active: entities=/);

console.log('demo2spec visual overlay tests passed');
