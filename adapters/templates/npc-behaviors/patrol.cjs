var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    Vector3 ' + v + 'PatrolTarget;');
  lines.push('    float ' + v + 'PatrolTimer = 0f;');
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
  lines.push('        ' + v + 'PatrolTimer -= dt;');
  lines.push('        if (' + v + 'PatrolTimer <= 0f) {');
  lines.push('            ' + v + 'PatrolTarget = ' + v + '.transform.position + new Vector3(');
  lines.push('                UnityEngine.Random.Range(-' + p.patrolRadius + 'f, ' + p.patrolRadius + 'f), 0f,');
  lines.push('                UnityEngine.Random.Range(-' + p.patrolRadius + 'f, ' + p.patrolRadius + 'f));');
  lines.push('            ' + v + 'PatrolTimer = 3f;');
  lines.push('        }');
  lines.push('        Vector3 dir = (' + v + 'PatrolTarget - ' + v + '.transform.position).normalized;');
  lines.push('        ' + v + '.transform.position += dir * ' + p.moveSpeed + 'f * dt;');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
