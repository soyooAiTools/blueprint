var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var codeRelationGraphWriter = require('./code-relation-graph-writer.cjs');

function walkFiles(root, out) {
  out = out || [];
  if (!fs.existsSync(root)) return out;
  var entries = fs.readdirSync(root, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.svn' || entry.name === '.git' || entry.name === 'node_modules') continue;
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function shouldDropContractComment(text) {
  var t = String(text || '').trim();
  if (!t) return false;
  if (/^TODO_[A-Za-z0-9_]+(?:_(?:START|END))?$/.test(t)) return true;
  if (/^\[ASSEMBLY (?:SLOT|PHASE|OWNER MANIFEST)\]/.test(t)) return true;
  if (/^ownerFile:\s*/.test(t)) return true;
  if (/^phaseEvidenceSchema:\s*/.test(t)) return true;
  if (/^(?:数据:\s*)?"(?:signal|kind|phaseEvidencePath|variableEvidenceKey)"\s*:/.test(t)) return true;
  if (/机器可读\s+\[ASSEMBLY/.test(t)) return true;
  if (/供\s*Blueprint\/CUA\s*追踪/.test(t)) return true;
  return false;
}

function cleanCSharpForProgrammerDelivery(code) {
  var lines = String(code || '').split(/\r?\n/);
  var changed = false;
  var removedContractComments = 0;
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var match = line.match(/^(\s*)\/\/\s?(.*)$/);
    if (match && shouldDropContractComment(match[2])) {
      changed = true;
      removedContractComments++;
      continue;
    }
    out.push(line);
  }

  var next = out.join('\n');
  next = next.replace(
    /const bool ENABLE_GENERATED_ASSEMBLY_RUNNERS = false; \/\/ true 时才执行生成槽位 runner；默认走手写可玩路径/g,
    'const bool ENABLE_GENERATED_ASSEMBLY_RUNNERS = false; // 保留生成槽位作为参考实现；默认使用手写可玩路径。'
  );
  if (next !== out.join('\n')) changed = true;

  return {
    code: next,
    changed: changed,
    removedContractComments: removedContractComments
  };
}

function removeIfExists(target) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function findManagerDir(root) {
  var candidates = [
    path.join(root, 'Assets', 'Program', 'Script', 'Manager'),
    path.join(root, 'Scripts'),
    root
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i]) && fs.statSync(candidates[i]).isDirectory()) {
      return candidates[i];
    }
  }
  return null;
}

function findMatchingBrace(text, openIdx) {
  var depth = 0;
  var mode = 'code';
  var verbatim = false;
  for (var i = openIdx; i < text.length; i++) {
    var c = text[i];
    var next = text[i + 1];

    if (mode === 'lineComment') {
      if (c === '\n') mode = 'code';
      continue;
    }
    if (mode === 'blockComment') {
      if (c === '*' && next === '/') {
        mode = 'code';
        i++;
      }
      continue;
    }
    if (mode === 'string') {
      if (verbatim && c === '"' && next === '"') {
        i++;
      } else if (c === '"') {
        mode = 'code';
        verbatim = false;
      } else if (!verbatim && c === '\\') {
        i++;
      }
      continue;
    }
    if (mode === 'char') {
      if (c === '\\') i++;
      else if (c === "'") mode = 'code';
      continue;
    }

    if (c === '/' && next === '/') {
      mode = 'lineComment';
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      mode = 'blockComment';
      i++;
      continue;
    }
    if (c === '@' && next === '"') {
      mode = 'string';
      verbatim = true;
      i++;
      continue;
    }
    if (c === '"') {
      mode = 'string';
      verbatim = false;
      continue;
    }
    if (c === "'") {
      mode = 'char';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractManagerClassInfo(file) {
  var code = fs.readFileSync(file, 'utf8');
  var re = /\b(?:public|internal)?\s*(?:partial\s+)?class\s+GameFlowManagerMain\b[^{]*\{/m;
  var match = re.exec(code);
  if (!match) return null;
  var openIdx = match.index + match[0].lastIndexOf('{');
  var closeIdx = findMatchingBrace(code, openIdx);
  if (closeIdx < 0) return null;
  return {
    file: file,
    name: path.basename(file),
    code: code,
    isPartial: /\bpartial\s+class\s+GameFlowManagerMain\b/.test(match[0]),
    classStart: match.index,
    openIdx: openIdx,
    closeIdx: closeIdx,
    beforeOpen: code.slice(0, openIdx),
    body: code.slice(openIdx + 1, closeIdx),
    afterClose: code.slice(closeIdx + 1)
  };
}

function collectUsingLines(parts) {
  var seen = {};
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var text = String(parts[i] || '');
    var re = /^\s*using\s+[^;]+;/gm;
    var match;
    while ((match = re.exec(text))) {
      var line = match[0].trim();
      if (seen[line]) continue;
      seen[line] = true;
      out.push(line);
    }
  }
  if (!seen['using UnityEngine;']) out.unshift('using UnityEngine;');
  return out;
}

function stripUsingLines(text) {
  return String(text || '').replace(/^\s*using\s+[^;]+;\s*\n?/gm, '');
}

function csString(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sanitizeIdentifier(value, fallback) {
  var text = String(value || '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!text) text = fallback || 'Entity';
  if (/^\d/.test(text)) text = '_' + text;
  return text;
}

function toPascal(value) {
  var id = sanitizeIdentifier(value, 'Entity');
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function toCamel(value) {
  var id = sanitizeIdentifier(value, 'entity');
  return id.charAt(0).toLowerCase() + id.slice(1);
}

function entityClassName(entityName) {
  var base = toPascal(entityName);
  return /Entity$/.test(base) ? base : base + 'Entity';
}

function classifyEntity(entityName) {
  var name = String(entityName || '');
  if (/Base|Tower|Turret|Barrack|Build|Forge|Workshop|Cabin|Conveyor|Factory|Machine|Recycler|Station|Generator|Bridge|House|Shop|Farm|Spawner/i.test(name)) {
    return 'build';
  }
  if (/Gold|Coin|Debris|Resource|Crystal|Water|Oxygen|Wood|Stone|Ore|Fuel|Food|Crop|Ice|Popcorn/i.test(name)) {
    return 'resource';
  }
  if (/Enemy|Soldier|Astronaut|Unit|Bullet|Projectile|Boss|Monster|Shooter|Arrow|Missile/i.test(name)) {
    return 'combat';
  }
  return 'entity';
}

function baseClassForEntity(entityName) {
  var kind = classifyEntity(entityName);
  if (kind === 'build') return 'BaseBuildElement';
  if (kind === 'resource') return 'ResourceEntity';
  if (kind === 'combat') return 'CombatEntity';
  return 'BaseGameFlowEntity';
}

function collectEntityInfos(code) {
  var found = {};
  var out = [];
  var re = /^\s*GameObject\s+([A-Za-z_][A-Za-z0-9_]*)\s*;\s*(?:(?:\/\/\s*)?(?:说明：)?(?:→|->)\s*([A-Za-z0-9_]+))?/gm;
  var match;
  while ((match = re.exec(String(code || '')))) {
    var name = match[1];
    if (found[name]) continue;
    found[name] = true;
    out.push({
      name: name,
      pool: match[2] || '',
      className: entityClassName(name),
      modelField: '_' + toCamel(name) + 'EntityModel',
      baseClass: baseClassForEntity(name)
    });
  }
  return out;
}

function ensureUnityMeta(file) {
  var meta = file + '.meta';
  if (fs.existsSync(meta)) return false;
  var guid = crypto.randomBytes(16).toString('hex');
  var lines = [
    'fileFormatVersion: 2',
    'guid: ' + guid,
    'MonoImporter:',
    '  externalObjects: {}',
    '  serializedVersion: 2',
    '  defaultReferences: []',
    '  executionOrder: 0',
    '  icon: {instanceID: 0}',
    '  userData:',
    '  assetBundleName:',
    '  assetBundleVariant:',
    ''
  ];
  fs.writeFileSync(meta, lines.join('\n'));
  return true;
}

function writeGeneratedCs(file, code) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code.replace(/\s+$/g, '') + '\n');
  ensureUnityMeta(file);
}

function buildBaseGameFlowEntityCode() {
  return [
    'using UnityEngine;',
    '',
    'public class BaseGameFlowEntity : MonoBehaviour',
    '{',
    '    public string EntityId = "";',
    '    public string DisplayName = "";',
    '    public GameObject SourceObject;',
    '    public int State = 0;',
    '',
    '    public virtual void Bind(GameObject source, string entityId, string displayName)',
    '    {',
    '        SourceObject = source != null ? source : gameObject;',
    '        EntityId = entityId;',
    '        DisplayName = string.IsNullOrEmpty(displayName) ? entityId : displayName;',
    '    }',
    '',
    '    public virtual void SetVisible(bool visible)',
    '    {',
    '        if (SourceObject != null) SourceObject.SetActive(visible);',
    '    }',
    '',
    '    public virtual void SetPosition(Vector3 position)',
    '    {',
    '        if (SourceObject != null) SourceObject.transform.position = position;',
    '    }',
    '}'
  ].join('\n');
}

function buildBaseBuildElementCode() {
  return [
    'using UnityEngine;',
    '',
    'public class BaseBuildElement : BaseGameFlowEntity',
    '{',
    '    public int Health = 100;',
    '    public int Attack = 0;',
    '    public int Level = 1;',
    '',
    '    public virtual void MarkBuilt()',
    '    {',
    '        State = 2;',
    '    }',
    '',
    '    public virtual void Upgrade()',
    '    {',
    '        Level = Mathf.Max(1, Level + 1);',
    '        Health += 25;',
    '        Attack += 5;',
    '    }',
    '}'
  ].join('\n');
}

function buildSimpleClassCode(className, baseClass, bodyLines) {
  var lines = ['using UnityEngine;', '', 'public class ' + className + ' : ' + baseClass, '{'];
  if (bodyLines && bodyLines.length) {
    for (var i = 0; i < bodyLines.length; i++) lines.push('    ' + bodyLines[i]);
  }
  lines.push('}');
  return lines.join('\n');
}

function buildConcreteEntityCode(entity) {
  var lines = [
    'public const string Id = "' + csString(entity.name) + '";'
  ];
  if (entity.pool) lines.push('public const string PoolObjectName = "' + csString(entity.pool) + '";');
  return buildSimpleClassCode(entity.className, entity.baseClass, lines);
}

function writeEntityClassFiles(managerDir, entities) {
  if (!entities.length) return { files: 0, metas: 0, dir: '' };
  var entityDir = path.join(managerDir, 'Entities');
  fs.mkdirSync(entityDir, { recursive: true });
  var files = [
    { name: 'BaseGameFlowEntity.cs', code: buildBaseGameFlowEntityCode() },
    { name: 'BaseBuildElement.cs', code: buildBaseBuildElementCode() },
    { name: 'BuildEntity.cs', code: buildSimpleClassCode('BuildEntity', 'BaseBuildElement', []) },
    { name: 'CombatEntity.cs', code: buildSimpleClassCode('CombatEntity', 'BaseGameFlowEntity', [
      'public int Health = 100;',
      'public int Attack = 10;',
      'public int Level = 1;',
      '',
      'public virtual void ApplyDamage(int amount)',
      '{',
      '    Health = Mathf.Max(0, Health - Mathf.Max(0, amount));',
      '    if (Health == 0) State = 3;',
      '}'
    ]) },
    { name: 'ResourceEntity.cs', code: buildSimpleClassCode('ResourceEntity', 'BaseGameFlowEntity', [
      'public int Amount = 1;',
      '',
      'public virtual int CollectAll()',
      '{',
      '    int value = Mathf.Max(0, Amount);',
      '    Amount = 0;',
      '    State = 2;',
      '    return value;',
      '}'
    ]) },
    // 反馈 01 #1 架构图:玩家/NPC 走独立领域基类,与 BaseBuildElement/Combat/Resource 同级
    { name: 'PlayerBase.cs', code: buildSimpleClassCode('PlayerBase', 'BaseGameFlowEntity', [
      'public float MoveSpeed = 4f;',
      'public int Score = 0;',
      '',
      'public virtual void MoveByDirection(Vector3 direction, float dt)',
      '{',
      '    if (SourceObject == null) return;',
      '    if (direction.sqrMagnitude < 0.0001f) return;',
      '    SourceObject.transform.position += direction.normalized * (MoveSpeed * dt);',
      '}',
      '',
      'public virtual void AddScore(int delta)',
      '{',
      '    Score = Mathf.Max(0, Score + delta);',
      '}'
    ]) },
    { name: 'NPCBase.cs', code: buildSimpleClassCode('NPCBase', 'BaseGameFlowEntity', [
      'public float PatrolSpeed = 2f;',
      'public Vector3 TargetPosition;',
      'public bool HasTarget = false;',
      '',
      'public virtual void SetTarget(Vector3 target)',
      '{',
      '    TargetPosition = target;',
      '    HasTarget = true;',
      '}',
      '',
      'public virtual void ClearTarget()',
      '{',
      '    HasTarget = false;',
      '}',
      '',
      'public virtual void TickPatrol(float dt)',
      '{',
      '    if (!HasTarget || SourceObject == null) return;',
      '    Vector3 pos = SourceObject.transform.position;',
      '    Vector3 delta = TargetPosition - pos;',
      '    if (delta.sqrMagnitude < 0.01f) { HasTarget = false; return; }',
      '    SourceObject.transform.position = pos + delta.normalized * (PatrolSpeed * dt);',
      '}'
    ]) }
  ];
  for (var i = 0; i < entities.length; i++) {
    files.push({ name: entities[i].className + '.cs', code: buildConcreteEntityCode(entities[i]) });
  }

  var metas = 0;
  for (var j = 0; j < files.length; j++) {
    var file = path.join(entityDir, files[j].name);
    writeGeneratedCs(file, files[j].code);
    if (fs.existsSync(file + '.meta')) metas++;
  }
  return { files: files.length, metas: metas, dir: entityDir };
}

function buildEntityBindingMemberBlock(entities, existingBody) {
  if (!entities.length || /void\s+BindGameFlowEntityModels\s*\(/.test(existingBody)) return '';
  var lines = [];
  lines.push('    // 程序员交付版实体模型：把对象池 GameObject 绑定到独立的领域类。');
  for (var i = 0; i < entities.length; i++) {
    lines.push('    ' + entities[i].className + ' ' + entities[i].modelField + ';');
  }
  lines.push('');
  lines.push('    void BindGameFlowEntityModels()');
  lines.push('    {');
  for (var j = 0; j < entities.length; j++) {
    lines.push('        ' + entities[j].modelField + ' = BindGameFlowEntityComponent<' + entities[j].className + '>(' +
      entities[j].name + ', "' + csString(entities[j].name) + '", "' + csString(entities[j].name) + '");');
  }
  lines.push('    }');
  lines.push('');
  lines.push('    T BindGameFlowEntityComponent<T>(GameObject obj, string entityId, string displayName) where T : BaseGameFlowEntity');
  lines.push('    {');
  lines.push('        if (obj == null) return null;');
  lines.push('        T model = obj.GetComponent<T>();');
  lines.push('        if (model == null) model = obj.AddComponent<T>();');
  lines.push('        model.Bind(obj, entityId, displayName);');
  lines.push('        return model;');
  lines.push('    }');
  return lines.join('\n');
}

function companionSectionTitle(name) {
  var n = String(name || '');
  if (/Entities\.cs$/.test(n)) return '实体绑定';
  if (/Flow\.AutoPlay\.cs$/.test(n)) return '自动推进';
  if (/Flow\.Buildings\.cs$/.test(n)) return '建筑流程';
  if (/Flow\.Enemies\.cs$/.test(n)) return '敌方流程';
  if (/Flow\.Allies\.cs$/.test(n)) return '我方单位流程';
  if (/Flow\.Projectiles\.cs$/.test(n)) return '投射物流程';
  if (/Flow\.Resources\.cs$/.test(n)) return '资源流程';
  if (/Flow\.Camera\.cs$/.test(n)) return '镜头流程';
  if (/Flow\.System\.cs$/.test(n)) return '系统流程';
  if (/Flow\.cs$/.test(n)) return '阶段流程';
  if (/Phases\.cs$/.test(n)) return '阶段处理';
  if (/PreviewState\.cs$/.test(n)) return '预览状态';
  if (/Input\.cs$/.test(n)) return '输入';
  if (/Resource\.cs$/.test(n)) return '资源';
  if (/Scene\.Entities\.cs$/.test(n)) return '场景实体';
  if (/Scene\.Camera\.cs$/.test(n)) return '场景镜头';
  if (/Scene\.cs$/.test(n)) return '场景辅助';
  if (/UI\.cs$/.test(n)) return '界面';
  return '合并代码';
}

function sanitizeDeliveryManagerCode(code) {
  return String(code || '').split('\n').map(function(line) {
    var idx = line.indexOf('//');
    if (idx < 0) return line;
    var prefix = line.slice(0, idx);
    var comment = line.slice(idx)
      .replace(/GameFlowManagerMain\.(?:[A-Za-z0-9]+\.)*[A-Za-z0-9]+\.cs/g, 'GameFlowManagerMain.cs')
      .replace(/partial 文件/g, '模块代码')
      .replace(/partial class/g, '拆分类')
      .replace(/\bpartial\b/g, '模块')
      .replace(/同名 模块 文件/g, '对应模块代码')
      .replace(/Flow\.[A-Za-z/]+/g, '领域模块')
      .replace(/Flow 模块/g, '流程模块');
    return prefix + comment;
  }).join('\n');
}

function insertEntityBindingCall(body, entities) {
  if (!entities.length || /BindGameFlowEntityModels\s*\(\s*\)\s*;/.test(body)) return body;
  if (/RegisterEntityBindings\s*\(\s*\)\s*;/.test(body)) {
    return body.replace(/(RegisterEntityBindings\s*\(\s*\)\s*;)/, '$1\n        BindGameFlowEntityModels();');
  }
  return body.replace(/(void\s+Start\s*\([^)]*\)\s*\{\s*)/, '$1\n        BindGameFlowEntityModels();\n');
}

function composeMergedManagerCode(mainInfo, companionInfos, entities) {
  var usingLines = collectUsingLines([mainInfo.code].concat(companionInfos.map(function(info) { return info.code; })));
  var beforeOpen = stripUsingLines(mainInfo.beforeOpen)
    .replace(/\bpartial\s+class\s+GameFlowManagerMain\b/, 'class GameFlowManagerMain');
  var classIdx = beforeOpen.search(/\b(?:public|internal)?\s*class\s+GameFlowManagerMain\b/);
  if (classIdx >= 0) {
    beforeOpen = beforeOpen.slice(0, classIdx).trimEnd() + '\n\n' +
      usingLines.join('\n') + '\n\n' +
      beforeOpen.slice(classIdx).trimStart();
  }

  var body = insertEntityBindingCall(mainInfo.body.trimEnd(), entities);
  for (var i = 0; i < companionInfos.length; i++) {
    var companionBody = companionInfos[i].body.trim();
    if (!companionBody) continue;
    body += '\n\n    // ===== ' + companionSectionTitle(companionInfos[i].name) + '代码区 =====\n';
    body += companionBody + '\n';
  }

  var entityBlock = buildEntityBindingMemberBlock(entities, body);
  if (entityBlock) body += '\n\n    // ===== 实体模型代码区 =====\n' + entityBlock + '\n';

  return sanitizeDeliveryManagerCode(
    beforeOpen.replace(/\s+$/g, '') + '\n{' + body + '\n}' + mainInfo.afterClose.replace(/^\s+/, '\n')
  );
}

function lineBraceDelta(line) {
  var text = String(line || '')
    .replace(/\/\/.*$/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length;
}

function trimBlankLines(lines) {
  var start = 0;
  var end = lines.length;
  while (start < end && String(lines[start] || '').trim() === '') start++;
  while (end > start && String(lines[end - 1] || '').trim() === '') end--;
  return lines.slice(start, end);
}

function removeGeneratedAssemblyDeadCode(lines) {
  var out = [];
  var removedMethods = 0;
  var removedFields = 0;
  var depth = 1;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = String(line || '').trim();
    if (depth === 1 && trimmed === 'RunGeneratedAssemblySlotRunners();') {
      continue;
    }
    if (depth === 1 && /^const\s+bool\s+ENABLE_GENERATED_ASSEMBLY_RUNNERS\b/.test(trimmed)) {
      removedFields++;
      continue;
    }
    if (depth === 1 && /^bool\s+__assemblyDone_AssemblySlot_/.test(trimmed)) {
      removedFields++;
      continue;
    }
    if (depth === 1 && /\bvoid\s+(RunGeneratedAssemblySlotRunners|AssemblySlot_[A-Za-z0-9_]+|AssemblyRun(?:Flow|Input|Resource|Scene|UI)Slots)\s*\(/.test(trimmed)) {
      removedMethods++;
      var blockDepth = 0;
      var started = false;
      for (; i < lines.length; i++) {
        if (String(lines[i] || '').indexOf('{') >= 0) started = true;
        blockDepth += lineBraceDelta(lines[i]);
        if (started && blockDepth <= 0) break;
      }
      continue;
    }
    if (/RunGeneratedAssemblySlotRunners|ENABLE_GENERATED_ASSEMBLY_RUNNERS|AssemblyRun\*|AssemblySlot_\*/.test(trimmed)) {
      continue;
    }
    if (/^\/\/\s*=+\s*确定性装配槽位/.test(trimmed)) continue;
    if (/^\/\/\s*集中执行.*装配槽兼容逻辑/.test(trimmed)) continue;
    if (/^\/\/\s*"text":/.test(trimmed)) continue;
    out.push(line);
    depth += lineBraceDelta(line);
  }
  return { lines: out, removedMethods: removedMethods, removedFields: removedFields };
}

function protectBaseMembers(lines) {
  var out = [];
  var depth = 1;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = String(line || '').trim();
    var next = line;
    if (depth === 1 &&
        trimmed &&
        trimmed.indexOf('//') !== 0 &&
        trimmed.indexOf('#') !== 0 &&
        !/^(?:public|protected|private|internal)\b/.test(trimmed)) {
      if (/^(?:const|class|struct)\b/.test(trimmed) ||
          /^(?:static\s+)?(?:readonly\s+)?[A-Za-z_][\w<>\[\]]*(?:\s*\[\])?\s+[A-Za-z_]\w*\b/.test(trimmed)) {
        next = line.replace(/^(\s*)/, '$1protected ');
      }
    }
    out.push(next);
    depth += lineBraceDelta(line);
  }
  return out;
}

function extractClassBodyFromCode(code) {
  var text = String(code || '');
  var re = /\b(?:public|internal)?\s*(?:partial\s+)?class\s+GameFlowManagerMain\b[^{]*\{/m;
  var match = re.exec(text);
  if (!match) return null;
  var openIdx = match.index + match[0].lastIndexOf('{');
  var closeIdx = findMatchingBrace(text, openIdx);
  if (closeIdx < 0) return null;
  return {
    beforeOpen: text.slice(0, openIdx),
    body: text.slice(openIdx + 1, closeIdx),
    afterClose: text.slice(closeIdx + 1)
  };
}

function findMethodRange(lines, methodName) {
  var escapedName = String(methodName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp(
    '^\\s*' +
    '(?:(?:public|protected|private|internal|static|virtual|override|sealed|async|new)\\s+)*' +
    '(?:[A-Za-z_][\\w\\.<>\\[\\],]*\\s+)+' +
    escapedName + '\\s*\\('
  );
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  var depth = 0;
  var started = false;
  for (var j = start; j < lines.length; j++) {
    if (String(lines[j] || '').indexOf('{') >= 0) started = true;
    depth += lineBraceDelta(lines[j]);
    if (started && depth <= 0) return [start, j + 1];
  }
  return null;
}

function findSectionRange(lines, titlePattern) {
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*\/\/ ===== .*代码区 =====/.test(lines[i]) && titlePattern.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  var end = lines.length;
  for (var j = start + 1; j < lines.length; j++) {
    if (/^\s*\/\/ ===== .*代码区 =====/.test(lines[j])) {
      end = j;
      break;
    }
  }
  return [start, end];
}

function extractRangeFromLines(lines, range) {
  if (!range) return [];
  var part = lines.slice(range[0], range[1]);
  lines.splice(range[0], range[1] - range[0]);
  return part;
}

function extractMatchingSectionsFromLines(lines, titlePattern) {
  var out = [];
  var range = findSectionRange(lines, titlePattern);
  while (range) {
    if (out.length) out.push('');
    out = out.concat(extractRangeFromLines(lines, range));
    range = findSectionRange(lines, titlePattern);
  }
  return out;
}

function methodDeclarationName(line) {
  var re = /^\s*(?:(?:public|protected|private|internal|static|virtual|override|sealed|async|new)\s+)*(?:[A-Za-z_][\w\. <>\[\],]*\s+)+([A-Za-z_]\w*)\s*\(/;
  var match = re.exec(String(line || ''));
  return match ? match[1] : '';
}

function extractMethodsMatchingFromLines(lines, predicate) {
  var out = [];
  for (var i = 0; i < lines.length;) {
    var name = methodDeclarationName(lines[i]);
    if (name && predicate(name, lines[i])) {
      var range = findMethodRange(lines, name);
      if (range && range[0] === i) {
        if (out.length) out.push('');
        out = out.concat(extractRangeFromLines(lines, range));
        continue;
      }
    }
    i++;
  }
  return out;
}

function markerIndex(lines, pattern) {
  for (var i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

function nextMarkerAfter(starts, start, fallback) {
  var next = fallback;
  for (var i = 0; i < starts.length; i++) {
    if (starts[i] > start && starts[i] < next) next = starts[i];
  }
  return next;
}

function splitPhaseFlowLines(lines) {
  var src = trimBlankLines(lines);
  var initStart = markerIndex(src, /阶段初始化处理器/);
  var tapStart = markerIndex(src, /阶段点击处理器/);
  var autoStart = markerIndex(src, /阶段自动播放处理器/);
  var snapshotStart = markerIndex(src, /阶段快照辅助/);
  var starts = [initStart, tapStart, autoStart, snapshotStart].filter(function(idx) { return idx >= 0; });
  var firstSplit = starts.length ? Math.min.apply(Math, starts) : src.length;
  var sharedLines = src.slice(0, firstSplit);
  var dispatchLines = extractMethodsMatchingFromLines(sharedLines, function(name) {
    return name === 'Phase_OnTap' || name === 'OnAutoPlayArrive';
  });
  var initEnd = initStart >= 0 ? nextMarkerAfter(starts, initStart, src.length) : initStart;
  var tapEnd = tapStart >= 0 ? nextMarkerAfter(starts, tapStart, src.length) : tapStart;
  var autoEnd = autoStart >= 0 ? nextMarkerAfter(starts, autoStart, src.length) : autoStart;
  var initLines = initStart >= 0 ? src.slice(initStart, initEnd) : extractMethodsMatchingFromLines(sharedLines, function(name) {
    return /^Phase_[A-Za-z0-9_]+_Init$/.test(name);
  });
  var tapLines = tapStart >= 0 ? src.slice(tapStart, tapEnd) : extractMethodsMatchingFromLines(sharedLines, function(name) {
    return /^Phase_[A-Za-z0-9_]+_OnTap$/.test(name);
  });
  var autoLines = autoStart >= 0 ? src.slice(autoStart, autoEnd) : extractMethodsMatchingFromLines(sharedLines, function(name) {
    return /^Phase_[A-Za-z0-9_]+_OnAutoPlayArrive$/.test(name);
  });
  var snapshotLines = snapshotStart >= 0 ? src.slice(snapshotStart) : extractMethodsMatchingFromLines(sharedLines, function(name) {
    return /^Snapshot_[A-Za-z0-9_]+/.test(name);
  });
  return {
    dispatch: dispatchLines,
    shared: sharedLines,
    init: initLines,
    tap: tapLines,
    auto: autoLines,
    snapshot: snapshotLines
  };
}

function firstSectionIndex(lines) {
  for (var i = 0; i < lines.length; i++) {
    if (/^\s*\/\/ ===== .*代码区 =====/.test(lines[i])) return i;
  }
  return lines.length;
}

function classCode(className, baseName, bodyLines, description) {
  var body = protectBaseMembers(trimBlankLines(bodyLines));
  return [
    'using UnityEngine;',
    'using UnityEngine.UI;',
    'using System.Globalization;',
    '',
    description,
    'public class ' + className + ' : ' + baseName,
    '{'
  ].concat(body, ['}', '']).join('\n');
}

function mainCode(bodyLines, parentClassName) {
  var parent = parentClassName || 'MonoBehaviour';
  return [
    '// ========== 程序员交付主入口 ==========',
    '// 按反馈要求不使用 C# 拆分类；GameFlowManagerMain.cs 保持少于 1000 行。',
    '// 仅当某个普通基类层有实际成员时才会生成对应文件，空层会被剔除。',
    '',
    'using UnityEngine;',
    'using UnityEngine.UI;',
    'using System.Globalization;',
    '',
    'public class GameFlowManagerMain : ' + parent,
    '{'
  ].concat(trimBlankLines(bodyLines), ['}', '']).join('\n');
}

function writeGameFlowFile(managerDir, fileName, code) {
  var file = path.join(managerDir, fileName);
  fs.writeFileSync(file, code.replace(/\s+$/g, '') + '\n');
  ensureUnityMeta(file);
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).length - 1;
}

function countFileLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).length - 1;
}

function existingGameFlowLayerStats(managerDir) {
  var names = [
    'GameFlowManagerMain.cs',
    'GameFlowPhaseFlowBase.cs',
    'GameFlowPhaseAutoBase.cs',
    'GameFlowPhaseTapBase.cs',
    'GameFlowPhaseInitBase.cs',
    'GameFlowPhaseSnapshotBase.cs',
    'GameFlowPhaseSharedBase.cs',
    'GameFlowPhaseContentBase.cs',
    'GameFlowUiBase.cs',
    'GameFlowInputBase.cs',
    'GameFlowRuntimeBase.cs',
    'GameFlowSceneBase.cs',
    'GameFlowPreviewBase.cs',
    'GameFlowStateBase.cs'
  ];
  var files = 0;
  var maxLines = 0;
  var mainLines = 0;
  for (var i = 0; i < names.length; i++) {
    var file = path.join(managerDir, names[i]);
    if (!fs.existsSync(file)) continue;
    files++;
    var lines = countFileLines(file);
    if (names[i] === 'GameFlowManagerMain.cs') mainLines = lines;
    if (lines > maxLines) maxLines = lines;
  }
  return { files: files, mainLines: mainLines, maxLines: maxLines };
}

function existingEntityClassFileCount(managerDir) {
  var entityDir = path.join(managerDir, 'Entities');
  if (!fs.existsSync(entityDir) || !fs.statSync(entityDir).isDirectory()) return 0;
  return fs.readdirSync(entityDir).filter(function(name) { return /\.cs$/i.test(name); }).length;
}

function existingEntityModelCount(managerDir) {
  var names = [
    'GameFlowManagerMain.cs',
    'GameFlowPhaseFlowBase.cs',
    'GameFlowPhaseAutoBase.cs',
    'GameFlowPhaseTapBase.cs',
    'GameFlowPhaseInitBase.cs',
    'GameFlowPhaseSnapshotBase.cs',
    'GameFlowPhaseSharedBase.cs',
    'GameFlowPhaseContentBase.cs',
    'GameFlowUiBase.cs',
    'GameFlowInputBase.cs',
    'GameFlowRuntimeBase.cs',
    'GameFlowSceneBase.cs',
    'GameFlowPreviewBase.cs',
    'GameFlowStateBase.cs'
  ];
  var found = {};
  for (var i = 0; i < names.length; i++) {
    var file = path.join(managerDir, names[i]);
    if (!fs.existsSync(file)) continue;
    var text = fs.readFileSync(file, 'utf8');
    var re = /\b_[A-Za-z0-9_]+EntityModel\b/g;
    var match;
    while ((match = re.exec(text))) found[match[0]] = true;
  }
  return Object.keys(found).length;
}

function splitMergedManagerIntoDeliveryClasses(managerDir, mergedCode) {
  var parsed = extractClassBodyFromCode(mergedCode);
  if (!parsed) return null;
  var body = parsed.body.split(/\r?\n/);
  var cleanup = removeGeneratedAssemblyDeadCode(body);
  body = cleanup.lines;

  var startRange = findMethodRange(body, 'Start');
  if (!startRange) return null;
  var updateRange = findMethodRange(body, 'Update');
  var checkRange = findMethodRange(body, 'CheckEventRules');
  var gameplayRange = findMethodRange(body, 'UpdateGameplayResourceLoop');
  var autoPlayUpdateRange = findMethodRange(body, 'AutoPlayUpdate');
  var maybeAssistRange = findMethodRange(body, 'MaybeAssistAutoPlayPhase');
  var shouldFallbackRange = findMethodRange(body, 'ShouldRunAutoPlayFallback');

  var startBlock = extractRangeFromLines(body, startRange);
  if (updateRange) {
    updateRange = findMethodRange(body, 'Update');
  }
  var updateBlock = updateRange ? extractRangeFromLines(body, updateRange) : [];
  if (checkRange) {
    checkRange = findMethodRange(body, 'CheckEventRules');
  }
  var checkBlock = checkRange ? extractRangeFromLines(body, checkRange) : [];

  autoPlayUpdateRange = findMethodRange(body, 'AutoPlayUpdate');
  var autoPlayUpdateBlock = autoPlayUpdateRange ? extractRangeFromLines(body, autoPlayUpdateRange) : [];
  maybeAssistRange = findMethodRange(body, 'MaybeAssistAutoPlayPhase');
  var maybeAssistBlock = maybeAssistRange ? extractRangeFromLines(body, maybeAssistRange) : [];
  shouldFallbackRange = findMethodRange(body, 'ShouldRunAutoPlayFallback');
  var shouldFallbackBlock = shouldFallbackRange ? extractRangeFromLines(body, shouldFallbackRange) : [];

  var sectionNames = {
    entity: /实体/,
    autoPlay: /自动推进/,
    phaseFlow: /阶段流程/,
    phaseHandlers: /阶段处理|建筑流程|敌方流程|我方单位流程|投射物流程|资源流程|镜头流程|系统流程/,
    preview: /预览状态/,
    input: /输入/,
    resource: /资源代码区/,
    sceneHelper: /场景辅助/,
    ui: /界面/
  };
  var entitySection = extractMatchingSectionsFromLines(body, sectionNames.entity);
  var autoPlaySection = extractMatchingSectionsFromLines(body, sectionNames.autoPlay);
  var phaseFlowSection = extractMatchingSectionsFromLines(body, sectionNames.phaseFlow);
  var phaseHandlerSection = extractMatchingSectionsFromLines(body, sectionNames.phaseHandlers);
  var previewSection = extractMatchingSectionsFromLines(body, sectionNames.preview);
  var inputSection = extractMatchingSectionsFromLines(body, sectionNames.input);
  var resourceSection = extractMatchingSectionsFromLines(body, sectionNames.resource);
  var sceneHelperSection = extractMatchingSectionsFromLines(body, sectionNames.sceneHelper);
  var uiSection = extractMatchingSectionsFromLines(body, sectionNames.ui);

  var spawnLines = extractMethodsMatchingFromLines(body, function(name) {
    return /^Spawn[A-Za-z0-9_]+$/.test(name);
  });
  var runtimeSystemLines = extractMethodsMatchingFromLines(body, function(name) {
    return /^Update(?!GameState$|PhaseTimer$)/.test(name) ||
      name === 'IsNear' ||
      name === 'AddGold' ||
      name === 'ShowFloatingText';
  });

  var sectionIdx = firstSectionIndex(body);
  var runtimeBlock = [];
  gameplayRange = findMethodRange(body, 'UpdateGameplayResourceLoop');
  if (gameplayRange) {
    runtimeBlock = body.slice(gameplayRange[0], sectionIdx);
    body.splice(gameplayRange[0], sectionIdx - gameplayRange[0]);
  }
  var stateBlock = body;
  var phaseSplit = splitPhaseFlowLines(phaseFlowSection);

  var mainLines = startBlock.concat([''], updateBlock, [''], checkBlock);
  var stateLines = stateBlock.concat([''], entitySection);
  var sceneLines = spawnLines.concat([''], sceneHelperSection);
  var runtimeLines = runtimeSystemLines.concat([''], runtimeBlock, [''], shouldFallbackBlock);
  var inputLines = inputSection;
  var uiLines = uiSection;
  var previewLines = previewSection.concat([''], resourceSection);
  var phaseContentLines = autoPlaySection.concat([''], phaseHandlerSection);
  var phaseSharedLines = phaseSplit.shared;
  var phaseSnapshotLines = phaseSplit.snapshot;
  var phaseInitLines = phaseSplit.init;
  var phaseTapLines = phaseSplit.tap;
  var phaseAutoLines = phaseSplit.auto;
  var phaseFlowLines = autoPlayUpdateBlock.concat([''], maybeAssistBlock, [''], phaseSplit.dispatch);

  var chain = [
    { fileName: 'GameFlowStateBase.cs', className: 'GameFlowStateBase', body: stateLines, desc: '// 状态、实体绑定、资源和低层场景辅助。' },
    { fileName: 'GameFlowSceneBase.cs', className: 'GameFlowSceneBase', body: sceneLines, desc: '// 对象池摆放、隐藏、缩放和生成兼容包装。' },
    { fileName: 'GameFlowRuntimeBase.cs', className: 'GameFlowRuntimeBase', body: runtimeLines, desc: '// 每帧运行时系统。' },
    { fileName: 'GameFlowInputBase.cs', className: 'GameFlowInputBase', body: inputLines, desc: '// 输入和玩家控制辅助。' },
    { fileName: 'GameFlowUiBase.cs', className: 'GameFlowUiBase', body: uiLines, desc: '// UI、CTA、状态 JSON 和 phase evidence 输出。' },
    { fileName: 'GameFlowPreviewBase.cs', className: 'GameFlowPreviewBase', body: previewLines, desc: '// Preview/CUA 状态导出和资源 API 门面。' },
    { fileName: 'GameFlowPhaseContentBase.cs', className: 'GameFlowPhaseContentBase', body: phaseContentLines, desc: '// Phase init、点击处理和 AutoPlay 阶段副作用。' },
    { fileName: 'GameFlowPhaseSharedBase.cs', className: 'GameFlowPhaseSharedBase', body: phaseSharedLines, desc: '// 阶段计时、进入、完成和卡点上报共享流程。' },
    { fileName: 'GameFlowPhaseSnapshotBase.cs', className: 'GameFlowPhaseSnapshotBase', body: phaseSnapshotLines, desc: '// 阶段入口快照辅助。' },
    { fileName: 'GameFlowPhaseInitBase.cs', className: 'GameFlowPhaseInitBase', body: phaseInitLines, desc: '// Phase 初始化处理器。' },
    { fileName: 'GameFlowPhaseTapBase.cs', className: 'GameFlowPhaseTapBase', body: phaseTapLines, desc: '// Phase 点击处理器。' },
    { fileName: 'GameFlowPhaseAutoBase.cs', className: 'GameFlowPhaseAutoBase', body: phaseAutoLines, desc: '// Phase AutoPlay 到达处理器。' },
    { fileName: 'GameFlowPhaseFlowBase.cs', className: 'GameFlowPhaseFlowBase', body: phaseFlowLines, desc: '// 阶段分发、AutoPlay tick 和 phase gate 顶层流程。' }
  ];

  // 仅保留有真实内容的层，跳过空壳子，使继承链按实际填充重新串接。
  var prevClass = 'MonoBehaviour';
  var keptLayers = [];
  var prunedLayers = [];
  chain.forEach(function(layer) {
    var trimmed = trimBlankLines(layer.body);
    if (trimmed.length === 0) {
      prunedLayers.push(layer.fileName);
      return;
    }
    keptLayers.push({
      fileName: layer.fileName,
      className: layer.className,
      parent: prevClass,
      body: trimmed,
      desc: layer.desc
    });
    prevClass = layer.className;
  });
  var mainParent = prevClass;

  // 删除上一次导出残留的空层文件（若本次被剔除而上一轮存在则会过期）。
  prunedLayers.forEach(function(name) {
    var stale = path.join(managerDir, name);
    if (fs.existsSync(stale)) {
      try { fs.unlinkSync(stale); } catch (e) {}
      var staleMeta = stale + '.meta';
      if (fs.existsSync(staleMeta)) {
        try { fs.unlinkSync(staleMeta); } catch (e) {}
      }
    }
  });

  var files = {};
  keptLayers.forEach(function(layer) {
    files[layer.fileName] = classCode(layer.className, layer.parent, layer.body, layer.desc);
  });
  files['GameFlowManagerMain.cs'] = mainCode(mainLines, mainParent);

  var lineCounts = {};
  Object.keys(files).forEach(function(fileName) {
    lineCounts[fileName] = writeGameFlowFile(managerDir, fileName, files[fileName]);
  });
  var maxLines = 0;
  Object.keys(lineCounts).forEach(function(name) {
    if (lineCounts[name] > maxLines) maxLines = lineCounts[name];
  });
  return {
    files: Object.keys(files).length,
    lineCounts: lineCounts,
    maxLines: maxLines,
    mainLines: lineCounts['GameFlowManagerMain.cs'] || 0,
    prunedEmptyLayers: prunedLayers,
    keptLayerNames: keptLayers.map(function(l) { return l.fileName; }),
    mainParent: mainParent,
    removedGeneratedAssemblyMethods: cleanup.removedMethods,
    removedGeneratedAssemblyFields: cleanup.removedFields
  };
}

function transformManagerPartialsForProgrammerDelivery(root) {
  var summary = {
    changed: false,
    managerDir: '',
    partialFilesMerged: 0,
    partialFilesRemoved: 0,
    staleMetaRemoved: 0,
    entityClassFiles: 0,
    entityModelCount: 0,
    generatedGameFlowFiles: 0,
    gameFlowMainLines: 0,
    maxGameFlowScriptLines: 0,
    removedGeneratedAssemblyMethods: 0,
    removedGeneratedAssemblyFields: 0
  };
  var managerDir = findManagerDir(root);
  if (!managerDir) return summary;
  summary.managerDir = managerDir;
  var mainFile = path.join(managerDir, 'GameFlowManagerMain.cs');
  if (!fs.existsSync(mainFile)) return summary;

  var mainInfo = extractManagerClassInfo(mainFile);
  if (!mainInfo) return summary;
  var existingLayerStats = existingGameFlowLayerStats(managerDir);
  if (existingLayerStats.files) {
    summary.generatedGameFlowFiles = existingLayerStats.files;
    summary.gameFlowMainLines = existingLayerStats.mainLines;
    summary.maxGameFlowScriptLines = existingLayerStats.maxLines;
  }
  summary.entityClassFiles = existingEntityClassFileCount(managerDir);
  summary.entityModelCount = existingEntityModelCount(managerDir);
  var names = fs.readdirSync(managerDir)
    .filter(function(name) { return /^GameFlowManagerMain\..+\.cs$/.test(name); })
    .sort();
  var companions = [];
  for (var i = 0; i < names.length; i++) {
    var info = extractManagerClassInfo(path.join(managerDir, names[i]));
    if (info) companions.push(info);
  }

  var allCode = [mainInfo.code].concat(companions.map(function(info) { return info.code; })).join('\n');
  var entities = collectEntityInfos(allCode);
  var entitySummary = writeEntityClassFiles(managerDir, entities);
  summary.entityClassFiles = entitySummary.files || summary.entityClassFiles;
  summary.entityModelCount = entities.length || summary.entityModelCount;

  var shouldRewriteMain = mainInfo.isPartial || companions.length > 0 || entities.length > 0;
  if (shouldRewriteMain) {
    var merged = composeMergedManagerCode(mainInfo, companions, entities);
    var splitSummary = splitMergedManagerIntoDeliveryClasses(managerDir, merged);
    if (!splitSummary) {
      fs.writeFileSync(mainFile, merged);
      ensureUnityMeta(mainFile);
    } else {
      summary.generatedGameFlowFiles = splitSummary.files;
      summary.gameFlowMainLines = splitSummary.mainLines;
      summary.maxGameFlowScriptLines = splitSummary.maxLines;
      summary.removedGeneratedAssemblyMethods = splitSummary.removedGeneratedAssemblyMethods;
      summary.removedGeneratedAssemblyFields = splitSummary.removedGeneratedAssemblyFields;
      summary.prunedEmptyLayers = splitSummary.prunedEmptyLayers || [];
      summary.keptLayerNames = splitSummary.keptLayerNames || [];
      summary.mainParent = splitSummary.mainParent || '';
    }
    summary.changed = true;
  }

  for (var j = 0; j < companions.length; j++) {
    if (removeIfExists(companions[j].file)) summary.partialFilesRemoved++;
    if (removeIfExists(companions[j].file + '.meta')) summary.staleMetaRemoved++;
  }
  summary.partialFilesMerged = companions.length;
  return summary;
}

function rewriteReadmeForProgrammerDelivery(root) {
  var file = path.join(root, 'README.md');
  if (!fs.existsSync(file)) return false;
  var text = fs.readFileSync(file, 'utf8');
  var before = text;
  var boundary = [
    '## 程序员交付边界',
    '',
    '- `GameFlowManagerMain.cs` 负责 Unity 挂载入口、启动、主 `Update()` 调度和阶段出口；交付版不再使用 C# 拆分类组织主流程。',
    '- 业务逻辑按内容拆到普通 `GameFlow*Base.cs` 继承链，仅生成有实际成员的层；空层会被剔除并把继承链跳过去，每个脚本保持在 1000 行以内。',
    '- `Assets/Program/Script/Manager/Entities/` 中的实体类承载领域属性，例如 `BaseBuildElement`、`BuildEntity`、`BarrackEntity`。',
    '- 新增建筑、兵营、炮塔、资源、战斗单位时，优先新增或扩展 `Entities/` 下的具体类。',
    '- 实体引用只来自 `RegisterEntityBindings()/GameSceneCtrl`，不要在业务代码里二次 `GameObject.Find("__Pool_*")` 覆盖字段。',
    '- 资源 API 使用 `GFM_ResourceIds` 常量或 `GFM_ResourceIds.Normalize("...")`，不要裸写 `"gold"`/`"Gold"`。',
    '- 引导文案统一调用 `SetGuideText()`；`guideText.text` 只应在这个 helper 内落地。',
    ''
  ].join('\n');
  text = text.replace(
    /- Assets\/Program\/Script\/Manager\/\s+—[^\n]*/g,
    '- Assets/Program/Script/Manager/  — GameFlowManagerMain.cs 主入口、GameFlow*Base.cs 普通基类分层与 Entities/ 面向对象实体类'
  );
  if (/## 程序员交付边界\n/.test(text)) {
    text = text.replace(/## 程序员交付边界\n[\s\S]*?(?=\n## |$)/, boundary);
  }
  text = text.replace(
    /- GameFlowManagerMain\.cs 负责[^\n]*\n- Flow\/Input\/Resource\/UI\/Scene partial[^\n]*\n/g,
    '- `GameFlowManagerMain.cs` 负责启动、主 `Update()` 调度和阶段流程协调；交付版不再使用 C# 拆分类组织主流程。\n' +
    '- `GameFlow*Base.cs` 通过普通继承链按内容拆分业务逻辑（仅生成有实际成员的层，空层会被剔除），避免单脚本超过 1000 行。\n' +
    '- `Assets/Program/Script/Manager/Entities/` 中的实体类承载领域属性，例如 `BaseBuildElement`、`BuildEntity`、`BarrackEntity`。\n'
  );
  text = text.replace(
    /- 玩法主流程从 `GameFlowManagerMain\.cs` 和 `GameFlowManagerMain\.Flow\*\.cs` 开始阅读。/g,
    '- 玩法主流程从 `GameFlowManagerMain.cs` 开始阅读，实体领域属性从 `Entities/` 目录进入。'
  );
  text = text.split('\n').filter(function(line) {
    if (/GameFlowManagerMain\.(?:Entities|Flow|Phases|PreviewState|Scene|Input|Resource|UI)/.test(line)) return false;
    if (/\bpartial\b/i.test(line)) return false;
    if (/AssemblySlot|AssemblyRun/.test(line)) return false;
    if (/Scene\.Entities|Scene\.Camera|Flow\./.test(line)) return false;
    return true;
  }).join('\n');
  if (text !== before) fs.writeFileSync(file, text);
  return text !== before;
}

function writeHandoff(root, project, summary) {
  var id = project && project.id ? project.id : '';
  var name = project && project.name ? project.name : id;
  var mergedCount = stableHandoffStat(root, '合并的 GameFlowManagerMain companion 文件数', summary.partialFilesMerged || 0);
  var removedCompanionCount = stableHandoffStat(root, '删除的 GameFlowManagerMain companion 文件数', summary.partialFilesRemoved || 0);
  var removedToolCount = stableHandoffStat(root, '移除 tools 目录数', summary.removedToolDirs || 0);
  var gameFlowMainLines = summary.gameFlowMainLines || 0;
  var maxGameFlowScriptLines = summary.maxGameFlowScriptLines || 0;
  // 仅引用本次导出实际生成的层，避免在文档里点名已被剔除的层文件。
  var keptLayerNames = Array.isArray(summary.keptLayerNames) ? summary.keptLayerNames : [];
  var keptLayersText = keptLayerNames
    .slice()
    .reverse()
    .map(function(name) { return '`' + name + '`'; })
    .join(' → ');
  var lines = [
    '# 程序员交付版说明',
    '',
    '项目：' + (name || '未命名') + (id ? ' (' + id + ')' : ''),
    '生成时间：' + new Date().toISOString(),
    '',
    '## 已清理内容',
    '- 移除 Blueprint/CUA 自动验证用的机器契约注释和 TODO 边界标记。',
    '- 移除 `BlueprintArtifacts/` 这类仅供流水线追踪的验证附件。',
    '- 移除根目录 `tools/`，避免把构建/转换辅助脚本提交给程序员交付仓库。',
    '- 将 `GameFlowManagerMain*.cs` companion 拆分类转换为普通继承基类分层，交付版不再定义 C# 拆分类主流程。',
    '- 仅保留有实际成员的 `GameFlow*Base.cs` 层，空层会被剔除并把继承链跳到下一层非空类，避免出现 13 个空壳子假装的多层继承。',
    '- 移除默认关闭的生成遗留路径，避免程序员维护死代码。',
    '- 生成 `Assets/Program/Script/Manager/Entities/` 领域类：`BaseBuildElement` 承载生命、攻击、等级等建筑通用属性，具体实体类继承对应基类。',
    '',
    '## 后续维护建议',
    keptLayersText
      ? '- 玩法主流程从 `GameFlowManagerMain.cs` 的 `Start()`、`Update()`、`CheckEventRules()` 开始阅读，再沿继承链进入：' + keptLayersText + '；其它 `GameFlow*Base.cs` 在本次导出里没有内容，已被剔除。'
      : '- 玩法主流程从 `GameFlowManagerMain.cs` 的 `Start()`、`Update()`、`CheckEventRules()` 开始阅读；本次导出未拆分出额外的 `GameFlow*Base.cs` 层。',
    '- 建筑、资源、战斗单位等领域属性优先放在 `Entities/` 下的具体类，不要再新增 `GameFlowManagerMain.*.cs` 分类文件。',
    '- `GFM_*.cs` 是通用工具库；业务逻辑优先写在主流程或实体领域类中，不要直接改工具库公共行为。',
    '',
    '## 清理统计',
    '- C# 文件处理数：' + summary.csFiles,
    '- 修改的 C# 文件数：' + summary.changedFiles,
    '- 合并的 GameFlowManagerMain companion 文件数：' + mergedCount,
    '- 删除的 GameFlowManagerMain companion 文件数：' + removedCompanionCount,
    '- 生成的 GameFlow 普通基类文件数：' + (summary.generatedGameFlowFiles || 0),
    '- 剔除的空 GameFlow 基类层数：' + ((summary.prunedEmptyLayers && summary.prunedEmptyLayers.length) || 0),
    '- GameFlowManagerMain.cs 行数：' + gameFlowMainLines,
    '- 最长 GameFlow 脚本行数：' + maxGameFlowScriptLines,
    '- 移除默认关闭生成遗留方法数：' + (summary.removedGeneratedAssemblyMethods || 0),
    '- 生成的实体领域类文件数：' + (summary.entityClassFiles || 0),
    '- 绑定的实体模型数：' + (summary.entityModelCount || 0),
    '- 移除机器契约注释行：' + summary.removedContractComments,
    '- 移除验证附件目录数：' + summary.removedArtifactDirs,
    '- 移除 tools 目录数：' + removedToolCount
  ];
  fs.writeFileSync(path.join(root, 'PROGRAMMER_HANDOFF.md'), lines.join('\n') + '\n');
}

function stableHandoffStat(root, label, current) {
  var value = Number(current) || 0;
  if (value > 0) return value;
  var file = path.join(root, 'PROGRAMMER_HANDOFF.md');
  if (!fs.existsSync(file)) return value;
  var text = fs.readFileSync(file, 'utf8');
  var escaped = String(label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp('- ' + escaped + '：([0-9]+)');
  var match = re.exec(text);
  if (!match) return value;
  var previous = Number(match[1]);
  return previous > value ? previous : value;
}

function cleanProgrammerDelivery(root, options) {
  options = options || {};
  var summary = {
    root: root,
    csFiles: 0,
    changedFiles: 0,
    removedContractComments: 0,
    removedArtifactDirs: 0,
    removedToolDirs: 0,
    handoff: path.join(root, 'PROGRAMMER_HANDOFF.md')
  };

  var artifactDir = path.join(root, 'BlueprintArtifacts');
  if (removeIfExists(artifactDir)) summary.removedArtifactDirs++;
  var toolsDir = path.join(root, 'tools');
  if (removeIfExists(toolsDir)) summary.removedToolDirs++;

  var files = walkFiles(root);
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (path.extname(file).toLowerCase() !== '.cs') continue;
    summary.csFiles++;
    var before = fs.readFileSync(file, 'utf8');
    var result = cleanCSharpForProgrammerDelivery(before);
    if (!result.changed) continue;
    fs.writeFileSync(file, result.code);
    summary.changedFiles++;
    summary.removedContractComments += result.removedContractComments;
  }

  var transformSummary = transformManagerPartialsForProgrammerDelivery(root);
  Object.keys(transformSummary).forEach(function(key) {
    summary[key] = transformSummary[key];
  });
  if (transformSummary.changed) summary.changedFiles++;
  rewriteReadmeForProgrammerDelivery(root);

  writeHandoff(root, options.project || {}, summary);
  var graphSummary = codeRelationGraphWriter.writeCodeRelationGraphs(root, {
    projectId: options.project && options.project.id,
    projectName: options.project && options.project.name
  });
  summary.codeRelationGraph = graphSummary;

  // 反馈 01 (2026-04-26) Phase B.1: non-blocking 类/方法/嵌套规模告警。
  // 运行在 clean+transform 之后,反映程序员实际看到的产物。
  try {
    var deliveryClassValidator = require('../engine/delivery-class-validator.cjs');
    summary.warnings = deliveryClassValidator.validateDeliveryDirectory(root, options.validatorOpts);
  } catch (e) {
    summary.warnings = [];
    summary.validatorError = e.message + (e.stack ? '\n' + e.stack : '');
  }

  return summary;
}

module.exports = {
  cleanCSharpForProgrammerDelivery: cleanCSharpForProgrammerDelivery,
  cleanProgrammerDelivery: cleanProgrammerDelivery,
  shouldDropContractComment: shouldDropContractComment,
  transformManagerPartialsForProgrammerDelivery: transformManagerPartialsForProgrammerDelivery,
  findMatchingBrace: findMatchingBrace
};

if (require.main === module) {
  var target = process.argv[2];
  if (!target) {
    console.error('Usage: node lib/programmer-delivery-cleaner.cjs <delivery-root> [projectId] [projectName]');
    process.exit(2);
  }
  var projectId = process.argv[3] || path.basename(path.resolve(target));
  var projectName = process.argv[4] || projectId;
  var summary = cleanProgrammerDelivery(target, {
    project: { id: projectId, name: projectName }
  });
  console.log(JSON.stringify(summary, null, 2));
}
