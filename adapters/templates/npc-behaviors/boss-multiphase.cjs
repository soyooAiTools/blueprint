var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var p = npc.params;
  var lines = [];
  lines.push('    int ' + v + 'HP = ' + p.hp + ';');
  lines.push('    int ' + v + 'MaxHP = ' + p.hp + ';');
  lines.push('    int ' + v + 'BossPhase = 1;');
  lines.push('    float ' + v + 'AttackTimer = 0f;');
  lines.push('    float ' + v + 'FireTimer = 0f;');
  lines.push('    int ' + v + 'State = 0; // 0=idle, 1=active, 2=dead');
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
  lines.push('        if (' + v + 'HP <= 0) {');
  lines.push('            ' + v + 'State = 2;');
  lines.push('            HideObj(' + v + ');');
  lines.push('            enemiesDefeated++;');
  lines.push('            return;');
  lines.push('        }');
  lines.push('        float hpPercent = (' + v + 'HP * 100f) / ' + v + 'MaxHP;');
  lines.push('        float dist = Vector3.Distance(' + v + '.transform.position, player.transform.position);');
  lines.push('        if (dist < ' + p.detectRange + 'f) {');
  lines.push('            ' + v + 'State = 1;');
  lines.push('            if (hpPercent > 66f) {');
  lines.push('                ' + v + 'BossPhase = 1;');
  lines.push('                Vector3 dir = (player.transform.position - ' + v + '.transform.position).normalized;');
  lines.push('                ' + v + '.transform.position += dir * ' + p.moveSpeed + 'f * dt;');
  lines.push('                if (dist < ' + p.attackRange + 'f) {');
  lines.push('                    ' + v + 'AttackTimer -= dt;');
  lines.push('                    if (' + v + 'AttackTimer <= 0f) {');
  lines.push('                        playerHP -= ' + p.attackDamage + ';');
  lines.push('                        ' + v + 'AttackTimer = ' + p.attackInterval + 'f;');
  lines.push('                    }');
  lines.push('                }');
  lines.push('            } else if (hpPercent > 33f) {');
  lines.push('                ' + v + 'BossPhase = 2;');
  lines.push('                ' + v + 'FireTimer -= dt;');
  lines.push('                if (' + v + 'FireTimer <= 0f && dist < ' + p.fireRange + 'f) {');
  lines.push('                    // Fire projectile toward player');
  lines.push('                    // Projectile damage value: ' + p.projectileDamage);
  lines.push('                    var proj = GFM_Pool.Get("projectile");');
  lines.push('                    if (proj != null) {');
  lines.push('                        proj.transform.position = ' + v + '.transform.position;');
  lines.push('                        Vector3 dir = (player.transform.position - ' + v + '.transform.position).normalized;');
  lines.push('                        proj.GetComponent<Rigidbody>().velocity = dir * ' + p.projectileSpeed + 'f;');
  lines.push('                    }');
  lines.push('                    ' + v + 'FireTimer = ' + p.fireInterval + 'f;');
  lines.push('                }');
  lines.push('            } else {');
  lines.push('                ' + v + 'BossPhase = 3;');
  lines.push('                Vector3 dir = (player.transform.position - ' + v + '.transform.position).normalized;');
  lines.push('                ' + v + '.transform.position += dir * (' + p.moveSpeed + 'f * 2f) * dt;');
  lines.push('                if (dist < ' + p.attackRange + 'f) {');
  lines.push('                    ' + v + 'AttackTimer -= dt;');
  lines.push('                    if (' + v + 'AttackTimer <= 0f) {');
  lines.push('                        playerHP -= ' + p.attackDamage + ';');
  lines.push('                        ' + v + 'AttackTimer = ' + p.attackInterval + 'f * 0.5f;');
  lines.push('                    }');
  lines.push('                }');
  lines.push('            }');
  lines.push('        }');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
