var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    int ' + v + 'HP = ' + npc.params.hp + ';');
  lines.push('    bool ' + v + 'Done = false;');
  return lines.join('\n');
}

function generateUpdate(npc) {
  return '        Update' + npc.entity + '(Time.deltaTime);';
}

function generateSystem(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    void Update' + npc.entity + '(float dt) {');
  lines.push('        if (' + v + 'Done) return;');
  lines.push('        if (' + v + 'HP <= 0) {');
  lines.push('            ' + v + 'Done = true;');
  lines.push('            HideObj(' + v + ');');
  lines.push('            enemiesDefeated++;');
  lines.push('        }');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
