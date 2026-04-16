var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    int ' + v + 'HP = ' + npc.params.hp + ';');
  lines.push('    int ' + v + 'State = 0; // 0=idle, 1=chase, 2=dead');
  lines.push('    float ' + v + 'AttackTimer = 0f;');
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
  lines.push('        if (' + v + ' == null) return;');
  lines.push('        float dist = Vector3.Distance(' + v + '.transform.position, player.transform.position);');
  lines.push('        if (dist < ' + p.detectRange + 'f) {');
  lines.push('            ' + v + 'State = 1;');
  lines.push('            Vector3 dir = (player.transform.position - ' + v + '.transform.position).normalized;');
  lines.push('            ' + v + '.transform.position += dir * ' + p.moveSpeed + 'f * dt;');
  lines.push('            if (dist < ' + p.attackRange + 'f) {');
  lines.push('                ' + v + 'AttackTimer -= dt;');
  lines.push('                if (' + v + 'AttackTimer <= 0f) {');
  lines.push('                    playerHP -= ' + p.attackDamage + ';');
  lines.push('                    ' + v + 'AttackTimer = ' + p.attackInterval + 'f;');
  lines.push('                }');
  lines.push('            }');
  lines.push('        }');
  lines.push('        if (' + v + 'HP <= 0) {');
  lines.push('            ' + v + 'State = 2;');
  lines.push('            HideObj(' + v + ');');
  lines.push('            enemiesDefeated++;');
  lines.push('        }');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
