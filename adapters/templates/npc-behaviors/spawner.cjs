var { toLowerCamel } = require('../trigger-codegen.cjs');

function toPrefabIdentifier(raw) {
  var text = String(raw || '').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : null;
}

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    float ' + v + 'SpawnTimer = 0f;');
  lines.push('    int ' + v + 'AliveCount = 0;');
  return lines.join('\n');
}

function generateUpdate(npc) {
  return '        Update' + npc.entity + 'Spawner(Time.deltaTime);';
}

function generateSystem(npc) {
  var v = toLowerCamel(npc.entity);
  var p = npc.params;
  var prefabId = toPrefabIdentifier(p.spawnEntity);
  var lines = [];
  lines.push('    void Update' + npc.entity + 'Spawner(float dt) {');
  lines.push('        ' + v + 'SpawnTimer -= dt;');
  lines.push('        // Spawn gate: spawn only after cooldown and while alive-count remains below the configured cap.');
  lines.push('        if (' + v + 'SpawnTimer <= 0f && ' + v + 'AliveCount < ' + p.maxAlive + ') {');
  lines.push('            GameObject spawnPrefab = ' + (prefabId || 'null') + ';');
  lines.push('            var spawned = spawnPrefab != null ? GFM_Pool.Get(spawnPrefab) : null;');
  lines.push('            if (spawned != null) {');
  lines.push('                float rx = UnityEngine.Random.Range(-' + p.spawnRadius + 'f, ' + p.spawnRadius + 'f);');
  lines.push('                float rz = UnityEngine.Random.Range(-' + p.spawnRadius + 'f, ' + p.spawnRadius + 'f);');
  lines.push('                spawned.transform.position = ' + v + '.transform.position + new Vector3(rx, 0f, rz);');
  lines.push('                ' + v + 'AliveCount++;');
  lines.push('            }');
  lines.push('            ' + v + 'SpawnTimer = ' + p.spawnInterval + 'f;');
  lines.push('        }');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
