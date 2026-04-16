/**
 * Codegen stage router — dispatches to schema or legacy codegen.
 * Default: schema mode. Set ctx.blueprint.useSchemaCodegen = false for legacy.
 */

var codegenSchema = require('./codegen-schema.cjs');
var codegenLegacy = require('./codegen-legacy.cjs');

module.exports = {
  name: 'codegen',
  canRetry: true,
  execute: function(ctx) {
    var useSchema = ctx.blueprint.useSchemaCodegen !== false;
    ctx.addLog('codegen', 'Mode: ' + (useSchema ? 'schema' : 'legacy'));
    if (useSchema) {
      return codegenSchema.execute(ctx);
    }
    return codegenLegacy.execute(ctx);
  }
};
