var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var p = npc.params;
  var lines = [];
  lines.push('    int ' + v + 'HP = ' + p.hp + ';');
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
  lines.push('        float dist = Vector3.Distance(' + v + '.transform.position, player.transform.position);');
  lines.push('        if (dist < ' + p.detectRange + 'f) {');
  lines.push('            ' + v + 'State = 1;');
  lines.push('            ' + v + 'FireTimer -= dt;');
  lines.push('            if (' + v + 'FireTimer <= 0f && dist < ' + p.fireRange + 'f) {');
  lines.push('                // Fire projectile toward player');
  lines.push('                var proj = GFM_Pool.Get("projectile");');
  lines.push('                if (proj != null) {');
  lines.push('                    proj.transform.position = ' + v + '.transform.position;');
  lines.push('                    Vector3 dir = (player.transform.position - ' + v + '.transform.position).normalized;');
  lines.push('                    proj.GetComponent<Rigidbody>().velocity = dir * ' + p.projectileSpeed + 'f;');
  lines.push('                }');
  lines.push('                ' + v + 'FireTimer = ' + p.fireInterval + 'f;');
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
