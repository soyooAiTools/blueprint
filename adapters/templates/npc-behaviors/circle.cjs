var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    float ' + v + 'CircleAngle = 0f;');
  lines.push('    Vector3 ' + v + 'CenterPos;');
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
  lines.push('        if (' + v + 'CenterPos == Vector3.zero) {');
  lines.push('            ' + v + 'CenterPos = ' + v + '.transform.position;');
  lines.push('        }');
  lines.push('        ' + v + 'CircleAngle += ' + p.moveSpeed + 'f * dt;');
  lines.push('        float x = ' + v + 'CenterPos.x + ' + p.circleRadius + 'f * Mathf.Cos(' + v + 'CircleAngle);');
  lines.push('        float z = ' + v + 'CenterPos.z + ' + p.circleRadius + 'f * Mathf.Sin(' + v + 'CircleAngle);');
  lines.push('        ' + v + '.transform.position = new Vector3(x, ' + v + 'CenterPos.y, z);');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
