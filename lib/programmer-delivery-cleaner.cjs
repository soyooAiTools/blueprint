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

// Wave 1 / C5：分镜级注释白名单 — 这些注释面向程序员，永远不要 drop。
// 即使后续有人扩大 drop 规则，命中以下 pattern 都先放行。
function isShotDocComment(text) {
  var t = String(text || '').trim();
  if (!t) return false;
  if (/^Shot\s+\d+/i.test(t)) return true;
  if (/^Phase\s+\d+/i.test(t)) return true;
  if (/^Phase:\s+/i.test(t)) return true;
  if (/^标题[:：]/.test(t)) return true;
  if (/^时长[:：]/.test(t)) return true;
  if (/^操作[:：]/.test(t)) return true;
  if (/^入画(物体)?[:：]/.test(t)) return true;
  if (/^退出条件[:：]/.test(t)) return true;
  if (/^─{5,}/.test(t)) return true;
  return false;
}

function shouldDropContractComment(text) {
  var t = String(text || '').trim();
  if (!t) return false;
  if (isShotDocComment(t)) return false;
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
    path.join(root, 'Assets', 'Scripts', 'Manager'),
    path.join(root, 'Assets', 'Scripts'),
    path.join(root, 'Assets', 'Script', 'Manager'),
    path.join(root, 'Assets', 'Script'),
    path.join(root, 'Assets', 'Program', 'Script', 'Manager'),
    path.join(root, 'Scripts'),
    root
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i]) && fs.statSync(candidates[i]).isDirectory()) {
      if (fs.existsSync(path.join(candidates[i], 'GameFlowManagerMain.cs'))) return candidates[i];
      if (fs.existsSync(path.join(candidates[i], 'MainManager.cs'))) return candidates[i];
    }
  }
  for (var j = 0; j < candidates.length; j++) {
    if (fs.existsSync(candidates[j]) && fs.statSync(candidates[j]).isDirectory()) return candidates[j];
  }
  return null;
}

function relativeUnix(root, target) {
  return path.relative(root, target).replace(/\\/g, '/');
}

function isReferenceScriptsManagerDir(managerDir) {
  var base = path.basename(managerDir).toLowerCase();
  var parent = path.basename(path.dirname(managerDir)).toLowerCase();
  return base === 'manager' && (parent === 'scripts' || parent === 'script');
}

function isReferenceScriptsRootDir(managerDir) {
  var base = path.basename(managerDir).toLowerCase();
  var parent = path.basename(path.dirname(managerDir)).toLowerCase();
  return (base === 'scripts' || base === 'script') && parent === 'assets';
}

function isReferenceScriptsLayout(managerDir) {
  return isReferenceScriptsManagerDir(managerDir) || isReferenceScriptsRootDir(managerDir);
}

function resolveEntityDir(managerDir) {
  if (isReferenceScriptsManagerDir(managerDir)) {
    return path.join(path.dirname(managerDir), 'Entities');
  }
  if (isReferenceScriptsRootDir(managerDir)) {
    return path.join(managerDir, 'Entities');
  }
  return path.join(managerDir, 'Entities');
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
    var key = toCamel(name).toLowerCase();
    if (found[key]) continue;
    found[key] = true;
    out.push({
      name: name,
      pool: match[2] || '',
      className: entityClassName(name),
      modelField: toMemberNameFromIdentifier(entityClassName(name) + 'Model'),
      baseClass: baseClassForEntity(name)
    });
  }
  return out;
}

function ensureUnityMeta(file) {
  var meta = file + '.meta';
  if (fs.existsSync(meta)) return false;
  var normalized = String(file || '').replace(/\\/g, '/');
  var idx = normalized.indexOf('/Assets/');
  var seed = idx >= 0 ? normalized.slice(idx + 1) : normalized;
  var guid = crypto.createHash('sha1').update('programmer-delivery-meta:' + seed).digest('hex').slice(0, 32);
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

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toMemberNameFromIdentifier(name) {
  var clean = String(name || '').replace(/^_+/, '');
  if (!clean) return '_value';
  clean = clean.replace(/_+([A-Za-z0-9])/g, function(_, c) { return c.toUpperCase(); });
  return '_' + clean.charAt(0).toLowerCase() + clean.slice(1);
}

function toPrivateFieldName(name) {
  var text = String(name || '');
  if (/^_[a-z]/.test(text)) return text;
  var m = /^m([A-Z][A-Za-z0-9_]*)$/.exec(text);
  if (m) return '_' + m[1].charAt(0).toLowerCase() + m[1].slice(1);
  return toMemberNameFromIdentifier(text);
}

function replaceOutsideStringLiterals(text, replaceSegment) {
  var input = String(text || '');
  var out = '';
  var segment = '';
  var mode = 'code';
  var quote = '';
  var verbatim = false;

  function flushSegment() {
    if (segment) {
      out += replaceSegment(segment);
      segment = '';
    }
  }

  for (var i = 0; i < input.length; i++) {
    var c = input[i];
    var next = input[i + 1];
    if (mode === 'code') {
      if (c === '@' && next === '"') {
        flushSegment();
        out += c + next;
        i++;
        mode = 'string';
        quote = '"';
        verbatim = true;
        continue;
      }
      if (c === '"' || c === "'") {
        flushSegment();
        out += c;
        mode = 'string';
        quote = c;
        verbatim = false;
        continue;
      }
      segment += c;
      continue;
    }

    out += c;
    if (verbatim && quote === '"' && c === '"' && next === '"') {
      out += next;
      i++;
      continue;
    }
    if (!verbatim && c === '\\') {
      if (i + 1 < input.length) {
        out += input[i + 1];
        i++;
      }
      continue;
    }
    if (c === quote) {
      mode = 'code';
      quote = '';
      verbatim = false;
    }
  }
  flushSegment();
  return out;
}

function replaceIdentifierOutsideStrings(text, oldName, newName) {
  if (!oldName || oldName === newName) return text;
  var re = new RegExp('\\b' + escapeRegExp(oldName) + '\\b', 'g');
  return replaceOutsideStringLiterals(text, function(segment) {
    return segment.replace(re, newName);
  });
}

function collectUnderscoreIdentifierMap(text) {
  var map = Object.create(null);
  replaceOutsideStringLiterals(text, function(segment) {
    segment.replace(/_+[A-Za-z][A-Za-z0-9_]*/g, function(name) {
      if (/^__Pool_/.test(name)) return name;
      map[name] = toMemberNameFromIdentifier(name);
      return name;
    });
    return segment;
  });
  return map;
}

function normalizeScriptNaming(code) {
  var text = String(code || '').replace(/\bGFM_/g, 'GMP_');
  text = replaceOutsideStringLiterals(text, function(segment) {
    return segment
      .replace(/\bHasInstance\b/g, 'hasCurrent')
      .replace(/\bhasInstance\b/g, 'hasCurrent')
      .replace(/\bInstance\b/g, 'instance');
  });

  var map = collectUnderscoreIdentifierMap(text);
  replaceOutsideStringLiterals(text, function(segment) {
    segment.replace(/\bm[A-Z][A-Za-z0-9_]*/g, function(name) {
      map[name] = toPrivateFieldName(name);
      return name;
    });
    return segment;
  });
  Object.keys(map).sort(function(a, b) { return b.length - a.length; }).forEach(function(oldName) {
    text = replaceIdentifierOutsideStrings(text, oldName, map[oldName]);
  });
  text = text.replace(/\b(GMP_ResourceIds)\._([A-Za-z][A-Za-z0-9_]*)/g, function(_, owner, name) {
    return owner + '.' + name.charAt(0).toUpperCase() + name.slice(1);
  });
  text = text.replace(/^\s*\/\/\s*(?:TODO|FIXME|HACK|XXX)\b.*$/gm, '');
  text = text.replace(/^\s*(?:UnityEngine\.)?Debug\.Log\s*\([^;\n]*\);\s*$/gm, '');
  return text;
}

function removeRuntimeSceneObjectCreation(code) {
  var text = String(code || '');
  text = replaceOutsideStringLiterals(text, function(segment) {
    return segment
      .replace(/\bnew\s+GameObject\s*\[/g, 'new UnityEngine.GameObject[')
      .replace(/\bnew\s+GameObject\s*\(/g, 'GMP_SceneObjectRegistry.Find(')
      .replace(/new GameObject/g, '场景对象')
      .replace(/(\b[A-Za-z_][A-Za-z0-9_]*\b)\s*=\s*(\b[A-Za-z_][A-Za-z0-9_]*\b)\.AddComponent<([^>]+)>\(\);/g,
        '$1 = $2 != null ? $2.GetComponent<$3>() : null;');
  });
  return text;
}

function buildSceneObjectRegistryCode() {
  return [
    'using UnityEngine;',
    '',
    '/// <summary>',
    '/// 程序员交付版场景对象查询工具：脚本物体应预先挂在 Game.unity 中。',
    '/// </summary>',
    'public static class GMP_SceneObjectRegistry',
    '{',
    '    /// <summary>',
    '    /// 按名称查找场景中已经挂好的对象；找不到时返回 null，不在运行时创建。',
    '    /// </summary>',
    '    public static GameObject Find(string name)',
    '    {',
    '        return string.IsNullOrEmpty(name) ? null : GameObject.Find(name);',
    '    }',
    '',
    '    /// <summary>',
    '    /// 兼容旧的对象构造调用形态；组件类型只作为注释性参数，实际对象必须来自场景。',
    '    /// </summary>',
    '    public static GameObject Find(string name, params System.Type[] componentTypes)',
    '    {',
    '        return Find(name);',
    '    }',
    '}'
  ].join('\n');
}

function buildBaseGameFlowEntityCode() {
  return [
    'using System.Collections;',
    'using UnityEngine;',
    '',
    '// 交付版实体基类：封装蓝图实体和场景 GameObject 的绑定关系。',
    'public class BaseGameFlowEntity : MonoBehaviour',
    '{',
    '    // 反馈 01：Unity 的 CreatePrimitive / 资源加载会留下 "Cube"/"Sphere" 等无意义默认名,',
    '    // 运行时 Hierarchy 上看到一堆未命名的物体。Bind 时按 DisplayName 统一覆盖,',
    '    // 但保留对象池前缀 "__Pool_" 以维持池命名约定。',
    '    static readonly string[] PrimitiveDefaultNames = { "Cube", "Sphere", "Cylinder", "Capsule", "Plane", "Quad", "GameObject" };',
    '',
    '    public string EntityId = ""; // 蓝图实体 ID，用于和 GameSceneCtrl 注册名对齐。',
    '    public string DisplayName = ""; // 程序员可读名称，用于调试、日志和后续 UI 展示。',
    '    public GameObject SourceObject; // 实体绑定的场景对象；为空时退回当前组件所在对象。',
    '    public int State = 0; // 通用状态位：0=未初始化、1=进行中、2=完成、3=失效。',
    '',
    '    // 绑定场景对象和蓝图标识；由 GameFlowStateBase.BindGameFlowEntityModels() 调用。',
    '    public virtual void Bind(GameObject source, string entityId, string displayName)',
    '    {',
    '        SourceObject = source != null ? source : gameObject;',
    '        EntityId = string.IsNullOrEmpty(entityId) ? FallbackEntityId() : entityId;',
    '        DisplayName = string.IsNullOrEmpty(displayName) ? EntityId : displayName;',
    '        ApplyDomainName(SourceObject);',
    '    }',
    '',
    '    // 仅当当前名为空 / 是 Unity primitive 默认名时才覆盖;池前缀保留。',
    '    void ApplyDomainName(GameObject obj)',
    '    {',
    '        if (obj == null) return;',
    '        var current = obj.name == null ? string.Empty : obj.name;',
    '        if (string.IsNullOrEmpty(current)) { obj.name = DisplayName; return; }',
    '        if (current.StartsWith("__Pool_")) return;',
    '        for (int i = 0; i < PrimitiveDefaultNames.Length; i++)',
    '        {',
    '            var prefix = PrimitiveDefaultNames[i];',
    '            if (current == prefix || current.StartsWith(prefix + " ("))',
    '            {',
    '                obj.name = DisplayName;',
    '                return;',
    '            }',
    '        }',
    '    }',
    '',
    '    // 蓝图未指定 EntityId 时的兜底:用类型名 + 运行时 InstanceID,保证全局唯一可调试。',
    '    string FallbackEntityId()',
    '    {',
    '        return GetType().Name + "_" + GetInstanceID();',
    '    }',
    '',
    '    // 控制实体可见性；交付版维护时可在这里统一接入动画或特效。',
    '    public virtual void SetVisible(bool visible)',
    '    {',
    '        if (SourceObject != null) SourceObject.SetActive(visible);',
    '    }',
    '',
    '    // 即时定位:仅在初始化 / 复位 / pool 取出 时使用,运行中位移请走 MoveToPosition。',
    '    public virtual void SetPosition(Vector3 position)',
    '    {',
    '        if (SourceObject != null) SourceObject.transform.position = position;',
    '    }',
    '',
    '    // 反馈 01 #5：SHOT 推演物体位移走 lerp 过渡,不再瞬移。duration 默认 0.4s,与镜头 lerp 节奏一致;',
    '    // 调用方需要立即落位时仍可用 SetPosition。MonoBehaviour 已被 disable / 销毁时自动放弃。',
    '    public virtual void MoveToPosition(Vector3 target, float duration = 0.4f)',
    '    {',
    '        if (SourceObject == null) return;',
    '        if (duration <= 0f) { SourceObject.transform.position = target; return; }',
    '        StopCoroutine("MoveToPositionCoroutine");',
    '        StartCoroutine(MoveToPositionCoroutine(target, duration));',
    '    }',
    '',
    '    // MoveToPosition 的协程实现:用 smoothstep 缓动从 startPos 推到 target;协程被打断时静默退出。',
    '    private IEnumerator MoveToPositionCoroutine(Vector3 target, float duration)',
    '    {',
    '        if (SourceObject == null) yield break;',
    '        Vector3 startPos = SourceObject.transform.position;',
    '        float elapsed = 0f;',
    '        while (elapsed < duration)',
    '        {',
    '            if (SourceObject == null) yield break;',
    '            elapsed += Time.deltaTime;',
    '            float t = Mathf.Clamp01(elapsed / duration);',
    '            // smoothstep:起步/结束更柔和,中段加速,符合 "丝滑" 体感。',
    '            t = t * t * (3f - 2f * t);',
    '            SourceObject.transform.position = Vector3.LerpUnclamped(startPos, target, t);',
    '            yield return null;',
    '        }',
    '        if (SourceObject != null) SourceObject.transform.position = target;',
    '    }',
    '}'
  ].join('\n');
}

function buildBaseBuildElementCode() {
  return [
    'using UnityEngine;',
    '',
    '// 建筑实体基类：承载建筑共有的生命、攻击和等级属性。',
    'public class BaseBuildElement : BaseGameFlowEntity',
    '{',
    '    public int Health = 100; // 建筑耐久值，后续受攻击或维修系统统一修改。',
    '    public int Attack = 0; // 建筑攻击力；防御塔、兵营等攻击型建筑会使用。',
    '    public int Level = 1; // 建筑等级；升级流程只修改这个字段和派生属性。',
    '',
    '    // 标记建筑已完成建造，供流程 gate 和程序员调试读取。',
    '    public virtual void MarkBuilt()',
    '    {',
    '        State = 2;',
    '    }',
    '',
    '    // 执行一次通用升级，并同步提高生命和攻击属性。',
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
    '// 蓝图实体 ID，用于和 GameFlowStateBase 的绑定字段对应。',
    'public const string Id = "' + csString(entity.name) + '";'
  ];
  if (entity.pool) {
    lines.push('// 对象池资源名，用于追溯该实体来自哪个预烘焙 GameObject。');
    lines.push('public const string PoolObjectName = "' + csString(entity.pool) + '";');
  }
  return buildSimpleClassCode(entity.className, entity.baseClass, lines);
}

function writeEntityClassFiles(managerDir, entities) {
  if (!entities.length) return { files: 0, metas: 0, dir: '' };
  var entityDir = resolveEntityDir(managerDir);
  fs.mkdirSync(entityDir, { recursive: true });
  var files = [
    { name: 'BaseGameFlowEntity.cs', code: buildBaseGameFlowEntityCode() },
    { name: 'BaseBuildElement.cs', code: buildBaseBuildElementCode() },
    { name: 'BuildEntity.cs', code: buildSimpleClassCode('BuildEntity', 'BaseBuildElement', []) },
    { name: 'CombatEntity.cs', code: buildSimpleClassCode('CombatEntity', 'BaseGameFlowEntity', [
      'public int Health = 100; // 战斗单位生命值，受到伤害时递减到 0。',
      'public int Attack = 10; // 战斗单位攻击力，由战斗流程读取。',
      'public int Level = 1; // 战斗单位等级，升级或强化时递增。',
      '',
      '// 扣除生命值并在归零时把实体状态标记为失效。',
      'public virtual void ApplyDamage(int amount)',
      '{',
      '    Health = Mathf.Max(0, Health - Mathf.Max(0, amount));',
      '    if (Health == 0) State = 3;',
      '}'
    ]) },
    { name: 'ResourceEntity.cs', code: buildSimpleClassCode('ResourceEntity', 'BaseGameFlowEntity', [
      'public int Amount = 1; // 当前可收集数量，采集完成后归零。',
      '',
      '// 一次性收集全部资源，并返回本次获得的数量。',
      'public virtual int CollectAll()',
      '{',
      '    int value = Mathf.Max(0, Amount);',
      '    Amount = 0;',
      '    State = 2;',
      '    return value;',
      '}'
    ]) },
    // 反馈 01 #1 / #8 架构图:玩家/NPC 走独立领域基类,与 BaseBuildElement/Combat/Resource 同级
    // PlayerBase 在 C# 单继承约束下用 static Instance 表达"场景里只一个 Player"的图意;
    // 不真改基类,避免和 BaseGameFlowEntity 的领域血缘冲突。
    { name: 'PlayerBase.cs', code: buildSimpleClassCode('PlayerBase', 'BaseGameFlowEntity', [
      '// 反馈 01 #8 架构图:Player 走单例语义。Awake 时把自己写入 Instance,',
      '// 调用方用 PlayerBase.Instance.MoveByDirection(...) 全局可达。',
      'public static PlayerBase Instance { get; private set; }',
      '',
      'public float MoveSpeed = 4f; // 玩家移动速度,direction.normalized * (speed * dt) 的乘子。',
      'public int Score = 0; // 玩家累计得分,只能通过 AddScore 修改以保持非负。',
      '',
      '// Unity 生命周期入口:第一次激活时把自己注册为全局 Instance。',
      '// 重复激活时不覆盖已有 Instance,避免场景重载或 prefab 误克隆破坏单例语义。',
      'protected virtual void Awake()',
      '{',
      '    if (Instance == null) Instance = this;',
      '}',
      '',
      '// 按方向移动玩家;direction 可不归一化,内部会按 normalized 计算。',
      '// dt 是本帧时间,通常传 Time.deltaTime;dt<=0 或方向为 0 时直接 return。',
      'public virtual void MoveByDirection(Vector3 direction, float dt)',
      '{',
      '    if (SourceObject == null) return;',
      '    if (direction.sqrMagnitude < 0.0001f) return;',
      '    SourceObject.transform.position += direction.normalized * (MoveSpeed * dt);',
      '}',
      '',
      '// 累加分数并钳制下界为 0,防止负分破坏 UI/排行计算。',
      'public virtual void AddScore(int delta)',
      '{',
      '    Score = Mathf.Max(0, Score + delta);',
      '}'
    ]) },
    // 反馈 01 #8 架构图:NPCBase 必须包含"名字 / 血条 UI / 攻击信息";
    // DisplayName 已在 BaseGameFlowEntity 提供,这里补 HealthBar(UI 引用)和攻击属性。
    { name: 'NPCBase.cs', code: [
      'using UnityEngine;',
      'using UnityEngine.UI;',
      '',
      '// NPC 领域基类:含名字 / 血条 UI / 攻击信息(反馈 01 #8 架构图)。',
      'public class NPCBase : BaseGameFlowEntity',
      '{',
      '    // ====================================================================',
      '    // 【反馈 01 #8 架构图】NPC 必备三段信息:名字 / 血条 UI / 攻击。',
      '    // 名字直接复用基类 DisplayName,不在这里 redeclare。',
      '    // ====================================================================',
      '',
      '    public Slider HealthBar; // 血条 UI 引用,具体敌人类在 Bind 后设置;为 null 时静默跳过刷新。',
      '    public int Health = 100; // 当前生命值,降到 0 时把 State 标 3 并隐藏血条。',
      '    public int MaxHealth = 100; // 满血生命值,用于计算血条 fill ratio。',
      '',
      '    public int AttackDamage = 10; // 单次攻击造成的伤害,具体敌人类可覆写。',
      '    public float AttackRange = 1.5f; // 触发攻击的距离阈值,单位与场景一致(米)。',
      '    public float AttackCooldown = 1f; // 两次攻击之间的最小间隔(秒)。',
      '    private float _lastAttackTime = -999f; // 上次攻击的 Time.time,用于冷却计算。',
      '',
      '    // ====================================================================',
      '    // 【巡逻状态】保持 NPCBase 历史接口,具体敌人类按需覆写或忽略。',
      '    // ====================================================================',
      '    public float PatrolSpeed = 2f; // 巡逻速度,m/s。',
      '    public Vector3 TargetPosition; // 当前巡逻目标点,Set/Clear Target 维护。',
      '    public bool HasTarget = false; // 是否有有效巡逻目标。',
      '',
      '    // 设置巡逻目标点并打开 HasTarget 标志,TickPatrol 才会真正移动。',
      '    public virtual void SetTarget(Vector3 target)',
      '    {',
      '        TargetPosition = target;',
      '        HasTarget = true;',
      '    }',
      '',
      '    // 清除巡逻目标,下一帧 TickPatrol 立即停止。',
      '    public virtual void ClearTarget()',
      '    {',
      '        HasTarget = false;',
      '    }',
      '',
      '    // 每帧推进一次巡逻;dt 通常是 Time.deltaTime。已经接近目标时自动 ClearTarget。',
      '    public virtual void TickPatrol(float dt)',
      '    {',
      '        if (!HasTarget || SourceObject == null) return;',
      '        Vector3 pos = SourceObject.transform.position;',
      '        Vector3 delta = TargetPosition - pos;',
      '        if (delta.sqrMagnitude < 0.01f) { HasTarget = false; return; }',
      '        SourceObject.transform.position = pos + delta.normalized * (PatrolSpeed * dt);',
      '    }',
      '',
      '    // ====================================================================',
      '    // 【血条 UI】受击后调用 RefreshHealthBar 同步显示。Slider 为 null 时安静返回。',
      '    // ====================================================================',
      '    public virtual void RefreshHealthBar()',
      '    {',
      '        if (HealthBar == null) return;',
      '        float ratio = MaxHealth > 0 ? (float)Health / MaxHealth : 0f;',
      '        HealthBar.value = Mathf.Clamp01(ratio);',
      '    }',
      '',
      '    // ====================================================================',
      '    // 【受击】扣血 + 刷新血条;归零时把 State 标 3(失效),具体敌人类可覆写做死亡动画。',
      '    // ====================================================================',
      '    public virtual void ApplyDamage(int amount)',
      '    {',
      '        Health = Mathf.Max(0, Health - Mathf.Max(0, amount));',
      '        RefreshHealthBar();',
      '        if (Health == 0) State = 3;',
      '    }',
      '',
      '    // ====================================================================',
      '    // 【攻击】判断冷却 + 距离;命中目标时返回 true,调用方负责对目标 ApplyDamage。',
      '    // 不直接修改目标的 Health,留给调用方根据自身攻防系统决定。',
      '    // ====================================================================',
      '    public virtual bool TryAttack(Vector3 targetPos)',
      '    {',
      '        if (SourceObject == null) return false;',
      '        if (Time.time - _lastAttackTime < AttackCooldown) return false;',
      '        float dist = Vector3.Distance(SourceObject.transform.position, targetPos);',
      '        if (dist > AttackRange) return false;',
      '        _lastAttackTime = Time.time;',
      '        return true;',
      '    }',
      '}'
    ].join('\n') }
  ];
  for (var i = 0; i < entities.length; i++) {
    files.push({ name: entities[i].className + '.cs', code: buildConcreteEntityCode(entities[i]) });
  }

  var metas = 0;
  for (var j = 0; j < files.length; j++) {
    var file = path.join(entityDir, files[j].name);
    writeGeneratedCs(file, normalizeScriptNaming(files[j].code));
    if (fs.existsSync(file + '.meta')) metas++;
  }
  return { files: files.length, metas: metas, dir: entityDir };
}

function buildEntityBindingMemberBlock(entities, existingBody) {
  if (!entities.length || /void\s+BindGameFlowEntityModels\s*\(/.test(existingBody)) return '';
  var lines = [];
  lines.push('    // 程序员交付版实体模型：把对象池 GameObject 绑定到独立的领域类。');
  for (var i = 0; i < entities.length; i++) {
    lines.push('    ' + entities[i].className + ' ' + entities[i].modelField + '; // ' + entities[i].name + ' 的领域模型缓存，Start() 绑定后由业务流程读取。');
  }
  lines.push('');
  lines.push('    // 统一绑定所有实体领域模型，避免业务代码重复 GetComponent/AddComponent。');
  lines.push('    void BindGameFlowEntityModels()');
  lines.push('    {');
  for (var j = 0; j < entities.length; j++) {
    lines.push('        ' + entities[j].modelField + ' = BindGameFlowEntityComponent<' + entities[j].className + '>(' +
      entities[j].name + ', "' + csString(entities[j].name) + '", "' + csString(entities[j].name) + '");');
  }
  lines.push('    }');
  lines.push('');
  lines.push('    // 获取或创建实体领域组件，并写入蓝图 ID 与展示名。');
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

function collectUsingLines(parts) {
  var seen = Object.create(null);
  var out = [];
  parts.forEach(function(text) {
    String(text || '').split(/\r?\n/).forEach(function(line) {
      var trimmed = line.trim();
      if (!/^using\s+[^;]+;/.test(trimmed)) return;
      if (seen[trimmed]) return;
      seen[trimmed] = true;
      out.push(trimmed);
    });
  });
  if (!seen['using UnityEngine;']) out.unshift('using UnityEngine;');
  return out.sort();
}

function cleanupReferenceDeliveryCode(code) {
  return String(code || '')
    .replace(/\bGameFlowManagerMain\b/g, 'MainManager')
    .replace(/\bGFM_/g, 'GMP_')
    .replace(/\b(GMP_ResourceIds)\._([A-Za-z][A-Za-z0-9_]*)/g, function(_, owner, name) {
      return owner + '.' + name.charAt(0).toUpperCase() + name.slice(1);
    })
    .replace(/\bGMP_ResourceIds\.m([A-Z]\w*)/g, 'GMP_ResourceIds.$1')
    .replace(/^(\s*)GMP_Luna\.Init\(gameObject\);\s*$/gm, '$1// Luna 初始化已从程序员交付版剥离。')
    .replace(/\[SKELETON\]\s*/g, '')
    .replace(/\[ASSEMBLY SIGNAL FALLBACK\]\s*/g, '')
    .replace(/^\s*\/\/\s*(?:TODO|FIXME|HACK|XXX)\b.*$/gm, '')
    .replace(/\/\/ ========== 自动生成 [^=\n]+==========/g, '// 自动生成的流程代码，已整理为程序员可读交付版。')
    .replace(/\/\/ 所属类：MainManager \(partial\)。字段与 main 文件共享。/g, '// 以下方法已合并进 MainManager 单文件。')
    .replace(/partial\s+class\s+MainManager/g, 'class MainManager');
}

function toPascalFromIdentifier(name) {
  var clean = String(name || '').replace(/^_+/, '');
  if (!clean) return 'Value';
  if (/^[A-Z0-9_]+$/.test(clean)) {
    return clean.toLowerCase().split(/_+/).map(function(part) {
      return part ? part.charAt(0).toUpperCase() + part.slice(1) : '';
    }).join('');
  }
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function humanizeManagerFields(body) {
  var lines = String(body || '').split(/\r?\n/);
  var mappings = [];
  var seenFieldNames = Object.create(null);
  var depth = 0;
  var fieldRe = /^(\s*)(?!(?:public|private|protected|internal)\b)(?:(const)\s+)?([A-Za-z_][\w<>,\[\]\.?]*(?:\s*\[\])?)\s+([A-Za-z_]\w*)\s*(=.*)?;\s*(\/\/.*)?$/;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (depth === 0) {
      var m = fieldRe.exec(line);
      if (m && line.indexOf('(') < 0) {
        var oldName = m[4];
        var newName = oldName;
        if (!/^_[a-z]/.test(oldName)) newName = toPrivateFieldName(oldName);
        if (newName !== oldName) mappings.push({ oldName: oldName, newName: newName });
        if (seenFieldNames[newName]) {
          lines[i] = '';
          continue;
        }
        seenFieldNames[newName] = true;
        var constPart = m[2] ? 'const ' : '';
        lines[i] = m[1] + 'public ' + constPart + m[3] + ' ' + newName + (m[5] || '') + ';' + (m[6] ? ' ' + m[6].trim() : '');
      }
    }
    depth += lineBraceDelta(line);
  }

  var next = lines.join('\n');
  mappings.sort(function(a, b) { return b.oldName.length - a.oldName.length; });
  mappings.forEach(function(map) {
    var re = new RegExp('\\b' + map.oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
    next = next.replace(re, map.newName);
  });
  return next;
}

function overrideAwakeForMonoSingleton(body) {
  var replaced = false;
  return String(body || '').replace(/^(\s*)void\s+Awake\s*\(\s*\)\s*\{\s*$/m, function(match, indent) {
    if (replaced) return match;
    replaced = true;
    return indent + 'protected override void Awake()\n' +
      indent + '{\n' +
      indent + '    base.Awake();';
  });
}

function buildMonoSingletonCode() {
  return [
    'using UnityEngine;',
    '',
    '/// <summary>',
    '/// MonoBehaviour 单例基类：场景中挂载一个实例后，可通过 instance 直接访问。',
    '/// </summary>',
    'public abstract class MonoSingleton<T> : MonoBehaviour where T : MonoBehaviour',
    '{',
    '    /// <summary>',
    '    /// 全局实例句柄；参考工程统一使用小写 instance。',
    '    /// </summary>',
    '    public static T instance { get; private set; }',
    '',
    '    /// <summary>',
    '    /// 注册当前实例，并把 GameObject 命名为脚本类型，方便 Hierarchy 中定位。',
    '    /// </summary>',
    '    protected virtual void Awake()',
    '    {',
    '        if (instance == null)',
    '        {',
    '            instance = this as T;',
    '            if (gameObject != null) gameObject.name = GetType().Name;',
    '        }',
    '    }',
    '}'
  ].join('\n');
}

function buildReferenceMainManagerCode(mainInfo, companions, entities, allCode) {
  var usingLines = collectUsingLines([mainInfo.code].concat(companions.map(function(info) { return info.code; })));
  var bodyParts = [];
  [mainInfo].concat(companions).forEach(function(info) {
    var cleanup = removeGeneratedAssemblyDeadCode(info.body.split(/\r?\n/));
    bodyParts.push(cleanup.lines.join('\n'));
  });
  var body = bodyParts.join('\n\n');
  body = insertEntityBindingCall(body, entities);
  var entityBlock = buildEntityBindingMemberBlock(entities, allCode);
  if (entityBlock) body = body.replace(/\s+$/, '') + '\n\n    // ===== 实体模型代码区 =====\n' + entityBlock + '\n';
  if (!/\bGameState\s+_gameState\b/.test(body)) {
    body = '    public GameState _gameState = GameState.Start; // 当前游戏状态，Start/Run/End/Success 对齐参考工程。\n\n' + body;
  }
  body = humanizeManagerFields(body);
  body = overrideAwakeForMonoSingleton(body);
  body = cleanupReferenceDeliveryCode(body);
  return usingLines.join('\n') + '\n\n' +
    '/// <summary>\n' +
    '/// 游戏主入口。负责阶段流程、资源、UI、输入和场景对象的统一调度。\n' +
    '/// </summary>\n' +
    'public enum GameState\n' +
    '{\n' +
    '    None,\n' +
    '    Start,\n' +
    '    Run,\n' +
    '    End,\n' +
    '    Success\n' +
    '}\n\n' +
    '/// <summary>\n' +
    '/// 游戏主控制器：挂在场景根节点，参考项目中的 MainManager/GameManager 风格。\n' +
    '/// </summary>\n' +
    'public class MainManager : MonoSingleton<MainManager>\n' +
    '{\n' +
    body.replace(/\s+$/g, '') + '\n' +
    '}\n';
}

function writeReferenceDeliveryManager(root, managerDir, mainInfo, companions, entities, allCode, summary) {
  if (!isReferenceScriptsLayout(managerDir)) return false;
  var mainManagerFile = path.join(managerDir, 'MainManager.cs');
  writeGeneratedCs(mainManagerFile, buildReferenceMainManagerCode(mainInfo, companions, entities, allCode));
  writeGeneratedCs(path.join(managerDir, 'MonoSingleton.cs'), buildMonoSingletonCode());

  [mainInfo].concat(companions).forEach(function(info) {
    if (removeIfExists(info.file)) summary.changed = true;
    removeIfExists(info.file + '.meta');
  });
  summary.changed = true;
  summary.referenceMainManager = true;
  summary.partialFilesKept = 0;
  summary.partialFilesByName = ['MainManager.cs'];
  summary.mainLines = countFileLines(mainManagerFile);
  summary.maxPartialLines = summary.mainLines;
  return true;
}

function insertEntityBindingCall(body, entities) {
  if (!entities.length || /BindGameFlowEntityModels\s*\(\s*\)\s*;/.test(body)) return body;
  if (/RegisterEntityBindings\s*\(\s*\)\s*;/.test(body)) {
    return body.replace(/(RegisterEntityBindings\s*\(\s*\)\s*;)/, '$1\n        BindGameFlowEntityModels();');
  }
  return body.replace(/(void\s+Start\s*\([^)]*\)\s*\{\s*)/, '$1\n        BindGameFlowEntityModels();\n');
}

function lineBraceDelta(line) {
  var text = String(line || '')
    .replace(/\/\/.*$/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length;
}

function methodCommentFor(name) {
  var map = {
    Awake: 'Unity 生命周期入口：注册实例并完成初始化。',
    Start: 'Unity 生命周期入口：场景加载后启动主流程。',
    Update: 'Unity 每帧更新入口：推进输入、流程和表现。',
    LateUpdate: 'Unity LateUpdate 入口：在普通更新后同步表现状态。',
    OnInit: '单例初始化钩子：实例注册完成后执行一次。',
    OnApplicationQuit: '应用退出钩子：记录退出状态，避免退出阶段重复初始化。',
    Init: '初始化当前模块，重复调用保持幂等。',
    Tick: '按帧推进当前模块的运行状态。',
    SetGuideText: '更新玩家引导文案。',
    CheckEventRules: '检查阶段推进条件并触发下一阶段。',
    RegisterEntityBindings: '注册实体字段与场景对象的绑定关系。'
  };
  return map[name] || ('方法说明：执行 ' + name + ' 的业务逻辑。');
}

function ensureMethodCommentsInCode(code) {
  var lines = String(code || '').split(/\r?\n/);
  var out = [];
  var inserted = 0;
  var methodRe = /^(\s*)(?:(?:public|private|protected|internal|static|virtual|override|sealed|new|extern|async)\s+)*(?:[A-Za-z_][A-Za-z0-9_<>,\[\]\.?]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:\{|$)/;
  var skipNames = {
    if: true, for: true, while: true, switch: true, catch: true, using: true,
    lock: true, return: true
  };

  function previousMeaningfulIndex() {
    for (var j = out.length - 1; j >= 0; j--) {
      if (String(out[j] || '').trim() !== '') return j;
    }
    return -1;
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var match = methodRe.exec(line);
    if (match && !skipNames[match[2]]) {
      var idx = previousMeaningfulIndex();
      var hasComment = idx >= 0 && /^\s*(\/\/|\/\/\/|\/\*)/.test(out[idx]);
      if (!hasComment) {
        while (idx >= 0 && /^\s*\[[^\]]+\]\s*$/.test(out[idx])) idx--;
        var comment = match[1] + '// ' + methodCommentFor(match[2]);
        if (idx === out.length - 1) {
          out.push(comment);
        } else {
          out.splice(idx + 1, 0, comment);
        }
        inserted++;
      }
    }
    out.push(line);
  }
  return { code: out.join('\n'), inserted: inserted };
}

function readUnityMetaGuid(csFile) {
  var meta = csFile + '.meta';
  if (!fs.existsSync(meta)) return '';
  var match = /^guid:\s*([0-9a-fA-F]+)/m.exec(fs.readFileSync(meta, 'utf8'));
  return match ? match[1] : '';
}

function deterministicSceneFileId(seed) {
  var hash = crypto.createHash('sha1').update(String(seed || '')).digest('hex');
  var n = BigInt('0x' + hash.slice(0, 14));
  return String(1000000000000n + (n % 8000000000000000n));
}

function sceneObjectYaml(name, guid, index) {
  var baseSeed = name + ':' + guid + ':' + index;
  var goId = deterministicSceneFileId(baseSeed + ':go');
  var transformId = deterministicSceneFileId(baseSeed + ':transform');
  var componentId = deterministicSceneFileId(baseSeed + ':script');
  var x = (index % 6) * 1.5;
  var z = Math.floor(index / 6) * 1.5;
  return [
    '--- !u!1 &' + goId,
    'GameObject:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  serializedVersion: 6',
    '  m_Component:',
    '  - component: {fileID: ' + transformId + '}',
    '  - component: {fileID: ' + componentId + '}',
    '  m_Layer: 0',
    '  m_Name: ' + name,
    '  m_TagString: Untagged',
    '  m_Icon: {fileID: 0}',
    '  m_NavMeshLayer: 0',
    '  m_StaticEditorFlags: 0',
    '  m_IsActive: 1',
    '--- !u!4 &' + transformId,
    'Transform:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  serializedVersion: 2',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    '  m_LocalPosition: {x: ' + x + ', y: 0, z: ' + z + '}',
    '  m_LocalScale: {x: 1, y: 1, z: 1}',
    '  m_ConstrainProportionsScale: 0',
    '  m_Children: []',
    '  m_Father: {fileID: 0}',
    '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
    '--- !u!114 &' + componentId,
    'MonoBehaviour:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_Enabled: 1',
    '  m_EditorHideFlags: 0',
    '  m_Script: {fileID: 11500000, guid: ' + guid + ', type: 3}',
    '  m_Name: ',
    '  m_EditorClassIdentifier: ',
    ''
  ].join('\n');
}

function findScriptByClass(root, className) {
  var files = walkFiles(path.join(root, 'Assets', 'Scripts')).filter(function(file) {
    return path.basename(file) === className + '.cs';
  });
  return files[0] || '';
}

function injectSceneMountedScriptObjects(root) {
  var scene = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(scene)) return { injected: 0, scene: scene, names: [] };
  var names = [
    'MainManager',
    'GMP_Audio',
    'GMP_AutoPlay',
    'GMP_CameraController',
    'GMP_EconomyManager',
    'GMP_ItemManager',
    'GMP_NpcManager',
    'GMP_Player',
    'GMP_Pool',
    'GMP_TipsManager',
    'GMP_UIManager'
  ];
  var text = fs.readFileSync(scene, 'utf8').replace(/\s+$/g, '') + '\n';
  var injected = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (new RegExp('m_Name:\\s*' + escapeRegExp(name) + '\\b').test(text)) continue;
    var file = findScriptByClass(root, name);
    if (!file) continue;
    ensureUnityMeta(file);
    var guid = readUnityMetaGuid(file);
    if (!guid) continue;
    text += sceneObjectYaml(name, guid, i);
    injected.push(name);
  }
  if (injected.length) fs.writeFileSync(scene, text);
  return { injected: injected.length, scene: scene, names: injected };
}

function moveFileWithMeta(from, to) {
  if (!fs.existsSync(from) || from === to) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) removeIfExists(to);
  fs.renameSync(from, to);
  var fromMeta = from + '.meta';
  var toMeta = to + '.meta';
  if (fs.existsSync(fromMeta)) {
    if (fs.existsSync(toMeta)) removeIfExists(toMeta);
    fs.renameSync(fromMeta, toMeta);
  }
  ensureUnityMeta(to);
  return true;
}

function renameGfmScriptsToGmp(scriptsRoot) {
  if (!fs.existsSync(scriptsRoot)) return { renamed: 0 };
  var renamed = 0;
  var files = walkFiles(scriptsRoot).filter(function(file) {
    return path.extname(file).toLowerCase() === '.cs' && /^GFM_/.test(path.basename(file));
  });
  files.sort();
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var target = path.join(path.dirname(file), path.basename(file).replace(/^GFM_/, 'GMP_'));
    if (moveFileWithMeta(file, target)) renamed++;
  }
  return { renamed: renamed };
}

function removeUnusedDeliveryScripts(scriptsRoot) {
  if (!fs.existsSync(scriptsRoot)) return { removed: 0, lines: 0, names: [] };
  var allow = {};
  var roots = {
    MainManager: true,
    MonoSingleton: true,
    GameSceneCtrl: true,
    ScriptActivator: true,
    GMP_Audio: true,
    GMP_AutoPlay: true,
    GMP_CameraController: true,
    GMP_EconomyManager: true,
    GMP_ItemManager: true,
    GMP_NpcManager: true,
    GMP_Player: true,
    GMP_Pool: true,
    GMP_TipsManager: true,
    GMP_UIManager: true,
    GMP_SceneObjectRegistry: true,
    BaseGameFlowEntity: true,
    BaseBuildElement: true,
    BuildEntity: true,
    CombatEntity: true,
    ResourceEntity: true,
    PlayerBase: true,
    NPCBase: true
  };
  var allFiles = walkFiles(scriptsRoot).filter(function(file) {
    return path.extname(file).toLowerCase() === '.cs';
  });
  var byClass = Object.create(null);
  allFiles.forEach(function(file) {
    var cls = path.basename(file, '.cs');
    byClass[cls] = file;
    if (/Entity$/.test(cls)) roots[cls] = true;
  });
  var keep = Object.create(null);
  var queue = Object.keys(roots).filter(function(cls) { return byClass[cls]; });
  while (queue.length) {
    var cls = queue.shift();
    if (keep[cls]) continue;
    keep[cls] = true;
    var text = fs.readFileSync(byClass[cls], 'utf8');
    Object.keys(byClass).forEach(function(candidate) {
      if (keep[candidate] || allow[candidate]) return;
      var re = new RegExp('\\b' + escapeRegExp(candidate) + '\\b');
      if (re.test(text)) queue.push(candidate);
    });
  }

  var removed = 0;
  var lines = 0;
  var names = [];
  Object.keys(byClass).sort().forEach(function(cls) {
    if (keep[cls] || allow[cls]) return;
    var file = byClass[cls];
    lines += countFileLines(file);
    names.push(path.basename(file));
    if (removeIfExists(file)) removed++;
    removeIfExists(file + '.meta');
  });
  return { removed: removed, lines: lines, names: names };
}

function extractStringArrayValues(code, varName) {
  var re = new RegExp('string\\s*\\[\\]\\s+' + escapeRegExp(varName) + '\\s*=\\s*new\\s+string\\s*\\[\\]\\s*\\{([\\s\\S]*?)\\};');
  var match = re.exec(String(code || ''));
  if (!match) return null;
  var values = [];
  match[1].replace(/"([^"]*)"/g, function(_, value) {
    values.push(value);
    return _;
  });
  return { match: match, values: values };
}

function stringArrayLiteral(varName, values) {
  var lines = ['    string[] ' + varName + ' = new string[] {'];
  for (var i = 0; i < values.length; i++) {
    lines.push('        "' + csString(values[i]) + '"' + (i === values.length - 1 ? '' : ','));
  }
  lines.push('    };');
  return lines.join('\n');
}

function scrubPrimitivePoolStrings(code) {
  return String(code || '').replace(/__Pool_(?:Cube|Cylinder|Capsule|Sphere|Plane)[A-Za-z0-9_]*/g, '_player');
}

function scrubPrimitivePoolNamesInScene(text) {
  var seen = Object.create(null);
  return String(text || '').replace(/m_Name:\s+__Pool_(?:Cube|Cylinder|Capsule|Sphere|Plane)[A-Za-z0-9_]*/g, function(match) {
    var oldName = match.replace(/^m_Name:\s+/, '');
    var short = crypto.createHash('sha1').update(oldName).digest('hex').slice(0, 8);
    var next = 'UnusedSceneModel_' + short;
    if (seen[next]) next += '_' + (++seen[next]);
    else seen[next] = 1;
    return 'm_Name: ' + next;
  });
}

function rewriteEntityBindingPoolsToNamedSceneObjects(root) {
  var mainFile = findScriptByClass(root, 'MainManager');
  if (!mainFile) return { bindings: 0, sceneRenamed: 0, changedFiles: 0 };
  var code = fs.readFileSync(mainFile, 'utf8');
  var ids = extractStringArrayValues(code, '_entityBindingIds');
  var pools = extractStringArrayValues(code, '_entityBindingPools');
  if (!ids || !pools || !ids.values.length || ids.values.length !== pools.values.length) {
    var scrubbed = scrubPrimitivePoolStrings(code);
    if (scrubbed !== code) {
      fs.writeFileSync(mainFile, scrubbed.replace(/\s+$/g, '') + '\n');
      return { bindings: 0, sceneRenamed: 0, changedFiles: 1 };
    }
    return { bindings: 0, sceneRenamed: 0, changedFiles: 0 };
  }

  var changedFiles = 0;
  var map = [];
  for (var i = 0; i < ids.values.length; i++) {
    if (pools.values[i] && pools.values[i] !== ids.values[i]) {
      map.push({ from: pools.values[i], to: ids.values[i] });
    }
  }
  var nextCode = code.slice(0, pools.match.index) +
    stringArrayLiteral('_entityBindingPools', ids.values) +
    code.slice(pools.match.index + pools.match[0].length);
  nextCode = scrubPrimitivePoolStrings(nextCode);
  if (nextCode !== code) {
    fs.writeFileSync(mainFile, nextCode.replace(/\s+$/g, '') + '\n');
    changedFiles++;
  }

  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  var sceneRenamed = 0;
  if (fs.existsSync(sceneFile)) {
    var scene = fs.readFileSync(sceneFile, 'utf8');
    var nextScene = scene;
    map.forEach(function(entry) {
      var re = new RegExp('(m_Name:\\s*)' + escapeRegExp(entry.from) + '\\b', 'g');
      nextScene = nextScene.replace(re, function(_, prefix) {
        sceneRenamed++;
        return prefix + entry.to;
      });
    });
    nextScene = scrubPrimitivePoolNamesInScene(nextScene);
    if (nextScene !== scene) {
      fs.writeFileSync(sceneFile, nextScene);
      changedFiles++;
    }
  }
  return { bindings: map.length, sceneRenamed: sceneRenamed, changedFiles: changedFiles };
}

function scrubRemainingPrimitivePoolReferences(scriptsRoot) {
  if (!fs.existsSync(scriptsRoot)) return { changedFiles: 0 };
  var changedFiles = 0;
  var files = walkFiles(scriptsRoot).filter(function(file) {
    return path.extname(file).toLowerCase() === '.cs';
  });
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var before = fs.readFileSync(file, 'utf8');
    var next = scrubPrimitivePoolStrings(before);
    if (next !== before) {
      fs.writeFileSync(file, next.replace(/\s+$/g, '') + '\n');
      changedFiles++;
    }
  }
  return { changedFiles: changedFiles };
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
    if (/RunGeneratedAssemblySlotRunners|ENABLE_GENERATED_ASSEMBLY_RUNNERS|AssemblyRun(?:Flow|Input|Resource|Scene|UI)Slots|AssemblySlot_/.test(trimmed)) {
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

function countFileLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).length - 1;
}

function existingEntityClassFileCount(managerDir) {
  var entityDir = resolveEntityDir(managerDir);
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
    'GameFlowResourceBase.cs',
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

// 程序员交付有两种布局：
// 1. 历史 Assets/Program/Script/Manager：保留 GameFlowManagerMain 的 5 个 partial。
// 2. 参考工程式 Assets/Scripts(/Manager)：合并为 MainManager.cs 单文件入口。
// 两条路径都清理 [ASSEMBLY] 死代码，并把实体绑定方法贴近 Start()。
function transformManagerPartialsForProgrammerDelivery(root) {
  var summary = {
    changed: false,
    managerDir: '',
    partialFilesKept: 0,
    partialFilesByName: [],
    staleBaseLayersRemoved: 0,
    staleMetaRemoved: 0,
    entityDir: '',
    entityClassFiles: 0,
    entityModelCount: 0,
    mainLines: 0,
    maxPartialLines: 0,
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

  var companionNames = fs.readdirSync(managerDir)
    .filter(function(name) { return /^GameFlowManagerMain\..+\.cs$/.test(name); })
    .sort();
  var companions = [];
  for (var i = 0; i < companionNames.length; i++) {
    var info = extractManagerClassInfo(path.join(managerDir, companionNames[i]));
    if (info) companions.push(info);
  }

  // 删除上一次按继承链拆出的 GameFlow*Base.cs 残留(若再次导出同一项目)。
  var legacyBaseLayerNames = [
    'GameFlowPhaseFlowBase.cs',
    'GameFlowPhaseAutoBase.cs',
    'GameFlowPhaseTapBase.cs',
    'GameFlowPhaseInitBase.cs',
    'GameFlowPhaseSnapshotBase.cs',
    'GameFlowPhaseSharedBase.cs',
    'GameFlowPhaseContentBase.cs',
    'GameFlowUiBase.cs',
    'GameFlowResourceBase.cs',
    'GameFlowInputBase.cs',
    'GameFlowRuntimeBase.cs',
    'GameFlowSceneBase.cs',
    'GameFlowPreviewBase.cs',
    'GameFlowStateBase.cs'
  ];
  legacyBaseLayerNames.forEach(function(name) {
    var stale = path.join(managerDir, name);
    if (removeIfExists(stale)) {
      summary.staleBaseLayersRemoved++;
      summary.changed = true;
    }
    if (removeIfExists(stale + '.meta')) summary.staleMetaRemoved++;
  });

  var allCode = [mainInfo.code].concat(companions.map(function(info) { return info.code; })).join('\n');
  var entities = collectEntityInfos(allCode);
  var entitySummary = writeEntityClassFiles(managerDir, entities);
  summary.entityDir = entitySummary.dir || resolveEntityDir(managerDir);
  summary.entityClassFiles = entitySummary.files || existingEntityClassFileCount(managerDir);
  summary.entityModelCount = entities.length || existingEntityModelCount(managerDir);

  if (writeReferenceDeliveryManager(root, managerDir, mainInfo, companions, entities, allCode, summary)) {
    return summary;
  }

  // 找出哪个 partial 拥有 Start():通常是 Main,但宽容兜底以防项目把 Start 挪进 Flow.cs。
  var startOwnerFile = null;
  if (/void\s+Start\s*\(/.test(mainInfo.code)) {
    startOwnerFile = mainInfo.file;
  } else {
    for (var k = 0; k < companions.length; k++) {
      if (/void\s+Start\s*\(/.test(companions[k].code)) {
        startOwnerFile = companions[k].file;
        break;
      }
    }
  }

  var partials = [mainInfo].concat(companions);
  for (var p = 0; p < partials.length; p++) {
    var partial = partials[p];
    var bodyLines = partial.body.split(/\r?\n/);
    var cleanup = removeGeneratedAssemblyDeadCode(bodyLines);
    summary.removedGeneratedAssemblyMethods += cleanup.removedMethods;
    summary.removedGeneratedAssemblyFields += cleanup.removedFields;
    var newBody = cleanup.lines.join('\n');

    if (startOwnerFile && partial.file === startOwnerFile) {
      newBody = insertEntityBindingCall(newBody, entities);
    }
    if (partial.file === mainInfo.file) {
      var entityBlock = buildEntityBindingMemberBlock(entities, allCode);
      if (entityBlock) {
        newBody = newBody.replace(/\s+$/, '') + '\n\n    // ===== 实体模型代码区 =====\n' + entityBlock + '\n';
      }
    }

    var newCode = partial.beforeOpen + '{' + newBody + '}' + partial.afterClose;
    if (newCode !== partial.code) {
      fs.writeFileSync(partial.file, newCode.replace(/\s+$/g, '') + '\n');
      summary.changed = true;
    }
    ensureUnityMeta(partial.file);
  }

  summary.partialFilesKept = partials.length;
  summary.partialFilesByName = partials.map(function(info) { return path.basename(info.file); });
  summary.mainLines = countFileLines(mainFile);
  summary.maxPartialLines = 0;
  partials.forEach(function(info) {
    var n = countFileLines(info.file);
    if (n > summary.maxPartialLines) summary.maxPartialLines = n;
  });

  return summary;
}

// Wave C：保留 README 里 partial 与 Flow/Input/Resource/UI/Scene 提及,
// 仅把"边界"段落换成新的 5-partial 描述,并丢掉 AssemblySlot 等机器装配残留。
function rewriteReadmeForProgrammerDelivery(root) {
  var file = path.join(root, 'README.md');
  if (!fs.existsSync(file)) return false;
  var text = fs.readFileSync(file, 'utf8');
  var before = text;
  var managerDir = findManagerDir(root);
  var managerPath = managerDir ? relativeUnix(root, managerDir) : 'Assets/Scripts/Manager';
  var scriptsRoot = managerDir && isReferenceScriptsManagerDir(managerDir) ? path.dirname(managerDir) : null;
  var commonPath = scriptsRoot ? relativeUnix(root, path.join(scriptsRoot, 'Common')) : 'Assets/Program/Script/Commons';
  var entityPath = managerDir ? relativeUnix(root, resolveEntityDir(managerDir)) : 'Assets/Scripts/Entities';
  var isReferenceMainManager = managerDir
    && isReferenceScriptsLayout(managerDir)
    && fs.existsSync(path.join(managerDir, 'MainManager.cs'));
  var boundary = isReferenceMainManager ? [
    '## 程序员交付边界',
    '',
    '- `MainManager.cs` 是 Unity 生命周期入口、主 `Update()` 和阶段调度的单文件入口，继承 `MonoSingleton<MainManager>`。',
    '- `MonoSingleton.cs` 提供参考工程同款 `instance` 访问方式，场景中只挂一个主入口实例。',
    '- `Game.unity` 已预挂 `MainManager` 与关键 GMP 管理器对象，脚本物体不再由代码运行时创建。',
    '- `' + entityPath + '/` 中的实体类承载领域属性，例如 `BaseBuildElement`、`BuildEntity`、`BarrackEntity`。',
    '- 新增建筑、兵营、炮塔、资源、战斗单位时，优先新增或扩展 `Entities/` 下的具体类。',
    '- 参考工程式脚本布局：`' + managerPath + '/` 放 `MainManager.cs`、`MonoSingleton.cs`，`Manager/`、`Player/`、`UI/`、`Audio/`、`Common/` 按职责归类工具脚本，`' + entityPath + '/` 放领域对象。',
    '- 实体引用只来自 `RegisterEntityBindings()/GameSceneCtrl`，不要在业务代码里二次 `GameObject.Find("__Pool_*")` 覆盖字段。',
    '- 资源 API 使用 `GMP_ResourceIds` 常量或 `GMP_ResourceIds.Normalize("...")`，不要裸写 `"gold"`/`"Gold"`。',
    '- 引导文案统一调用 `SetGuideText()`；`guideText.text` 只应在这个 helper 内落地。',
    ''
  ].join('\n') : [
    '## 程序员交付边界',
    '',
    '- `GameFlowManagerMain.cs` 是 Unity 挂载入口和主 `Update()` 调度；按职责拆分到 `GameFlowManagerMain.Flow/Input/Resource/UI/Scene.cs` 5 个 partial。',
    '- 不要把功能再塞回主文件：流程进 `Flow.cs`、输入进 `Input.cs`、资源进 `Resource.cs`、界面进 `UI.cs`、场景进 `Scene.cs`。',
    '- `' + entityPath + '/` 中的实体类承载领域属性，例如 `BaseBuildElement`、`BuildEntity`、`BarrackEntity`。',
    '- 新增建筑、兵营、炮塔、资源、战斗单位时，优先新增或扩展 `Entities/` 下的具体类。',
    '- 参考工程式脚本布局：`' + managerPath + '/` 放 Manager 主流程，`' + commonPath + '/` 放通用库，`' + entityPath + '/` 放领域对象。',
    '- 实体引用只来自 `RegisterEntityBindings()/GameSceneCtrl`，不要在业务代码里二次 `GameObject.Find("__Pool_*")` 覆盖字段。',
    '- 资源 API 使用 `GMP_ResourceIds` 常量或 `GMP_ResourceIds.Normalize("...")`，不要裸写 `"gold"`/`"Gold"`。',
    '- 引导文案统一调用 `SetGuideText()`；`guideText.text` 只应在这个 helper 内落地。',
    ''
  ].join('\n');
  text = text.replace(
    /- Assets\/Program\/Script\/Manager\/\s+—[^\n]*/g,
    '- ' + managerPath + '/  — ' + (isReferenceMainManager ? 'MainManager.cs 单文件主入口' : 'GameFlowManagerMain.cs 主入口与 Flow/Input/Resource/UI/Scene partial 拆分')
  );
  text = text.replace(
    /- Assets\/Scripts\/Manager\/\s+—[^\n]*/g,
    '- ' + managerPath + '/  — ' + (isReferenceMainManager ? 'MainManager.cs 单文件主入口' : 'GameFlowManagerMain.cs 主入口与 Flow/Input/Resource/UI/Scene partial 拆分')
  );
  text = text.replace(
    /- Assets\/Scripts\/Entities\/\s+—[^\n]*/g,
    '- ' + entityPath + '/  — 面向对象实体类'
  );
  if (/## 程序员交付边界\n/.test(text)) {
    text = text.replace(/## 程序员交付边界\n[\s\S]*?(?=\n## |$)/, boundary);
  }
  // 只过滤机器装配槽位等明显的残留,保留 partial / Flow / Input / Resource / UI / Scene 提及。
  text = text.split('\n').filter(function(line) {
    if (/AssemblySlot|AssemblyRun/.test(line)) return false;
    return true;
  }).join('\n');
  if (text !== before) fs.writeFileSync(file, text);
  return text !== before;
}

function writeHandoff(root, project, summary) {
  var id = project && project.id ? project.id : '';
  var name = project && project.name ? project.name : id;
  var keptCount = stableHandoffStat(root, '保留的 GameFlowManagerMain partial 文件数', summary.partialFilesKept || 0);
  var staleBaseRemoved = stableHandoffStat(root, '清理的 GameFlow*Base 残留文件数', summary.staleBaseLayersRemoved || 0);
  var removedToolCount = stableHandoffStat(root, '移除 tools 目录数', summary.removedToolDirs || 0);
  var mainLines = summary.mainLines || 0;
  var maxPartialLines = summary.maxPartialLines || 0;
  var partialNames = Array.isArray(summary.partialFilesByName) ? summary.partialFilesByName : [];
  var entityDirText = summary.entityDir ? relativeUnix(root, summary.entityDir) : 'Assets/Scripts/Entities';
  var managerDirText = summary.managerDir ? relativeUnix(root, summary.managerDir) : 'Assets/Scripts/Manager';
  var referenceMain = !!summary.referenceMainManager;
  var partialListText = partialNames.length
    ? partialNames.map(function(n) { return '`' + n + '`'; }).join(' / ')
    : '`GameFlowManagerMain.cs`';
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
    referenceMain
      ? '- 合并 Blueprint 构建期 `GameFlowManagerMain*.cs` partial，交付为参考工程式 `MainManager.cs` 单文件入口。'
      : '- 保留 `GameFlowManagerMain` 5 个 partial 拆分（`GameFlowManagerMain.cs` + `Flow/Input/Resource/UI/Scene`）；不再合并到单一类，也不再生成 `GameFlow*Base.cs` 横切继承链。',
    '- 移除默认关闭的生成遗留路径，避免程序员维护死代码。',
    '- 生成 `' + entityDirText + '/` 领域类：`BaseBuildElement` 承载生命、攻击、等级等建筑通用属性，具体实体类继承对应基类。',
    '',
    '## 后续维护建议',
    '- 参考工程式入口目录：`' + managerDirText + '/` 放 Manager 主流程；`' + entityDirText + '/` 放领域对象；UI/Player 相关脚本后续优先进入同级 `UI/`、`Player/` 目录。',
    referenceMain
      ? '- 玩法主流程从 `MainManager.cs` 的 `Start()`、`Update()`、`CheckEventRules()` 开始阅读；字段统一采用 `_camelCase` 命名，方便 Inspector 调整。'
      : '- 玩法主流程从 `GameFlowManagerMain.cs` 的 `Start()`、`Update()`、`CheckEventRules()` 开始阅读，按职责进入对应 partial：' + partialListText + '。',
    referenceMain
      ? '- 新增主流程逻辑时优先在 `MainManager.cs` 内按阶段/系统分段组织，不再新增 `GameFlowManagerMain.*.cs` companion 文件。'
      : '- 不要把功能再塞回 `GameFlowManagerMain.cs`：流程进 `Flow.cs`、输入进 `Input.cs`、资源进 `Resource.cs`、界面进 `UI.cs`、场景进 `Scene.cs`。',
    '- 建筑、资源、战斗单位等领域属性优先放在 `Entities/` 下的具体类，不要再用 partial 文件承载领域对象。',
    '- `GMP_*.cs` 是通用工具库；业务逻辑优先写在主流程或实体领域类中，不要直接改工具库公共行为。',
    '',
    '## 清理统计',
    '- C# 文件处理数：' + summary.csFiles,
    '- 修改的 C# 文件数：' + summary.changedFiles,
    '- 保留的 GameFlowManagerMain partial 文件数：' + keptCount,
    '- 清理的 GameFlow*Base 残留文件数：' + staleBaseRemoved,
    '- ' + (referenceMain ? 'MainManager.cs' : 'GameFlowManagerMain.cs') + ' 行数：' + mainLines,
    '- ' + (referenceMain ? 'MainManager.cs' : '最长 partial 文件') + ' 行数：' + maxPartialLines,
    '- 移除默认关闭生成遗留方法数：' + (summary.removedGeneratedAssemblyMethods || 0),
    '- 生成的实体领域类文件数：' + (summary.entityClassFiles || 0),
    '- 绑定的实体模型数：' + (summary.entityModelCount || 0),
    '- 补齐的方法注释数：' + (summary.methodCommentsInserted || 0),
    '- 注入 Game.unity 的脚本物体数：' + (summary.sceneObjectsInjected || 0),
    '- 重命名 GFM 脚本数：' + (summary.gfmScriptsRenamed || 0),
    '- 移除未引用脚本数：' + (summary.unusedScriptsRemoved || 0),
    '- 移除未引用脚本行数：' + (summary.unusedScriptLinesRemoved || 0),
    '- 实体池引用改为场景实体名数：' + (summary.entityBindingPoolsRewritten || 0),
    '- 场景遗留 primitive 池命名清理数：' + (summary.scenePrimitivePoolNamesRenamed || 0),
    '- 脚本 primitive 池引用清理文件数：' + (summary.primitivePoolReferenceFilesScrubbed || 0),
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

function normalizeProgrammerDeliveryScripts(root) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var summary = {
    changedFiles: 0,
    methodCommentsInserted: 0,
    sceneObjectsInjected: 0,
    sceneObjectNames: [],
    sceneRegistryWritten: false
  };
  if (!fs.existsSync(scriptsRoot)) return summary;

  var registryFile = path.join(scriptsRoot, 'Common', 'GMP_SceneObjectRegistry.cs');
  if (!fs.existsSync(registryFile)) {
    writeGeneratedCs(registryFile, buildSceneObjectRegistryCode());
    summary.sceneRegistryWritten = true;
    summary.changedFiles++;
  }

  var files = walkFiles(scriptsRoot).filter(function(file) {
    return path.extname(file).toLowerCase() === '.cs';
  });
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var before = fs.readFileSync(file, 'utf8');
    var next = removeRuntimeSceneObjectCreation(before);
    next = normalizeScriptNaming(next);
    var commentResult = ensureMethodCommentsInCode(next);
    next = commentResult.code;
    if (next !== before) {
      fs.writeFileSync(file, next.replace(/\s+$/g, '') + '\n');
      summary.changedFiles++;
    }
    summary.methodCommentsInserted += commentResult.inserted;
  }
  var renameSummary = renameGfmScriptsToGmp(scriptsRoot);
  summary.gfmScriptsRenamed = renameSummary.renamed;
  if (renameSummary.renamed) summary.changedFiles += renameSummary.renamed;

  var pruneSummary = removeUnusedDeliveryScripts(scriptsRoot);
  summary.unusedScriptsRemoved = pruneSummary.removed;
  summary.unusedScriptLinesRemoved = pruneSummary.lines;
  summary.unusedScriptNamesRemoved = pruneSummary.names;
  if (pruneSummary.removed) summary.changedFiles += pruneSummary.removed;

  var bindingSummary = rewriteEntityBindingPoolsToNamedSceneObjects(root);
  summary.entityBindingPoolsRewritten = bindingSummary.bindings;
  summary.scenePrimitivePoolNamesRenamed = bindingSummary.sceneRenamed;
  if (bindingSummary.changedFiles) summary.changedFiles += bindingSummary.changedFiles;

  var primitiveRefSummary = scrubRemainingPrimitivePoolReferences(scriptsRoot);
  summary.primitivePoolReferenceFilesScrubbed = primitiveRefSummary.changedFiles;
  if (primitiveRefSummary.changedFiles) summary.changedFiles += primitiveRefSummary.changedFiles;

  var sceneSummary = injectSceneMountedScriptObjects(root);
  summary.sceneObjectsInjected = sceneSummary.injected;
  summary.sceneObjectNames = sceneSummary.names;
  return summary;
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

  // Wave D 反馈 7 (2026-05-02): 交付包不带 GFM_Event。事件系统已禁用 (反馈 5),
  // 文件留下来只会让程序员误以为可以重新启用,所以从 delivery 里删掉(原 repo 不动)。
  [
    path.join(root, 'Assets', 'Program', 'Script', 'Commons', 'GFM_Event.cs'),
    path.join(root, 'Assets', 'Scripts', 'Common', 'GFM_Event.cs'),
    path.join(root, 'Assets', 'Scripts', 'Commons', 'GFM_Event.cs'),
    path.join(root, 'Assets', 'Script', 'Common', 'GFM_Event.cs'),
    path.join(root, 'Assets', 'Script', 'Commons', 'GFM_Event.cs')
  ].forEach(function(gfmEventPath) {
    if (removeIfExists(gfmEventPath)) summary.removedGfmEvent = true;
    removeIfExists(gfmEventPath + '.meta');
  });

  var files = walkFiles(root);
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (path.extname(file).toLowerCase() !== '.cs') continue;
    summary.csFiles++;
    var before = fs.readFileSync(file, 'utf8');
    var result = cleanCSharpForProgrammerDelivery(before);
    var rel = relativeUnix(root, file);
    var shouldNormalize = /^Assets\/(?:Scripts|Script|Program\/Script)\//.test(rel) || /^Scripts\//.test(rel);
    var normalized = shouldNormalize ? normalizeScriptNaming(result.code) : result.code;
    if (!result.changed && normalized === before) continue;
    fs.writeFileSync(file, normalized);
    summary.changedFiles++;
    summary.removedContractComments += result.removedContractComments;
  }

  var transformSummary = transformManagerPartialsForProgrammerDelivery(root);
  Object.keys(transformSummary).forEach(function(key) {
    summary[key] = transformSummary[key];
  });
  if (transformSummary.changed) summary.changedFiles++;

  var normalizeSummary = normalizeProgrammerDeliveryScripts(root);
  summary.namingChangedFiles = normalizeSummary.changedFiles;
  summary.methodCommentsInserted = normalizeSummary.methodCommentsInserted;
  summary.sceneObjectsInjected = normalizeSummary.sceneObjectsInjected;
  summary.sceneObjectNames = normalizeSummary.sceneObjectNames;
  summary.sceneRegistryWritten = normalizeSummary.sceneRegistryWritten;
  summary.gfmScriptsRenamed = normalizeSummary.gfmScriptsRenamed || 0;
  summary.unusedScriptsRemoved = normalizeSummary.unusedScriptsRemoved || 0;
  summary.unusedScriptLinesRemoved = normalizeSummary.unusedScriptLinesRemoved || 0;
  summary.unusedScriptNamesRemoved = normalizeSummary.unusedScriptNamesRemoved || [];
  summary.entityBindingPoolsRewritten = normalizeSummary.entityBindingPoolsRewritten || 0;
  summary.scenePrimitivePoolNamesRenamed = normalizeSummary.scenePrimitivePoolNamesRenamed || 0;
  summary.primitivePoolReferenceFilesScrubbed = normalizeSummary.primitivePoolReferenceFilesScrubbed || 0;
  if (normalizeSummary.changedFiles) summary.changedFiles += normalizeSummary.changedFiles;

  rewriteReadmeForProgrammerDelivery(root);

  writeHandoff(root, options.project || {}, summary);
  var graphSummary = codeRelationGraphWriter.writeCodeRelationGraphs(root, {
    projectId: options.project && options.project.id,
    projectName: options.project && options.project.name
  });
  summary.codeRelationGraph = graphSummary;

  // 反馈 01 (2026-04-26) Phase B.1: non-blocking 类/方法/嵌套规模告警。
  // 运行在 clean+transform 之后,反映程序员实际看到的产物。
  // Wave D 反馈 6 (2026-05-02): 额外跑 blocking 规则,失败装进 summary.errors,
  // 上层 (api/projects.cjs) 看到非空就拒绝 commit。
  try {
    var deliveryClassValidator = require('../engine/delivery-class-validator.cjs');
    summary.warnings = deliveryClassValidator.validateDeliveryDirectory(root, options.validatorOpts);
    summary.errors = deliveryClassValidator.validateBlockingRules(root);
  } catch (e) {
    summary.warnings = [];
    summary.errors = [];
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
