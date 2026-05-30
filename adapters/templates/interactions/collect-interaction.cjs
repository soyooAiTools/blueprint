var { toLowerCamel, hasEntityRef } = require('../trigger-codegen.cjs');
var { resourceIdExpr } = require('../resource-ids.cjs');

function escapeString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function generateCollectUpdate(schema) {
  var resources = schema.resources || [];
  var gc = schema.gameConfig || {};
  var collectRange = gc.collectRange || 2;
  var maxCarry = gc.maxCarry || 10;
  if (resources.length === 0) return '';

  var lines = [];
  for (var i = 0; i < resources.length; i++) {
    var r = resources[i];
    if (!r || !r.name || !hasEntityRef(r.entity)) continue;
    var entity = toLowerCamel(r.entity);
    var entityRaw = r.entity;
    var cap = r.maxStock || maxCarry;
    lines.push('        // Collection gate: player must be near a still-visible source; collected sources stay hidden like the source HTML.');
    lines.push('        if (_collectCooldown <= 0f && ' + entity + ' != null && ' + entity + '.transform.position.y > -900f && IsNear(' + entity + ', ' + collectRange + 'f)) {');
    lines.push('            // Capacity gate: collect only while the resource stack is below its configured cap.');
    lines.push('            if (GetResource(' + resourceIdExpr(r.name) + ') < ' + cap + ') {');
    lines.push('                AddResource(' + resourceIdExpr(r.name) + ', 1);');
    lines.push('                _collectCooldown = collectCooldownInterval;');
    lines.push('                ' + entity + 'Done = true;');
    lines.push('                HideObj(' + entity + '); // observable move — satisfies EntityAdvanced() phase-exit gate');
    lines.push('            }');
    lines.push('        }');
    if (i < resources.length - 1) lines.push('');
  }
  return lines.join('\n');
}

function generateCollectVariables(schema) {
  var resources = schema.resources || [];
  var lines = [];
  for (var i = 0; i < resources.length; i++) {
    var r = resources[i];
    if (!r || !r.name || !hasEntityRef(r.entity)) continue;
    var entityRaw = r.entity;
    lines.push('    // [SKELETON] ' + entityRaw + ' 采集后保持隐藏,与 storyboard2html 源 HTML 的 sourceHidden 行为一致。');
  }
  return lines.length ? lines.join('\n') : '';
}

module.exports = { generateCollectUpdate: generateCollectUpdate, generateCollectVariables: generateCollectVariables };
