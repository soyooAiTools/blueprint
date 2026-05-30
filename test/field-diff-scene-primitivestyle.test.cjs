#!/usr/bin/env node
'use strict';

// task #45 (v1.3): field-diff lib coverage for the two new v1.3 buckets:
//   - scene bucket: contract.scene.backgroundColor vs observed.scene.backgroundColor
//   - primitiveStyle bucket: contract.entities[].primitiveStyle vs observed.entityDetails[id].primitiveStyle
// Both blocking by design (#46 writer overlay MUST render bg + styled mesh+material).
//
// Asserts:
//   1. diffSceneBucket — emits 'missing' blocking when observed.scene is undefined
//   2. diffSceneBucket — emits 'mismatch' blocking on componentwise drift outside epsilon
//   3. diffSceneBucket — empty on clean match (within FLOAT_EPSILON)
//   4. diffSceneBucket — pre-v1.3 contract (no scene block) returns []
//   5. diffPrimitiveStyleBucket — 'missing' when entity visible but observed primitiveStyle absent
//   6. diffPrimitiveStyleBucket — 'mismatch' on modelRef byte-mismatch
//   7. diffPrimitiveStyleBucket — 'mismatch' on baseColor componentwise drift
//   8. diffPrimitiveStyleBucket — empty on clean match
//   9. diffPrimitiveStyleBucket — entity-not-visible skipped (entities bucket owns it)
//  10. diffPrimitiveStyleBucket — entity without contract primitiveStyle skipped
//  11. runFieldLevelDiff shim flattens scene-* and primitiveStyle-* with blocking:true
//  12. summarize() bucketTotals tracks scene + primitiveStyle keys
//  13. WEBGL extractor reads worker __storyboardEntityDetails primitiveStyle bridge
//  14. primitiveStyle canonical merge keeps runtime detail when v1.4e bridge
//      also emits source-key geometry-only detail
//  15. WEBGL extractor prioritizes worker __storyboardSceneDetails scene bridge

var assert = require('assert');
var fd = require('../engine/stages/lib/field-diff.cjs');

function v13Contract(opts) {
  opts = opts || {};
  return {
    schemaVersion: '1.3.0',
    scene: opts.scene === null ? undefined : (opts.scene || { backgroundColor: [0.0275, 0.0627, 0.149] }),
    phases: [{ id: 'phase1', showEntities: opts.showEntities || ['_player'] }],
    entities: opts.entities || [{
      id: 'Player',
      primitiveStyle: { modelRef: 'astronaut', baseColor: [0.9098, 0.9843, 1] }
    }],
    hud: []
  };
}

// ─── case 1: scene missing → blocking missing entry ────────────────────────────
var idx1 = fd.indexContract(v13Contract());
var sc1 = fd.diffSceneBucket(idx1, 'phase1', { visibleEntities: ['Player'] });
assert.strictEqual(sc1.length, 1, 'scene missing must emit one entry');
assert.strictEqual(sc1[0].status, 'missing');
assert.strictEqual(sc1[0].blocking, true);
assert.strictEqual(sc1[0].key, 'backgroundColor');

// ─── case 2: scene mismatch outside epsilon → blocking mismatch ────────────────
var sc2 = fd.diffSceneBucket(idx1, 'phase1', {
  visibleEntities: ['Player'],
  scene: { backgroundColor: [0.5, 0.5, 0.5] }
});
assert.strictEqual(sc2.length, 1);
assert.strictEqual(sc2[0].status, 'mismatch');
assert.strictEqual(sc2[0].blocking, true);

// ─── case 3: scene match (within epsilon) → empty ──────────────────────────────
var sc3 = fd.diffSceneBucket(idx1, 'phase1', {
  visibleEntities: ['Player'],
  scene: { backgroundColor: [0.02750001, 0.06270001, 0.149] } // sub-epsilon drift
});
assert.strictEqual(sc3.length, 0, 'sub-epsilon match must produce no entries');

// ─── case 4: pre-v1.3 contract (no scene) → empty ──────────────────────────────
var idx4 = fd.indexContract(v13Contract({ scene: null }));
var sc4 = fd.diffSceneBucket(idx4, 'phase1', { visibleEntities: ['Player'] });
assert.strictEqual(sc4.length, 0, 'contract without scene block must produce no entries');

// ─── case 5: primitiveStyle missing on visible entity → blocking missing ───────
var ps5 = fd.diffPrimitiveStyleBucket(idx1, 'phase1', {
  visibleEntities: ['Player'], entityDetails: { Player: {} }
});
assert.strictEqual(ps5.length, 1);
assert.strictEqual(ps5[0].status, 'missing');
assert.strictEqual(ps5[0].entityId, 'Player');
assert.strictEqual(ps5[0].blocking, true);

// ─── case 6: modelRef byte mismatch → blocking mismatch ────────────────────────
var ps6 = fd.diffPrimitiveStyleBucket(idx1, 'phase1', {
  visibleEntities: ['Player'],
  entityDetails: { Player: { primitiveStyle: { modelRef: 'box', baseColor: [0.9098, 0.9843, 1] } } }
});
assert.strictEqual(ps6.length, 1);
assert.strictEqual(ps6[0].status, 'mismatch');
assert.ok(ps6[0].diffPaths.some(function(d) { return d.path === '$.primitiveStyle.modelRef'; }),
  'expected diffPath for modelRef');

// ─── case 7: baseColor drift → blocking mismatch ───────────────────────────────
var ps7 = fd.diffPrimitiveStyleBucket(idx1, 'phase1', {
  visibleEntities: ['Player'],
  entityDetails: { Player: { primitiveStyle: { modelRef: 'astronaut', baseColor: [0.1, 0.1, 0.1] } } }
});
assert.strictEqual(ps7.length, 1);
assert.strictEqual(ps7[0].status, 'mismatch');
assert.ok(ps7[0].diffPaths.some(function(d) { return d.path === '$.primitiveStyle.baseColor'; }),
  'expected diffPath for baseColor');

// ─── case 8: clean primitiveStyle match → empty ────────────────────────────────
var ps8 = fd.diffPrimitiveStyleBucket(idx1, 'phase1', {
  visibleEntities: ['Player'],
  entityDetails: { Player: { primitiveStyle: { modelRef: 'astronaut', baseColor: [0.9098, 0.9843, 1] } } }
});
assert.strictEqual(ps8.length, 0, 'clean match must produce no entries');

// ─── case 9: entity-not-visible skipped (entities bucket owns it) ──────────────
var ps9 = fd.diffPrimitiveStyleBucket(idx1, 'phase1', {
  visibleEntities: [], entityDetails: {}
});
assert.strictEqual(ps9.length, 0, 'invisible entity skipped — entities bucket flags absence');

// ─── case 10: entity without contract primitiveStyle skipped ───────────────────
var idx10 = fd.indexContract(v13Contract({
  entities: [{ id: 'Player' /* no primitiveStyle */ }]
}));
var ps10 = fd.diffPrimitiveStyleBucket(idx10, 'phase1', {
  visibleEntities: ['Player'], entityDetails: { Player: {} }
});
assert.strictEqual(ps10.length, 0, 'no contract primitiveStyle → no diff');

// ─── case 11: runFieldLevelDiff shim flattens with blocking:true ───────────────
var template = fd.makeTemplateFromContract(v13Contract());
var flat = fd.runFieldLevelDiff(template, 'phase1',
  { visibleEntities: ['Player'] }, // source — unused by current shim impl
  { visibleEntities: ['Player'], entityDetails: { Player: {} } }
);
var sceneFlat = flat.filter(function(e) { return e.category === 'scene-missing'; });
var psFlat = flat.filter(function(e) { return e.category === 'primitiveStyle-missing'; });
assert.strictEqual(sceneFlat.length, 1, 'scene-missing flattens through shim');
assert.strictEqual(sceneFlat[0].blocking, true);
assert.strictEqual(sceneFlat[0].path, 'scene.backgroundColor');
assert.strictEqual(psFlat.length, 1, 'primitiveStyle-missing flattens through shim');
assert.strictEqual(psFlat[0].blocking, true);
assert.strictEqual(psFlat[0].path, 'primitiveStyle.Player');

// ─── case 12: summarize() bucketTotals tracks new buckets ──────────────────────
var perPhase = [{
  phaseId: 'phase1',
  buckets: {
    entities: [], phases: [], hud: [], worldLabel: [],
    scene: [{ blocking: true }],
    primitiveStyle: [{ blocking: true }, { blocking: true }]
  }
}];
var sum = fd.summarize(perPhase);
assert.strictEqual(sum.buckets.scene, 1, 'summarize tracks scene bucket count');
assert.strictEqual(sum.buckets.primitiveStyle, 2, 'summarize tracks primitiveStyle bucket count');
assert.strictEqual(sum.blocking, 3, 'blocking count includes scene + primitiveStyle');

// ─── case 13: WEBGL extractor consumes worker primitiveStyle bridge ────────────
var template13 = fd.makeTemplateFromContract(v13Contract());
var prevWindow = global.window;
var prevDocument = global.document;
global.window = {
  __gameState: { entity_states: { Player: { visible: true } } },
  __storyboardEntityDetails: {
    Player: {
      primitiveStyle: { modelRef: 'astronaut', baseColor: [0.9098, 0.9843, 1] },
      visualKind: 'styled-composite:astronaut',
      primitiveCount: 7
    }
  }
};
global.document = {
  querySelector: function() { return null; }
};
var extracted13;
try {
  extracted13 = template13.WEBGL_PAGE_EXTRACTOR({ phaseId: 'phase1' });
} finally {
  global.window = prevWindow;
  global.document = prevDocument;
}
assert.deepStrictEqual(extracted13.entityDetails.Player.primitiveStyle,
  { modelRef: 'astronaut', baseColor: [0.9098, 0.9843, 1] },
  'WEBGL extractor should read worker primitiveStyle bridge');
assert.strictEqual(extracted13.entityDetails.Player.visualKind, 'styled-composite:astronaut');
assert.strictEqual(extracted13.entityDetails.Player.primitiveCount, 7);
assert.strictEqual(fd.diffPrimitiveStyleBucket(idx1, 'phase1', extracted13).length, 0,
  'worker bridge detail should clear primitiveStyle bucket');

// ─── case 14: source-key worldLabel geometry detail must not clobber style ─────
var styleThenGeometry = {
  visibleEntities: ['Player'],
  entityDetails: {
    Player: { primitiveStyle: { modelRef: 'astronaut', baseColor: [0.9098, 0.9843, 1] } },
    _player: {}
  }
};
var geometryThenStyle = {
  visibleEntities: ['Player'],
  entityDetails: {
    _player: {},
    Player: { primitiveStyle: { modelRef: 'astronaut', baseColor: [0.9098, 0.9843, 1] } }
  }
};
assert.strictEqual(fd.diffPrimitiveStyleBucket(idx1, 'phase1', styleThenGeometry).length, 0,
  'canonical merge must preserve primitiveStyle when v1.4e bridge adds empty source-key detail');
assert.strictEqual(fd.diffPrimitiveStyleBucket(idx1, 'phase1', geometryThenStyle).length, 0,
  'canonical merge must be stable when source-key detail is observed before runtime style detail');

// Canonical-like extractor fixture: DOM world-label detail at Player,
// strict Stage 5 geometry bridge at _player, and primitiveStyle bridge at Player.
var labelEl = {
  textContent: '玩家',
  getAttribute: function(name) { return name === 'data-entity' ? 'Player' : null; },
  getBoundingClientRect: function() {
    return { left: 100, top: 120, width: 48, height: 20 };
  }
};
global.window = {
  innerWidth: 1280,
  innerHeight: 720,
  __gameState: { entity_states: { Player: { visible: true } } },
  __targetWorldLabels: {
    _player: { x: 100, y: 120, width: 48, height: 20, centerX: 124, centerY: 130 }
  },
  __storyboardEntityDetails: {
    Player: {
      primitiveStyle: { modelRef: 'astronaut', baseColor: [0.9098, 0.9843, 1] },
      visualKind: 'styled-composite:astronaut',
      primitiveCount: 7
    }
  },
  getComputedStyle: function() { return { display: 'block', visibility: 'visible', opacity: '1' }; }
};
global.document = {
  querySelector: function() { return null; },
  querySelectorAll: function(sel) {
    return sel === '#bp-storyboard-worldlabels .bp-worldlabel[data-entity]' ? [labelEl] : [];
  }
};
var extracted14;
try {
  extracted14 = template13.WEBGL_PAGE_EXTRACTOR({ phaseId: 'phase1' });
} finally {
  global.window = prevWindow;
  global.document = prevDocument;
}
assert.ok(extracted14.entityDetails.Player && extracted14.entityDetails.Player.primitiveStyle,
  'canonical-like extractor fixture should include runtime primitiveStyle detail');
assert.ok(extracted14.entityDetails._player,
  'canonical-like extractor fixture should include source-key worldLabel geometry detail');
assert.strictEqual(fd.diffPrimitiveStyleBucket(idx1, 'phase1', extracted14).length, 0,
  'canonical merge must clear primitiveStyle with real Player + _player extractor shape');

// ─── case 15: WEBGL extractor consumes worker scene bridge ────────────────────
global.window = {
  __gameState: { entity_states: { Player: { visible: true } } },
  __storyboardSceneDetails: {
    backgroundColor: [0.0275, 0.0627, 0.149],
    source: 'fidelityContract.scene.backgroundColor'
  }
};
global.document = {
  getElementById: function() {
    return {
      width: 100,
      height: 100,
      getContext: function() {
        return {
          RGBA: 0,
          UNSIGNED_BYTE: 0,
          readPixels: function(x, y, w, h, fmt, typ, pix) {
            pix[0] = 255; pix[1] = 0; pix[2] = 0; pix[3] = 255;
          }
        };
      }
    };
  },
  querySelector: function() { return null; },
  querySelectorAll: function() { return []; }
};
var extracted14;
try {
  extracted14 = template13.WEBGL_PAGE_EXTRACTOR({ phaseId: 'phase1' });
} finally {
  global.window = prevWindow;
  global.document = prevDocument;
}
assert.deepStrictEqual(extracted14.scene.backgroundColor, [0.0275, 0.0627, 0.149],
  'WEBGL extractor should prefer worker scene bridge over occlusion-prone canvas samples');
assert.strictEqual(fd.diffSceneBucket(idx1, 'phase1', extracted14).length, 0,
  'worker scene bridge should clear scene bucket');

console.log('field-diff-scene-primitivestyle.test.cjs PASS');
