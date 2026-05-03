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
    var respawnVar = '_respawn_' + entityRaw;
    var cap = r.maxStock || maxCarry;
    lines.push('        // Source respawn timer: 采集后短暂隐藏，2s 后回到 initPos，保证持续可采集（不止 1 次就锁死）。');
    lines.push('        if (' + respawnVar + ' > 0f) {');
    lines.push('            ' + respawnVar + ' -= Time.deltaTime;');
    lines.push('            if (' + respawnVar + ' <= 0f && ' + entity + ' != null) {');
    lines.push('                PlaceObj(' + entity + ', _initPos_' + entityRaw + '.x, _initPos_' + entityRaw + '.y, _initPos_' + entityRaw + '.z);');
    lines.push('            }');
    lines.push('        }');
    lines.push('        // Collection gate: player must be near the source, cooldown must be ready, and source object must exist.');
    lines.push('        if (_collectCooldown <= 0f && ' + respawnVar + ' <= 0f && ' + entity + ' != null && IsNear(' + entity + ', ' + collectRange + 'f)) {');
    lines.push('            // Capacity gate: collect only while the resource stack is below its configured cap.');
    lines.push('            if (GetResource(' + resourceIdExpr(r.name) + ') < ' + cap + ') {');
    lines.push('                AddResource(' + resourceIdExpr(r.name) + ', 1);');
    lines.push('                _collectCooldown = collectCooldownInterval;');
    lines.push('                ' + entity + 'Done = true;');
    lines.push('                _initPos_' + entityRaw + ' = ' + entity + '.transform.position; // 缓存当前位置作为 respawn 锚点');
    lines.push('                HideObj(' + entity + '); // observable move — satisfies EntityAdvanced() phase-exit gate');
    lines.push('                ' + respawnVar + ' = 2.0f; // 2s 后自动回填，避免源头永久消失锁住玩法');
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
    lines.push('    // [SKELETON] 采集源 respawn 计时与位置缓存；避免单次采集后源头永久消失。');
    lines.push('    float _respawn_' + entityRaw + ' = 0f;');
    lines.push('    Vector3 _initPos_' + entityRaw + ' = Vector3.zero;');
  }
  return lines.length ? lines.join('\n') : '';
}

module.exports = { generateCollectUpdate: generateCollectUpdate, generateCollectVariables: generateCollectVariables };
