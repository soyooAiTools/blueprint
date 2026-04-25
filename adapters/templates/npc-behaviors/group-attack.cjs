var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    int[] ' + v + 'GroupHP;');
  lines.push('    int[] ' + v + 'GroupState; // 0=idle, 1=chase, 2=dead');
  lines.push('    float[] ' + v + 'GroupTimer;');
  lines.push('    GameObject[] ' + v + 'GroupObj;');
  lines.push('    bool ' + v + 'Done = false;');
  lines.push('    int ' + v + 'GroupAlive = ' + Math.min(npc.params.count || 0, 5) + ';');
  return lines.join('\n');
}

function generateUpdate(npc) {
  return '        Update' + npc.entity + '(Time.deltaTime);';
}

function generateSystem(npc) {
  var v = toLowerCamel(npc.entity);
  var p = npc.params || {};
  var count = Math.min(p.count || 0, 5);
  var hp = p.hp || 0;
  var detectRange = p.detectRange || 0;
  var attackRange = p.attackRange || 0;
  var attackDamage = p.attackDamage || 0;
  var attackInterval = p.attackInterval || 0;
  var moveSpeed = p.moveSpeed || 0;
  var spawnRadius = p.spawnRadius || 0;
  var lines = [];
  lines.push('    void Update' + npc.entity + '(float dt) {');
  lines.push('        int count = ' + count + ';');
  lines.push('        if (' + v + 'Done) return;');
  lines.push('        Ensure' + npc.entity + 'Group(count);');
  lines.push('        Update' + npc.entity + 'GroupMembers(dt, count);');
  lines.push('        if (' + v + 'GroupAlive <= 0) {');
  lines.push('            ' + v + 'Done = true;');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // Initialize the ' + npc.entity + ' group arrays and place pooled members around the anchor.');
  lines.push('    void Ensure' + npc.entity + 'Group(int count) {');
  lines.push('        if (' + v + 'GroupObj == null) {');
  lines.push('            ' + v + 'GroupObj = new GameObject[count];');
  lines.push('            ' + v + 'GroupHP = new int[count];');
  lines.push('            ' + v + 'GroupState = new int[count];');
  lines.push('            ' + v + 'GroupTimer = new float[count];');
  lines.push('            ' + v + 'GroupAlive = count;');
  lines.push('            for (int i = 0; i < count; i++) {');
  lines.push('                ' + v + 'GroupHP[i] = ' + hp + ';');
  lines.push('                ' + v + 'GroupState[i] = 0;');
  lines.push('                ' + v + 'GroupTimer[i] = 0f;');
  lines.push('                // Group members should be found in Start() using a stable name pattern like "' + npc.entity + '_" + i.');
  lines.push('                ' + v + 'GroupObj[i] = GameObject.Find("' + npc.entity + '_" + i);');
  lines.push('                if (' + v + 'GroupObj[i] != null) {');
  lines.push('                    float angle = (360f / count) * i;');
  lines.push('                    Vector3 offset = Quaternion.Euler(0f, angle, 0f) * new Vector3(0f, 0f, ' + spawnRadius + 'f);');
  lines.push('                    ' + v + 'GroupObj[i].transform.position += offset;');
  lines.push('                }');
  lines.push('            }');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // Update each live ' + npc.entity + ' group member movement, attacks, and death state.');
  lines.push('    void Update' + npc.entity + 'GroupMembers(float dt, int count) {');
  lines.push('        for (int i = 0; i < count; i++) {');
  lines.push('            if (' + v + 'GroupState[i] == 2) continue;');
  lines.push('            GameObject member = ' + v + 'GroupObj[i];');
  lines.push('            if (member == null) continue;');
  lines.push('            if (' + v + 'GroupHP[i] <= 0) {');
  lines.push('                ' + v + 'GroupState[i] = 2;');
  lines.push('                HideObj(member);');
  lines.push('                ' + v + 'GroupAlive--;');
  lines.push('                continue;');
  lines.push('            }');
  lines.push('            float dist = Vector3.Distance(member.transform.position, player.transform.position);');
  lines.push('            if (dist < ' + detectRange + 'f) {');
  lines.push('                ' + v + 'GroupState[i] = 1;');
  lines.push('                Vector3 dir = (player.transform.position - member.transform.position).normalized;');
  lines.push('                member.transform.position += dir * ' + moveSpeed + 'f * dt;');
  lines.push('                if (dist < ' + attackRange + 'f) {');
  lines.push('                    ' + v + 'GroupTimer[i] -= dt;');
  lines.push('                    if (' + v + 'GroupTimer[i] <= 0f) {');
  lines.push('                        playerHP -= ' + attackDamage + ';');
  lines.push('                        ' + v + 'GroupTimer[i] = ' + attackInterval + 'f;');
  lines.push('                    }');
  lines.push('                }');
  lines.push('            }');
  lines.push('        }');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
