var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    int ' + v + 'HP = ' + npc.params.hp + ';');
  lines.push('    int ' + v + 'LastHP = ' + npc.params.hp + ';');
  lines.push('    int ' + v + 'State = 0; // 0=patrol, 1=flee, 2=dead');
  lines.push('    float ' + v + 'FleeTimer = 0f;');
  lines.push('    float ' + v + 'PatrolTimer = 0f;');
  lines.push('    Vector3 ' + v + 'PatrolTarget;');
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
  lines.push('        if (' + v + 'State == 2) return;');
  lines.push('        if (' + v + 'HP <= 0) {');
  lines.push('            ' + v + 'State = 2;');
  lines.push('            if (' + v + ' != null) HideObj(' + v + ');');
  lines.push('            enemiesDefeated++;');
  lines.push('            return;');
  lines.push('        }');
  lines.push('        if (' + v + ' == null) return;');
  lines.push('        if (' + v + 'HP < ' + v + 'LastHP) {');
  lines.push('            ' + v + 'State = 1;');
  lines.push('            ' + v + 'FleeTimer = ' + p.fleeDuration + 'f;');
  lines.push('        }');
  lines.push('        ' + v + 'LastHP = ' + v + 'HP;');
  lines.push('        if (' + v + 'State == 1) {');
  lines.push('            Vector3 dir = (' + v + '.transform.position - player.transform.position).normalized;');
  lines.push('            ' + v + '.transform.position += dir * ' + p.fleeSpeed + 'f * dt;');
  lines.push('            ' + v + 'FleeTimer -= dt;');
  lines.push('            if (' + v + 'FleeTimer <= 0f) {');
  lines.push('                ' + v + 'State = 0;');
  lines.push('            }');
  lines.push('        }');
  lines.push('        if (' + v + 'State == 0) {');
  lines.push('            ' + v + 'PatrolTimer -= dt;');
  lines.push('            if (' + v + 'PatrolTimer <= 0f) {');
  lines.push('                ' + v + 'PatrolTarget = ' + v + '.transform.position + new Vector3(');
  lines.push('                    UnityEngine.Random.Range(-' + p.patrolRadius + 'f, ' + p.patrolRadius + 'f), 0f,');
  lines.push('                    UnityEngine.Random.Range(-' + p.patrolRadius + 'f, ' + p.patrolRadius + 'f));');
  lines.push('                ' + v + 'PatrolTimer = 3f;');
  lines.push('            }');
  lines.push('            Vector3 patrolDir = (' + v + 'PatrolTarget - ' + v + '.transform.position).normalized;');
  lines.push('            ' + v + '.transform.position += patrolDir * ' + p.moveSpeed + 'f * dt;');
  lines.push('        }');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
