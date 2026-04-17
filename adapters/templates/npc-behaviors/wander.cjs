var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    float ' + v + 'WanderTimer = 0f;');
  lines.push('    Vector3 ' + v + 'WanderDir;');
  lines.push('    Vector3 ' + v + 'StartPos;');
  return lines.join('\n');
}

function generateUpdate(npc) {
  return '        Update' + npc.entity + '(Time.deltaTime);';
}

function generateSystem(npc) {
  var v = toLowerCamel(npc.entity);
  var p = npc.params;
  var lines = [];
  lines.push('    void Update' + npc.entity + '(float dt) {');
  lines.push('        if (' + v + ' == null) return;');
  lines.push('        if (' + v + 'StartPos == Vector3.zero) {');
  lines.push('            ' + v + 'StartPos = ' + v + '.transform.position;');
  lines.push('        }');
  lines.push('        ' + v + 'WanderTimer -= dt;');
  lines.push('        if (' + v + 'WanderTimer <= 0f) {');
  lines.push('            ' + v + 'WanderDir = new Vector3(');
  lines.push('                UnityEngine.Random.Range(-1f, 1f), 0f,');
  lines.push('                UnityEngine.Random.Range(-1f, 1f)).normalized;');
  lines.push('            ' + v + 'WanderTimer = UnityEngine.Random.Range(2.0f, 5.0f);');
  lines.push('        }');
  lines.push('        if (Vector3.Distance(' + v + '.transform.position, ' + v + 'StartPos) > ' + p.wanderRadius + 'f) {');
  lines.push('            ' + v + 'WanderDir = -' + v + 'WanderDir;');
  lines.push('        }');
  lines.push('        ' + v + '.transform.position += ' + v + 'WanderDir * ' + p.moveSpeed + 'f * dt;');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
