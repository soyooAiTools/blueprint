'use strict';

var {
  buildSourceVisualIrFromSourceSceneIr,
} = require('../../engine/source-visual-ir.cjs');
var {
  normalizeSourceSceneIr,
  validateSourceSceneIr,
} = require('../../engine/source-scene-ir.cjs');

function compileSourceVisualIr(sourceIr, options) {
  options = options || {};
  var ir = normalizeSourceSceneIr(sourceIr, options);
  validateSourceSceneIr(ir);
  return buildSourceVisualIrFromSourceSceneIr(ir, options);
}

module.exports = {
  compileSourceVisualIr: compileSourceVisualIr,
};
