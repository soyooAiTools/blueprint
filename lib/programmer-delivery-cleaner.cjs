var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
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
  // v14 程序员交付：具体项目实体不再走 Build/Resource/Combat 中间继承层。
  // 可复用能力改由 Core/Components 组合，避免简单项目出现 4 层继承链。
  classifyEntity(entityName);
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
  if (!clean) return 'mValue';
  clean = clean.replace(/_+([A-Za-z0-9])/g, function(_, c) { return c.toUpperCase(); });
  return 'm' + clean.charAt(0).toUpperCase() + clean.slice(1);
}

function toBoolMemberName(name) {
  var clean = String(name || '').replace(/^_+/, '');
  var m = /^m([A-Z][A-Za-z0-9_]*)$/.exec(clean);
  if (m) clean = m[1];
  clean = clean.replace(/^(?:Is|is)(?=[A-Z])/, '');
  clean = clean.replace(/_+([A-Za-z0-9])/g, function(_, c) { return c.toUpperCase(); });
  if (!clean) return 'IsValue';
  return 'Is' + clean.charAt(0).toUpperCase() + clean.slice(1);
}

function toPrivateFieldName(name) {
  var text = String(name || '');
  var m = /^m([A-Z][A-Za-z0-9_]*)$/.exec(text);
  if (m) return 'm' + m[1].charAt(0).toUpperCase() + m[1].slice(1);
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

function collectMemberNames(text) {
  var names = Object.create(null);
  replaceOutsideStringLiterals(text, function(segment) {
    segment.replace(/\b[A-Za-z_][A-Za-z0-9_<>,\[\]\s]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*get\b/g, function(_, name) {
      names[name] = true;
      return _;
    });
    segment.replace(/\b(?:public|private|protected|internal|static|virtual|override|sealed|new|extern|unsafe|\s)+[A-Za-z_][A-Za-z0-9_<>,\[\]]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g, function(_, name) {
      names[name] = true;
      return _;
    });
    return segment;
  });
  return names;
}

function uniqueMemberName(name, reserved) {
  if (!reserved || !reserved[name]) return name;
  var base = name + 'Value';
  var candidate = base;
  var i = 2;
  while (reserved[candidate]) {
    candidate = base + i;
    i++;
  }
  return candidate;
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
  var reserved = collectMemberNames(text);
  replaceOutsideStringLiterals(text, function(segment) {
    segment.replace(/(^|[^A-Za-z0-9_])bool\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?=[=;,\)\{])/g, function(_, prefix, name) {
      var wanted = toBoolMemberName(name);
      if (wanted === name) {
        reserved[name] = true;
        return _;
      }
      var next = uniqueMemberName(wanted, reserved);
      reserved[next] = true;
      map[name] = next;
      return _;
    });
    return segment;
  });
  replaceOutsideStringLiterals(text, function(segment) {
    segment.replace(/\bm[A-Z][A-Za-z0-9_]*/g, function(name) {
      if (map[name]) return name;
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
  text = text.replace(/\b(GMP_ResourceIds)\.m([A-Z][A-Za-z0-9_]*)/g, function(_, owner, name) {
    return owner + '.' + name;
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
    '    public GMP_EntityState mState = GMP_EntityState.Hidden; // 通用实体状态,禁止再用 0/1/2/3 魔法数字。',
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
    // v14: Build / Resource / Combat 等能力改为 Core/Components 组合，不再插入中间继承层。
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
      '    public int Health = 100; // 当前生命值,降到 0 时把状态标为 Invalid 并隐藏血条。',
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
      '    // 【受击】扣血 + 刷新血条;归零时把状态标为 Invalid,具体敌人类可覆写做死亡动画。',
      '    // ====================================================================',
      '    public virtual void ApplyDamage(int amount)',
      '    {',
      '        Health = Mathf.Max(0, Health - Mathf.Max(0, amount));',
      '        RefreshHealthBar();',
      '        if (Health == 0) mState = GMP_EntityState.Invalid;',
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
    '            OnInit();',
    '        }',
    '    }',
    '',
    '    /// <summary>',
    '    /// 子类初始化扩展点；需要创建 UI、缓存组件或注册模块时覆写。',
    '    /// </summary>',
    '    protected virtual void OnInit() {}',
    '}'
  ].join('\n');
}

function buildCoreEnumsCode() {
  return [
    '/// <summary>',
    '/// 程序员交付版核心枚举。所有跨层状态都放在这里，避免散落 0/1/2 或字符串 gate。',
    '/// </summary>',
    'public enum GMP_GameState',
    '{',
    '    None = 0,',
    '    Start = 1,',
    '    Run = 2,',
    '    End = 3,',
    '    Success = 4',
    '}',
    '',
    'public enum GMP_EntityState',
    '{',
    '    Hidden = 0,',
    '    Active = 1,',
    '    Completed = 2,',
    '    Invalid = 3',
    '}',
    '',
    'public enum GMP_PhaseGateKind',
    '{',
    '    None = 0,',
    '    Timer = 1,',
    '    Resource = 2,',
    '    Entity = 3,',
    '    EntityCount = 4',
    '}'
  ].join('\n');
}

function buildMovementComponentCode() {
  return [
    'using UnityEngine;',
    '',
    'public class GMP_MovementComponent : MonoBehaviour',
    '{',
    '    public float mDefaultSpeed = 5f; // 默认移动速度,业务层可按角色覆写。',
    '',
    '    public void Move(Transform target, Vector3 direction, float speed)',
    '    {',
    '        if (target == null || direction.sqrMagnitude < 0.0001f) return;',
    '        float finalSpeed = speed > 0f ? speed : mDefaultSpeed;',
    '        Vector3 delta = direction.normalized * (finalSpeed * Time.deltaTime);',
    '        target.position += delta;',
    '        target.rotation = Quaternion.LookRotation(new Vector3(direction.x, 0f, direction.z));',
    '    }',
    '}'
  ].join('\n');
}

function buildTriggerComponentCode() {
  return [
    'using System;',
    'using UnityEngine;',
    '',
    'public class GMP_TriggerComponent : MonoBehaviour',
    '{',
    '    public float mRadius = 2.5f; // 默认交互半径。',
    '    private GameObject mCurrentTarget; // 当前处于范围内的对象。',
    '',
    '    public event Action<GameObject> OnEnter; // 进入交互范围时通知业务层。',
    '    public event Action<GameObject> OnExit; // 离开交互范围时通知业务层。',
    '',
    '    public bool IsNear(Transform source, Transform target, float range)',
    '    {',
    '        if (source == null || target == null) return false;',
    '        float finalRange = range > 0f ? range : mRadius;',
    '        return Vector3.Distance(source.position, target.position) <= finalRange;',
    '    }',
    '',
    '    public void Check(Transform source, GameObject target, float range)',
    '    {',
    '        bool IsInside = target != null && IsNear(source, target.transform, range);',
    '        if (IsInside && mCurrentTarget != target)',
    '        {',
    '            mCurrentTarget = target;',
    '            if (OnEnter != null) OnEnter(target);',
    '            return;',
    '        }',
    '        if (!IsInside && mCurrentTarget != null)',
    '        {',
    '            GameObject old = mCurrentTarget;',
    '            mCurrentTarget = null;',
    '            if (OnExit != null) OnExit(old);',
    '        }',
    '    }',
    '}'
  ].join('\n');
}

function buildInteractionComponentCode() {
  return [
    'using UnityEngine;',
    '',
    'public class GMP_InteractionComponent : MonoBehaviour',
    '{',
    '    public virtual bool CanInteract(GameObject target)',
    '    {',
    '        return target != null;',
    '    }',
    '',
    '    public bool TryInteract(GameObject target)',
    '    {',
    '        if (!CanInteract(target)) return false;',
    '        OnInteract(target);',
    '        return true;',
    '    }',
    '',
    '    public virtual void OnInteract(GameObject target)',
    '    {',
    '        // 具体项目行为放在 Game/Level，不在 Core 里写业务规则。',
    '    }',
    '}'
  ].join('\n');
}

function buildInventoryComponentCode() {
  return [
    'using UnityEngine;',
    '',
    'public abstract class GMP_InventoryComponent : MonoBehaviour',
    '{',
    '    public int mCapacity = 0; // 背包容量,具体项目可在 Game 层扩展。',
    '    public int mAmount = 0; // 当前携带数量。',
    '    public string mItemId = ""; // 当前携带物 ID。',
    '',
    '    public bool IsEnabledForGame { get { return mCapacity > 0; } }',
    '',
    '    public bool CanAdd(string itemId, int amount)',
    '    {',
    '        if (amount <= 0 || string.IsNullOrEmpty(itemId)) return false;',
    '        if (mCapacity <= 0) return false;',
    '        if (!string.IsNullOrEmpty(mItemId) && mItemId != itemId) return false;',
    '        return mAmount + amount <= mCapacity;',
    '    }',
    '',
    '    public bool Add(string itemId, int amount)',
    '    {',
    '        if (!CanAdd(itemId, amount)) return false;',
    '        mItemId = itemId;',
    '        mAmount += amount;',
    '        OnPickup(itemId, amount);',
    '        return true;',
    '    }',
    '',
    '    public bool Remove(int amount)',
    '    {',
    '        if (amount <= 0 || amount > mAmount) return false;',
    '        mAmount -= amount;',
    '        if (mAmount == 0) mItemId = "";',
    '        return true;',
    '    }',
    '',
    '    protected abstract void OnPickup(string itemId, int amount);',
    '}'
  ].join('\n');
}

function buildSkillComponentCode() {
  return [
    'using UnityEngine;',
    '',
    'public abstract class GMP_SkillComponent : MonoBehaviour',
    '{',
    '    public bool IsEnabledForGame = false; // 当前项目没有技能时保持 false。',
    '',
    '    public bool Cast(string skillId, GameObject target)',
    '    {',
    '        if (!IsEnabledForGame || string.IsNullOrEmpty(skillId)) return false;',
    '        OnCast(skillId, target);',
    '        return true;',
    '    }',
    '',
    '    protected abstract void OnCast(string skillId, GameObject target);',
    '}'
  ].join('\n');
}

function buildEventModuleCode() {
  return [
    'using System;',
    'using System.Collections.Generic;',
    'using UnityEngine;',
    '',
    'public class GMP_EventModule : MonoSingleton<GMP_EventModule>',
    '{',
    '    private readonly Dictionary<string, Action<object>> mListeners = new Dictionary<string, Action<object>>();',
    '',
    '    public void Subscribe(string eventName, Action<object> callback)',
    '    {',
    '        if (string.IsNullOrEmpty(eventName) || callback == null) return;',
    '        Action<object> current;',
    '        mListeners.TryGetValue(eventName, out current);',
    '        current -= callback;',
    '        current += callback;',
    '        mListeners[eventName] = current;',
    '    }',
    '',
    '    public void Unsubscribe(string eventName, Action<object> callback)',
    '    {',
    '        if (string.IsNullOrEmpty(eventName) || callback == null) return;',
    '        Action<object> current;',
    '        if (!mListeners.TryGetValue(eventName, out current)) return;',
    '        current -= callback;',
    '        if (current == null) mListeners.Remove(eventName);',
    '        else mListeners[eventName] = current;',
    '    }',
    '',
    '    public void Publish(string eventName, object payload)',
    '    {',
    '        if (string.IsNullOrEmpty(eventName)) return;',
    '        Action<object> current;',
    '        if (!mListeners.TryGetValue(eventName, out current) || current == null) return;',
    '        current(payload);',
    '    }',
    '}'
  ].join('\n');
}

function buildDeliveryAudioCode() {
  return [
    'using UnityEngine;',
    '',
    'public class GMP_Audio : MonoBehaviour',
    '{',
    '    private static GMP_Audio mInstance;',
    '    public static GMP_Audio instance { get { return mInstance; } }',
    '',
    '    public AudioClip[] mBgmList = new AudioClip[0];',
    '    public AudioClip[] mSfxList = new AudioClip[0];',
    '',
    '    private AudioSource mBgmSource;',
    '    private AudioSource mSfxSource;',
    '    private bool IsMuted = false;',
    '',
    '    public static GMP_Audio Init(GameObject parent)',
    '    {',
    '        if (mInstance != null) return mInstance;',
    '        GameObject obj = GMP_SceneObjectRegistry.Find("GMP_Audio");',
    '        if (obj == null) return null;',
    '        if (parent != null) obj.transform.SetParent(parent.transform);',
    '        mInstance = obj.GetComponent<GMP_Audio>();',
    '        if (mInstance == null) return null;',
    '',
    '        AudioSource[] sources = obj.GetComponents<AudioSource>();',
    '        if (sources != null && sources.Length > 0) mInstance.mBgmSource = sources[0];',
    '        if (sources != null && sources.Length > 1) mInstance.mSfxSource = sources[1];',
    '        else mInstance.mSfxSource = mInstance.mBgmSource;',
    '',
    '        if (mInstance.mBgmSource != null)',
    '        {',
    '            mInstance.mBgmSource.loop = true;',
    '            mInstance.mBgmSource.playOnAwake = false;',
    '        }',
    '        if (mInstance.mSfxSource != null)',
    '        {',
    '            mInstance.mSfxSource.loop = false;',
    '            mInstance.mSfxSource.playOnAwake = false;',
    '        }',
    '',
    '        return mInstance;',
    '    }',
    '',
    '    public AudioClip GetBGM(int index)',
    '    {',
    '        if (mBgmList == null || index < 0 || index >= mBgmList.Length) return null;',
    '        return mBgmList[index];',
    '    }',
    '',
    '    public AudioClip GetSFX(int index)',
    '    {',
    '        if (mSfxList == null || index < 0 || index >= mSfxList.Length) return null;',
    '        return mSfxList[index];',
    '    }',
    '',
    '    public void PlayBGM(int index)',
    '    {',
    '        PlayBGM(GetBGM(index));',
    '    }',
    '',
    '    public void PlayBGM(AudioClip clip)',
    '    {',
    '        if (clip == null || mBgmSource == null) return;',
    '        mBgmSource.clip = clip;',
    '        if (!IsMuted) mBgmSource.Play();',
    '    }',
    '',
    '    public void StopBGM()',
    '    {',
    '        if (mBgmSource != null) mBgmSource.Stop();',
    '    }',
    '',
    '    public void PlaySFX(int index)',
    '    {',
    '        PlaySFX(GetSFX(index));',
    '    }',
    '',
    '    public void PlaySFX(AudioClip clip)',
    '    {',
    '        if (clip == null || mSfxSource == null || IsMuted) return;',
    '        mSfxSource.PlayOneShot(clip);',
    '    }',
    '',
    '    public void PlayPitch(int clipIndex, int pitchIndex)',
    '    {',
    '        PlayPitch(GetSFX(clipIndex), pitchIndex);',
    '    }',
    '',
    '    public void PlayPitch(AudioClip clip, int index)',
    '    {',
    '        if (clip == null || mSfxSource == null || IsMuted) return;',
    '        float[] offset = new float[] { 2f, 2f, 1f, 2f, 2f, 2f, 1f, 2f, 2f, 1f };',
    '        if (index >= offset.Length) index = index % offset.Length;',
    '        float add = 0;',
    '        for (int i = 0; i < index; i++) add += offset[i];',
    '        mSfxSource.pitch = Mathf.Pow(2f, add / 12f);',
    '        mSfxSource.PlayOneShot(clip);',
    '        mSfxSource.pitch = 1f;',
    '    }',
    '',
    '    public void SetMute(bool IsMute)',
    '    {',
    '        IsMuted = IsMute;',
    '        AudioListener.volume = IsMute ? 0f : 1f;',
    '    }',
    '}'
  ].join('\n');
}

function repairDeliveryAudioManager(scriptsRoot) {
  var file = path.join(scriptsRoot, 'Core', 'Modules', 'GMP_Audio.cs');
  if (!fs.existsSync(file)) {
    file = findScriptByClass(path.dirname(scriptsRoot), 'GMP_Audio') || findScriptByClass(scriptsRoot, 'GMP_Audio');
  }
  if (!file || !fs.existsSync(file)) return false;
  var before = fs.readFileSync(file, 'utf8');
  var next = buildDeliveryAudioCode();
  if (before === next || before === next + '\n') return false;
  writeGeneratedCs(file, next);
  return true;
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

function audioSourceYaml(id, goId, loop) {
  return [
    '--- !u!82 &' + id,
    'AudioSource:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_Enabled: 1',
    '  serializedVersion: 4',
    '  OutputAudioMixerGroup: {fileID: 0}',
    '  m_audioClip: {fileID: 0}',
    '  m_PlayOnAwake: 0',
    '  m_Volume: 1',
    '  m_Pitch: 1',
    '  Loop: ' + (loop ? 1 : 0),
    '  Mute: 0',
    '  Spatialize: 0',
    '  SpatializePostEffects: 0',
    '  Priority: 128',
    '  DopplerLevel: 1',
    '  MinDistance: 1',
    '  MaxDistance: 500',
    '  Pan2D: 0',
    '  rolloffMode: 0',
    '  BypassEffects: 0',
    '  BypassListenerEffects: 0',
    '  BypassReverbZones: 0',
    ''
  ].join('\n');
}

function sceneObjectYaml(name, guid, index, extraSerializedLines) {
  var baseSeed = name + ':' + guid + ':' + index;
  var goId = deterministicSceneFileId(baseSeed + ':go');
  var transformId = deterministicSceneFileId(baseSeed + ':transform');
  var componentId = deterministicSceneFileId(baseSeed + ':script');
  var audioBgmSourceId = name === 'GMP_Audio' ? deterministicSceneFileId(baseSeed + ':bgm-source') : '';
  var audioSfxSourceId = name === 'GMP_Audio' ? deterministicSceneFileId(baseSeed + ':sfx-source') : '';
  var x = (index % 6) * 1.5;
  var z = Math.floor(index / 6) * 1.5;
  var componentLines = [
    '  - component: {fileID: ' + transformId + '}',
    '  - component: {fileID: ' + componentId + '}'
  ];
  if (audioBgmSourceId) {
    componentLines.push('  - component: {fileID: ' + audioBgmSourceId + '}');
    componentLines.push('  - component: {fileID: ' + audioSfxSourceId + '}');
  }
  var lines = [
    '--- !u!1 &' + goId,
    'GameObject:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  serializedVersion: 6',
    '  m_Component:',
    componentLines.join('\n'),
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
    '  m_EditorClassIdentifier: '
  ];
  (extraSerializedLines || []).forEach(function(line) {
    lines.push(line);
  });
  lines.push('');
  if (audioBgmSourceId) {
    lines.push(audioSourceYaml(audioBgmSourceId, goId, true));
    lines.push(audioSourceYaml(audioSfxSourceId, goId, false));
  }
  return lines.join('\n');
}

function monoBehaviourYaml(id, goId, guid, extraSerializedLines) {
  var lines = [
    '--- !u!114 &' + id,
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
    '  m_EditorClassIdentifier: '
  ];
  (extraSerializedLines || []).forEach(function(line) {
    lines.push(line);
  });
  lines.push('');
  return lines.join('\n');
}

function findScriptByClass(root, className) {
  var candidates = [];
  var input = path.resolve(root);
  candidates.push(path.join(input, 'Assets', 'Scripts'));
  candidates.push(path.join(input, 'Scripts'));
  if (path.basename(input) === 'Scripts') candidates.push(input);
  if (path.basename(input) === 'Assets') candidates.push(path.join(input, 'Scripts'));
  var seen = Object.create(null);
  var files = [];
  candidates.forEach(function(dir) {
    if (!fs.existsSync(dir) || seen[dir]) return;
    seen[dir] = true;
    files = files.concat(walkFiles(dir));
  });
  files = files.filter(function(file) {
    return path.basename(file) === className + '.cs';
  });
  return files[0] || '';
}

function prefixNonGmpClassNames(scriptsRoot) {
  if (!fs.existsSync(scriptsRoot)) return { renamed: 0, changedFiles: 0, classMap: {} };
  var exceptions = {
    MonoSingleton: true
  };
  var files = walkFiles(scriptsRoot).filter(function(file) {
    return path.extname(file).toLowerCase() === '.cs';
  });
  var classMap = Object.create(null);
  files.forEach(function(file) {
    var text = fs.readFileSync(file, 'utf8');
    text.replace(/\b(?:public|internal|private|protected|abstract|static|sealed|partial|\s)+class\s+([A-Za-z_][A-Za-z0-9_]*)\b/g, function(_, name) {
      if (/^GMP_/.test(name) || exceptions[name]) return _;
      classMap[name] = 'GMP_' + name;
      return _;
    });
  });
  var keys = Object.keys(classMap).sort(function(a, b) { return b.length - a.length; });
  if (!keys.length) return { renamed: 0, changedFiles: 0, classMap: {} };

  var changedFiles = 0;
  files.forEach(function(file) {
    var before = fs.readFileSync(file, 'utf8');
    var next = before;
    keys.forEach(function(oldName) {
      next = replaceIdentifierOutsideStrings(next, oldName, classMap[oldName]);
    });
    if (next !== before) {
      fs.writeFileSync(file, next.replace(/\s+$/g, '') + '\n');
      changedFiles++;
    }
  });

  var renamed = 0;
  files.forEach(function(file) {
    var base = path.basename(file, '.cs');
    if (!classMap[base]) return;
    if (!fs.existsSync(file)) return;
    var target = path.join(path.dirname(file), classMap[base] + '.cs');
    if (moveFileWithMeta(file, target)) renamed++;
  });
  return { renamed: renamed, changedFiles: changedFiles, classMap: classMap };
}

function readTextIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function readProjectData(projectId) {
  if (!projectId) return null;
  var file = path.join(__dirname, '..', 'server-data', 'projects', projectId + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function visualManifestScore(manifest) {
  if (!manifest || typeof manifest !== 'object') return -1;
  var assets = Array.isArray(manifest.assets) ? manifest.assets.length : 0;
  var entityCount = manifest.sourceEntityContract && Number(manifest.sourceEntityContract.sourceEntityCount || manifest.sourceEntityContract.styleEntityCount || 0) || 0;
  var scene = manifest.sourceSceneContract && manifest.sourceSceneContract.present !== false ? 1 : 0;
  var guidance = manifest.sourceSceneContract && manifest.sourceSceneContract.guidance && manifest.sourceSceneContract.guidance.present ? 1 : 0;
  var extracted = manifest.extractionSummary && Number(manifest.extractionSummary.extractedMeshRate || 0) || 0;
  return assets + entityCount * 10 + scene * 1000 + guidance * 5000 + extracted * 100;
}

function visualManifestCandidatesFromSource(sourceFile) {
  var out = [];
  if (!sourceFile || !fs.existsSync(sourceFile)) return out;
  var dir = fs.statSync(sourceFile).isDirectory() ? sourceFile : path.dirname(sourceFile);
  var direct = [
    path.join(dir, 'asset-manifest.json'),
    path.join(dir, 'blueprint-visual-assets.json'),
    path.join(dir, 'blueprint-smoke', 'blueprint-visual-assets.json')
  ];
  direct.forEach(function(file) { out.push(file); });
  try {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
      if (!entry.isDirectory()) return;
      if (!/^(demo2spec-delivery|smoke|blueprint-smoke)/.test(entry.name)) return;
      var sub = path.join(dir, entry.name);
      out.push(path.join(sub, 'asset-manifest.json'));
      out.push(path.join(sub, 'blueprint-visual-assets.json'));
      out.push(path.join(sub, 'blueprint-smoke', 'blueprint-visual-assets.json'));
    });
  } catch (e) {}
  return out;
}

function chooseBestVisualAssetManifest(data) {
  data = data || {};
  var candidates = [];
  if (data.visualAssets) candidates.push({ manifest: data.visualAssets, source: 'project.visualAssets' });
  if (data.visualAssetPlan && data.visualAssetPlan.sourceManifest) {
    candidates.push({ manifest: data.visualAssetPlan.sourceManifest, source: 'project.visualAssetPlan.sourceManifest' });
  }
  [
    data.visualAssets && data.visualAssets.source,
    data.visualAssetPlan && data.visualAssetPlan.source,
    data.source && /\.html?$/i.test(data.source) ? data.source : ''
  ].filter(Boolean).forEach(function(sourceFile) {
    visualManifestCandidatesFromSource(sourceFile).forEach(function(file) {
      var manifest = readJsonIfExists(file);
      if (manifest) candidates.push({ manifest: manifest, source: file });
    });
  });
  var best = null;
  candidates.forEach(function(candidate) {
    var score = visualManifestScore(candidate.manifest);
    if (!best || score > best.score || (score === best.score && String(candidate.source).localeCompare(String(best.source)) > 0)) {
      best = { manifest: candidate.manifest, source: candidate.source, score: score };
    }
  });
  return best && best.score >= 0 ? best : null;
}

function extractObjectLiteralFromHtml(html, name) {
  var marker = 'const ' + name + ' =';
  var idx = String(html || '').indexOf(marker);
  if (idx < 0) return null;
  var open = html.indexOf('{', idx);
  if (open < 0) return null;
  var close = findMatchingBrace(html, open);
  if (close < 0) return null;
  var literal = html.slice(open, close + 1);
  try {
    return (new Function('return (' + literal + ');'))();
  } catch (e) {
    return null;
  }
}

function colorFromValue(value) {
  if (value && typeof value === 'object' && isFinite(value.r) && isFinite(value.g) && isFinite(value.b)) {
    return {
      r: Math.max(0, Math.min(1, Number(value.r))),
      g: Math.max(0, Math.min(1, Number(value.g))),
      b: Math.max(0, Math.min(1, Number(value.b))),
      a: value.a == null ? 1 : Math.max(0, Math.min(1, Number(value.a)))
    };
  }
  if (value != null) {
    var numeric = Number(value);
    if (isFinite(numeric)) {
      return {
        r: ((numeric >> 16) & 255) / 255,
        g: ((numeric >> 8) & 255) / 255,
        b: (numeric & 255) / 255,
        a: 1
      };
    }
    var hex = /^#?([0-9a-fA-F]{6})$/.exec(String(value).trim());
    if (hex) {
      var v = parseInt(hex[1], 16);
      return {
        r: ((v >> 16) & 255) / 255,
        g: ((v >> 8) & 255) / 255,
        b: (v & 255) / 255,
        a: 1
      };
    }
  }
  return null;
}

function sceneConfigFromHtml(html) {
  var scene = {};
  var cfg = extractObjectLiteralFromHtml(html, 'SCENE_CONFIG') || {};
  var background = colorFromValue(cfg.backgroundColor);
  if (!background) {
    var bgMatch = /scene\.background\s*=\s*new\s+THREE\.Color\(\s*(0x[0-9a-fA-F]+|#[0-9a-fA-F]{6}|\d+)\s*\)/.exec(String(html || ''));
    if (bgMatch) background = colorFromValue(bgMatch[1]);
  }
  if (background) scene.backgroundColor = background;

  var fog = cfg.fog || {};
  var fogColor = colorFromValue(fog.color);
  if (!fogColor) {
    var fogMatch = /scene\.fog\s*=\s*new\s+THREE\.Fog\(\s*(0x[0-9a-fA-F]+|#[0-9a-fA-F]{6}|\d+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/.exec(String(html || ''));
    if (fogMatch) {
      fogColor = colorFromValue(fogMatch[1]);
      fog.near = Number(fogMatch[2]);
      fog.far = Number(fogMatch[3]);
    }
  }
  if (fogColor) {
    scene.fog = {
      color: fogColor,
      near: isFinite(Number(fog.near)) ? Number(fog.near) : 55,
      far: isFinite(Number(fog.far)) ? Number(fog.far) : 145
    };
  }

  var ground = cfg.ground || {};
  var groundColor = colorFromValue(ground.color);
  if (!groundColor) {
    var groundMatch = /groundMat\s*=\s*new\s+THREE\.MeshStandardMaterial\(\s*\{[^}]*color:\s*(0x[0-9a-fA-F]+|#[0-9a-fA-F]{6}|\d+)/.exec(String(html || ''));
    if (groundMatch) groundColor = colorFromValue(groundMatch[1]);
  }
  if (groundColor) scene.ground = { color: groundColor };

  var ambient = cfg.ambientLight || {};
  var ambientColor = colorFromValue(ambient.color);
  if (ambientColor) {
    scene.ambientLight = {
      color: ambientColor,
      intensity: isFinite(Number(ambient.intensity)) ? Number(ambient.intensity) : 1
    };
  }

  var directional = cfg.directionalLight || {};
  var directionalColor = colorFromValue(directional.color);
  if (directionalColor) {
    scene.directionalLight = {
      color: directionalColor,
      intensity: isFinite(Number(directional.intensity)) ? Number(directional.intensity) : 1
    };
  }
  if (cfg.camera) scene.camera = cfg.camera;
  return scene;
}

function mergeSceneConfig(base, next) {
  base = base || {};
  next = next || {};
  var out = Object.assign({}, base);
  if (next.backgroundColor) out.backgroundColor = next.backgroundColor;
  if (next.fog) out.fog = next.fog;
  if (next.ground) out.ground = next.ground;
  if (next.ambientLight) out.ambientLight = next.ambientLight;
  if (next.directionalLight) out.directionalLight = next.directionalLight;
  if (next.rimLight) out.rimLight = next.rimLight;
  if (next.decor) out.decor = next.decor;
  if (next.guidance) out.guidance = next.guidance;
  if (next.camera) out.camera = next.camera;
  return out;
}

function sceneConfigFromProjectData(data) {
  var scene = {};
  var contract = data && data.visualAssets && data.visualAssets.sourceSceneContract;
  if (contract && contract.present !== false) {
    scene.backgroundColor = colorFromValue(contract.backgroundColor);
    if (contract.fog) {
      scene.fog = {
        color: colorFromValue(contract.fog.color || contract.backgroundColor),
        near: Number(contract.fog.near || 55),
        far: Number(contract.fog.far || 145)
      };
    }
    if (contract.ground) scene.ground = { color: colorFromValue(contract.ground.color) };
    if (contract.ambientLight) {
      scene.ambientLight = {
        color: colorFromValue(contract.ambientLight.color),
        intensity: Number(contract.ambientLight.intensity || 1)
      };
    }
    if (contract.directionalLight) {
      scene.directionalLight = {
        color: colorFromValue(contract.directionalLight.color),
        intensity: Number(contract.directionalLight.intensity || 1),
        position: contract.directionalLight.position
      };
    }
    if (contract.rimLight) {
      scene.rimLight = {
        color: colorFromValue(contract.rimLight.color),
        intensity: Number(contract.rimLight.intensity || 1),
        position: contract.rimLight.position,
        distance: Number(contract.rimLight.distance || 80)
      };
    }
    if (contract.decor) scene.decor = contract.decor;
    if (contract.guidance) scene.guidance = contract.guidance;
    if (contract.camera) scene.camera = contract.camera;
  }
  var assets = data && data.visualAssets && Array.isArray(data.visualAssets.assets) ? data.visualAssets.assets : [];
  assets.forEach(function(asset) {
    if (!asset || asset.assetId !== 'asset_ground' || !asset.material || scene.ground) return;
    var color = colorFromValue(asset.material.diffuseColor);
    if (color) scene.ground = { color: color };
  });
  return scene;
}

function readVisualHints(root, project) {
  project = project || {};
  var projectId = project.id || '';
  var fileData = readProjectData(projectId) || {};
  var data = Object.assign({}, project, fileData);
  var bestManifest = chooseBestVisualAssetManifest(data);
  if (bestManifest && bestManifest.manifest) {
    data.visualAssets = Object.assign({}, data.visualAssets || {}, bestManifest.manifest);
    data.visualAssets.__selectedManifestSource = bestManifest.source;
  }
  var styles = {};
  var positions = {};
  var scene = sceneConfigFromProjectData(data);
  if (data.visualAssets && data.visualAssets.sourceEntityContract) {
    var contract = data.visualAssets.sourceEntityContract;
    styles = Object.assign(styles, contract.entityStyles || {});
    Object.keys(contract.entityStyles || {}).forEach(function(name) {
      if (contract.entityStyles[name] && contract.entityStyles[name].position) {
        positions[name] = contract.entityStyles[name].position;
      }
    });
  }
  var entityList = Array.isArray(data.entities) ? data.entities : [];
  entityList.forEach(function(entity) {
    if (!entity || !entity.name) return;
    if (!positions[entity.name] && entity.visual && entity.visual.position) {
      var parsed = parseVector3(entity.visual.position);
      if (parsed) positions[entity.name] = { x: parsed.x, y: parsed.y, z: parsed.z };
    }
  });
  var htmlCandidates = [
    data.visualAssets && data.visualAssets.source,
    data.visualAssetPlan && data.visualAssetPlan.source,
    data.source && /\.html?$/i.test(data.source) ? data.source : '',
    path.join(__dirname, '..', 'server-data', 'webgl', projectId, 'index.html')
  ].filter(Boolean);
  for (var i = 0; i < htmlCandidates.length; i++) {
    var htmlFile = htmlCandidates[i];
    if (!fs.existsSync(htmlFile) || fs.statSync(htmlFile).size > 5 * 1024 * 1024) continue;
    var html = readTextIfExists(htmlFile);
    styles = Object.assign(styles, extractObjectLiteralFromHtml(html, 'ENTITY_STYLE') || {});
    positions = Object.assign(positions, extractObjectLiteralFromHtml(html, 'ENTITY_POSITIONS') || {}, positions);
    scene = mergeSceneConfig(scene, sceneConfigFromHtml(html));
  }
  return { styles: styles, positions: positions, scene: scene, project: data, visualAssets: data.visualAssets || null };
}

function parseVector3(value) {
  if (value && typeof value === 'object' && isFinite(value.x) && isFinite(value.z)) {
    return { x: Number(value.x), y: Number(value.y || 0), z: Number(value.z) };
  }
  var match = /\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/.exec(String(value || ''));
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

function canonicalEntityName(name) {
  var raw = String(name || '').replace(/^_+/, '');
  if (/^m[A-Z]/.test(raw)) raw = raw.charAt(1).toLowerCase() + raw.slice(2);
  if (!raw) return '';
  return raw.replace(/(^|_)([a-zA-Z0-9])/g, function(_, __, c) { return c.toUpperCase(); });
}

function unityEntityName(name) {
  var canonical = canonicalEntityName(name);
  if (!canonical) return '';
  return '_' + canonical.charAt(0).toLowerCase() + canonical.slice(1);
}

function colorFromStyle(style, fallbackSeed) {
  if (style && style.color != null) {
    var direct = colorFromValue(style.color);
    if (direct) return direct;
  }
  var hash = crypto.createHash('sha1').update(String(fallbackSeed || 'material')).digest();
  return {
    r: 0.25 + (hash[0] / 255) * 0.55,
    g: 0.25 + (hash[1] / 255) * 0.55,
    b: 0.25 + (hash[2] / 255) * 0.55,
    a: 1
  };
}

function materialYaml(name, shaderGuid, color, options) {
  color = color || { r: 1, g: 1, b: 1, a: 1 };
  options = options || {};
  var tint = options.tintColor || color;
  var emission = options.emissionColor || scaledColor(color, 0.35);
  var renderQueue = options.renderQueue == null ? 2000 : options.renderQueue;
  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!21 &2100000',
    'Material:',
    '  serializedVersion: 8',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_Name: ' + name,
    '  m_Shader: {fileID: 4800000, guid: ' + shaderGuid + ', type: 3}',
    '  m_Parent: {fileID: 0}',
    '  m_ModifiedSerializedProperties: 0',
    '  m_ValidKeywords: []',
    '  m_InvalidKeywords: []',
    '  m_LightmapFlags: 4',
    '  m_EnableInstancingVariants: 0',
    '  m_DoubleSidedGI: 0',
    '  m_CustomRenderQueue: ' + renderQueue,
    '  stringTagMap: {}',
    '  disabledShaderPasses: []',
    '  m_LockedProperties: ',
    '  m_SavedProperties:',
    '    serializedVersion: 3',
    '    m_TexEnvs:',
    '    - _MainTex:',
    '        m_Texture: {fileID: 0}',
    '        m_Scale: {x: 1, y: 1}',
    '        m_Offset: {x: 0, y: 0}',
    '    m_Ints: []',
    '    m_Floats:',
    '    - _Metallic: 0',
    '    - _SmoothAll: 0.25',
    '    - _Occlusion: 1',
    '    m_Colors:',
    '    - _ColorTint: {r: ' + tint.r.toFixed(4) + ', g: ' + tint.g.toFixed(4) + ', b: ' + tint.b.toFixed(4) + ', a: ' + tint.a.toFixed(4) + '}',
    '    - _Color: {r: ' + color.r.toFixed(4) + ', g: ' + color.g.toFixed(4) + ', b: ' + color.b.toFixed(4) + ', a: ' + color.a.toFixed(4) + '}',
    '    - _EmissionColor: {r: ' + emission.r.toFixed(4) + ', g: ' + emission.g.toFixed(4) + ', b: ' + emission.b.toFixed(4) + ', a: 1.0000}',
    '  m_BuildTextureStacks: []',
    ''
  ].join('\n');
}

function writeNativeAssetMetaWithGuid(file, guid, mainObjectFileID) {
  var lines = [
    'fileFormatVersion: 2',
    'guid: ' + guid,
    'NativeFormatImporter:',
    '  externalObjects: {}',
    '  mainObjectFileID: ' + (mainObjectFileID || 2100000),
    '  userData:',
    '  assetBundleName:',
    '  assetBundleVariant:',
    ''
  ];
  fs.writeFileSync(file + '.meta', lines.join('\n'));
}

function existingAssetGuids(root) {
  var out = Object.create(null);
  walkFiles(path.join(root, 'Assets')).forEach(function(file) {
    if (!/\.meta$/i.test(file)) return;
    var match = /^guid:\s*([0-9a-fA-F]{32})/m.exec(fs.readFileSync(file, 'utf8'));
    if (match) out[match[1]] = true;
  });
  return out;
}

function sceneGameObjectNames(sceneText) {
  var names = Object.create(null);
  String(sceneText || '').replace(/--- !u!1 &(\d+)\nGameObject:\n([\s\S]*?)(?=\n--- !u!|$)/g, function(_, id, block) {
    var match = /\n  m_Name:\s*([^\n\r]*)/.exec(block);
    if (match) names[id] = match[1].trim();
    return _;
  });
  return names;
}

function rendererMaterialOwners(sceneText) {
  var names = sceneGameObjectNames(sceneText);
  var owners = Object.create(null);
  String(sceneText || '').replace(/--- !u!(?:23|120|212) &\d+\n(?:MeshRenderer|SkinnedMeshRenderer|SpriteRenderer):\n([\s\S]*?)(?=\n--- !u!|$)/g, function(_, block) {
    var go = /m_GameObject:\s*\{fileID:\s*(\d+)\}/.exec(block);
    var owner = go ? names[go[1]] : '';
    block.replace(/guid:\s*([0-9a-fA-F]{32}),\s*type:\s*2/g, function(__, guid) {
      if (owner && !owners[guid]) owners[guid] = owner;
      return __;
    });
    return _;
  });
  return owners;
}

function emitFallbackMaterials(root, visualHints) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return { generated: 0, missing: 0 };
  var scene = fs.readFileSync(sceneFile, 'utf8');
  var materialGuids = [];
  scene.replace(/guid:\s*([0-9a-fA-F]{32}),\s*type:\s*2/g, function(_, guid) {
    if (materialGuids.indexOf(guid) < 0) materialGuids.push(guid);
    return _;
  });
  var existing = existingAssetGuids(root);
  var owners = rendererMaterialOwners(scene);
  var missing = materialGuids.filter(function(guid) { return !existing[guid]; });
  var shaderGuid = readUnityMetaGuid(path.join(root, 'Assets', 'Shader', 'SimpleLit.shader')) ||
    readUnityMetaGuid(path.join(root, 'Assets', 'Shaders', 'NavPathArrowAplha.shader'));
  if (!shaderGuid) return { generated: 0, missing: missing.length, shaderMissing: true };
  var dir = path.join(root, 'Assets', 'Materials', 'Generated');
  fs.mkdirSync(dir, { recursive: true });
  var generated = 0;
  for (var i = 0; i < missing.length; i++) {
    var guid = missing[i];
    var owner = owners[guid] || ('Material_' + guid.slice(0, 8));
    var canonical = canonicalEntityName(owner);
    var style = visualHints && visualHints.styles ? visualHints.styles[canonical] : null;
    var isGround = /^__Ground$/i.test(owner);
    var color = isGround && visualHints && visualHints.scene && visualHints.scene.ground && visualHints.scene.ground.color
      ? visualHints.scene.ground.color
      : colorFromStyle(style, guid);
    var materialOptions = isGround
      ? { tintColor: srgbToLinearColor(color), emissionColor: { r: 0, g: 0, b: 0, a: 1 } }
      : null;
    var mat = path.join(dir, 'Delivery_' + sanitizeIdentifier(owner, 'Material') + '_' + guid.slice(0, 8) + '.mat');
    fs.writeFileSync(mat, materialYaml(path.basename(mat, '.mat'), shaderGuid, color, materialOptions));
    writeNativeAssetMetaWithGuid(mat, guid, 2100000);
    generated++;
  }
  return { generated: generated, missing: missing.length };
}

function colorYaml(color) {
  color = color || { r: 0, g: 0, b: 0, a: 1 };
  return '{r: ' + Number(color.r || 0).toFixed(4) +
    ', g: ' + Number(color.g || 0).toFixed(4) +
    ', b: ' + Number(color.b || 0).toFixed(4) +
    ', a: ' + Number(color.a == null ? 1 : color.a).toFixed(4) + '}';
}

function scaledColor(color, scale) {
  color = color || { r: 0, g: 0, b: 0, a: 1 };
  scale = Number(scale || 1);
  return {
    r: Math.max(0, Math.min(1, Number(color.r || 0) * scale)),
    g: Math.max(0, Math.min(1, Number(color.g || 0) * scale)),
    b: Math.max(0, Math.min(1, Number(color.b || 0) * scale)),
    a: color.a == null ? 1 : color.a
  };
}

function srgbToLinearChannel(value) {
  value = Math.max(0, Math.min(1, Number(value || 0)));
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function srgbToLinearColor(color) {
  color = color || { r: 0, g: 0, b: 0, a: 1 };
  return {
    r: srgbToLinearChannel(color.r),
    g: srgbToLinearChannel(color.g),
    b: srgbToLinearChannel(color.b),
    a: color.a == null ? 1 : color.a
  };
}

function replaceYamlScalarLine(text, key, value) {
  var re = new RegExp('(\\n\\s*' + escapeRegExp(key) + ':\\s*)[^\\n\\r]*');
  if (re.test(text)) return text.replace(re, '$1' + value);
  return text;
}

function applySceneContract(root, visualHints) {
  var scene = visualHints && visualHints.scene ? visualHints.scene : {};
  var background = scene.backgroundColor || (scene.fog && scene.fog.color);
  if (!background && !(scene.ground && scene.ground.color)) return { applied: false };
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return { applied: false };
  var doc = splitUnityYaml(fs.readFileSync(sceneFile, 'utf8'));
  var idx = sceneIndex(doc);
  var changed = false;
  var fog = scene.fog || {};
  var fogColor = fog.color || background;
  var ambient = scene.ambientLight && scene.ambientLight.color
    ? scaledColor(scene.ambientLight.color, scene.ambientLight.intensity == null ? 0.4 : Math.min(0.45, Number(scene.ambientLight.intensity) * 0.55))
    : background;

  doc.blocks.forEach(function(block) {
    if (block.type !== '104') return;
    var next = block.text;
    if (background) {
      next = replaceYamlScalarLine(next, 'm_Fog', '1');
      next = replaceYamlScalarLine(next, 'm_FogColor', colorYaml(fogColor || background));
      next = replaceYamlScalarLine(next, 'm_FogMode', '1');
      next = replaceYamlScalarLine(next, 'm_LinearFogStart', unityNumber(fog.near || 55));
      next = replaceYamlScalarLine(next, 'm_LinearFogEnd', unityNumber(fog.far || 145));
      next = replaceYamlScalarLine(next, 'm_SkyboxMaterial', '{fileID: 0}');
      next = replaceYamlScalarLine(next, 'm_AmbientSkyColor', colorYaml(ambient));
      next = replaceYamlScalarLine(next, 'm_AmbientEquatorColor', colorYaml(scaledColor(ambient, 0.75)));
      next = replaceYamlScalarLine(next, 'm_AmbientGroundColor', colorYaml(scaledColor(background, 0.5)));
    }
    if (next !== block.text) {
      block.text = next;
      changed = true;
    }
  });

  var cameraGoId = idx.goByName['Main Camera'];
  if (background && cameraGoId) {
    (idx.goComponents[cameraGoId] || []).forEach(function(componentId) {
      var component = idx.byId[componentId];
      if (!component || component.type !== '20') return;
      var next = component.text;
      next = replaceYamlScalarLine(next, 'm_ClearFlags', '2');
      next = replaceYamlScalarLine(next, 'm_BackGroundColor', colorYaml(background));
      if (next !== component.text) {
        component.text = next;
        changed = true;
      }
    });
  }

  var lightGoId = idx.goByName['__MainLight'];
  if (scene.directionalLight && lightGoId) {
    (idx.goComponents[lightGoId] || []).forEach(function(componentId) {
      var component = idx.byId[componentId];
      if (!component || component.type !== '108') return;
      var next = component.text;
      if (scene.directionalLight.color) next = replaceYamlScalarLine(next, 'm_Color', colorYaml(scene.directionalLight.color));
      if (scene.directionalLight.intensity != null) next = replaceYamlScalarLine(next, 'm_Intensity', unityNumber(scene.directionalLight.intensity));
      if (next !== component.text) {
        component.text = next;
        changed = true;
      }
    });
  }

  if (changed) fs.writeFileSync(sceneFile, joinUnityYaml(doc));
  return {
    applied: changed,
    backgroundColor: !!background,
    fog: !!fogColor,
    groundColor: !!(scene.ground && scene.ground.color)
  };
}

function splitUnityYaml(text) {
  var input = String(text || '');
  var first = input.search(/--- !u!\d+ &-?\d+/);
  if (first < 0) return { preamble: input, blocks: [] };
  var preamble = input.slice(0, first);
  var rest = input.slice(first);
  var blocks = [];
  var re = /--- !u!(\d+) &(-?\d+)\n[\s\S]*?(?=\n--- !u!\d+ &-?\d+|$)/g;
  var match;
  while ((match = re.exec(rest))) {
    blocks.push({
      type: match[1],
      id: match[2],
      text: match[0]
    });
  }
  return { preamble: preamble, blocks: blocks };
}

function joinUnityYaml(doc) {
  var preamble = String(doc.preamble || '');
  var body = (doc.blocks || []).map(function(block) { return block.text.replace(/^\n+/, '').replace(/\s+$/g, ''); }).join('\n');
  return (preamble ? preamble.replace(/\s+$/g, '') + '\n' : '') + body + '\n';
}

function sceneIndex(doc) {
  var byId = Object.create(null);
  var goByName = Object.create(null);
  var goComponents = Object.create(null);
  var componentGo = Object.create(null);
  var transformGo = Object.create(null);
  var fatherByTransform = Object.create(null);
  (doc.blocks || []).forEach(function(block) {
    byId[block.id] = block;
    if (block.type === '1') {
      var nameMatch = /\n  m_Name:\s*([^\n\r]*)/.exec(block.text);
      var name = nameMatch ? nameMatch[1].trim() : '';
      if (name) goByName[name] = block.id;
      var ids = [];
      block.text.replace(/component:\s*\{fileID:\s*(-?\d+)\}/g, function(_, id) {
        ids.push(id);
        return _;
      });
      goComponents[block.id] = ids;
    } else {
      var goMatch = /\n  m_GameObject:\s*\{fileID:\s*(-?\d+)\}/.exec(block.text);
      if (goMatch) {
        componentGo[block.id] = goMatch[1];
        if (block.type === '4' || block.type === '224') transformGo[block.id] = goMatch[1];
      }
      if (block.type === '4' || block.type === '224') {
        var fatherMatch = /\n  m_Father:\s*\{fileID:\s*(-?\d+)\}/.exec(block.text);
        if (fatherMatch) fatherByTransform[block.id] = fatherMatch[1];
      }
    }
  });
  return {
    byId: byId,
    goByName: goByName,
    goComponents: goComponents,
    componentGo: componentGo,
    transformGo: transformGo,
    fatherByTransform: fatherByTransform
  };
}

function stripRemovedReferenceLines(text, removedIds) {
  return String(text || '').split('\n').filter(function(line) {
    var match = /^\s*-\s*(?:component:\s*)?\{fileID:\s*(-?\d+)\}/.exec(line);
    return !(match && removedIds[match[1]]);
  }).join('\n');
}

function stripUnusedSceneModels(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return { removedGameObjects: 0, removedBlocks: 0 };
  var doc = splitUnityYaml(fs.readFileSync(sceneFile, 'utf8'));
  var idx = sceneIndex(doc);
  var removeGo = Object.create(null);
  Object.keys(idx.goByName).forEach(function(name) {
    if (/^UnusedSceneModel_/.test(name)) removeGo[idx.goByName[name]] = true;
  });

  var changed = true;
  while (changed) {
    changed = false;
    var removedTransforms = Object.create(null);
    Object.keys(idx.transformGo).forEach(function(transformId) {
      if (removeGo[idx.transformGo[transformId]]) removedTransforms[transformId] = true;
    });
    Object.keys(idx.fatherByTransform).forEach(function(transformId) {
      if (!removedTransforms[idx.fatherByTransform[transformId]]) return;
      var childGo = idx.transformGo[transformId];
      if (childGo && !removeGo[childGo]) {
        removeGo[childGo] = true;
        changed = true;
      }
    });
  }

  var removeIds = Object.create(null);
  Object.keys(removeGo).forEach(function(goId) {
    removeIds[goId] = true;
    (idx.goComponents[goId] || []).forEach(function(componentId) {
      removeIds[componentId] = true;
    });
  });
  Object.keys(idx.componentGo).forEach(function(componentId) {
    if (removeGo[idx.componentGo[componentId]]) removeIds[componentId] = true;
  });

  var before = doc.blocks.length;
  doc.blocks = doc.blocks.filter(function(block) {
    return !removeIds[block.id];
  }).map(function(block) {
    if (block.type !== '1' && block.type !== '4' && block.type !== '224') return block;
    return {
      type: block.type,
      id: block.id,
      text: stripRemovedReferenceLines(block.text, removeIds)
    };
  });
  var removedBlocks = before - doc.blocks.length;
  if (removedBlocks) fs.writeFileSync(sceneFile, joinUnityYaml(doc));
  return { removedGameObjects: Object.keys(removeGo).length, removedBlocks: removedBlocks };
}

function removeSceneMonoBehavioursByScriptGuid(root, scriptGuids) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return { removed: 0 };
  var guidSet = Object.create(null);
  (scriptGuids || []).forEach(function(guid) {
    if (guid) guidSet[String(guid).toLowerCase()] = true;
  });
  if (!Object.keys(guidSet).length) return { removed: 0 };
  var doc = splitUnityYaml(fs.readFileSync(sceneFile, 'utf8'));
  var removeIds = Object.create(null);
  (doc.blocks || []).forEach(function(block) {
    if (block.type !== '114') return;
    var match = /m_Script:\s*\{fileID:\s*11500000,\s*guid:\s*([0-9a-fA-F]+),\s*type:\s*3\}/.exec(block.text);
    if (match && guidSet[match[1].toLowerCase()]) removeIds[block.id] = true;
  });
  var removed = Object.keys(removeIds).length;
  if (!removed) return { removed: 0 };
  doc.blocks = doc.blocks.filter(function(block) {
    return !removeIds[block.id];
  }).map(function(block) {
    if (block.type !== '1') return block;
    return {
      type: block.type,
      id: block.id,
      text: stripRemovedReferenceLines(block.text, removeIds)
    };
  });
  fs.writeFileSync(sceneFile, joinUnityYaml(doc));
  return { removed: removed };
}

function repairLegacySceneScriptReferences(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return { scriptActivatorRemapped: 0, placeholderScriptsRemoved: 0 };
  var oldActivatorGuid = 'c91b2d4d49b7caa428b32e2e342d0a17';
  var placeholderGuid = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  var text = fs.readFileSync(sceneFile, 'utf8');
  var remapped = 0;
  var activatorFile = findScriptByClass(root, 'GMP_ScriptActivator');
  var activatorGuid = activatorFile ? readUnityMetaGuid(activatorFile) : '';
  if (activatorGuid && activatorGuid !== oldActivatorGuid && text.indexOf(oldActivatorGuid) >= 0) {
    var re = new RegExp(oldActivatorGuid, 'g');
    text = text.replace(re, function() {
      remapped++;
      return activatorGuid;
    });
    fs.writeFileSync(sceneFile, text);
  }
  var removed = removeSceneMonoBehavioursByScriptGuid(root, [placeholderGuid]);
  return {
    scriptActivatorRemapped: remapped,
    placeholderScriptsRemoved: removed.removed || 0
  };
}

function repairKnownPackageSceneScriptReferences(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return { remapped: 0 };
  var mappings = {
    // Some Luna base templates carry stale UGUI GUIDs. Keep the components, but
    // remap them to the Unity 2022.3 package GUIDs so play-mode does not report
    // "The referenced script (Unknown)" on first import.
    dc42784cf5571cd4e96f405ef68ec111: 'dc42784cf147c0c48a680349fa168899', // GraphicRaycaster
    '76c392e42b5d8814fa735d0bde908bd4': '76c392e42b5098c458856cdf6ecaaaa1' // EventSystem
  };
  var text = fs.readFileSync(sceneFile, 'utf8');
  var remapped = 0;
  Object.keys(mappings).forEach(function(oldGuid) {
    if (text.indexOf(oldGuid) < 0) return;
    var re = new RegExp(oldGuid, 'g');
    text = text.replace(re, function() {
      remapped++;
      return mappings[oldGuid];
    });
  });
  if (remapped) fs.writeFileSync(sceneFile, text);
  return { remapped: remapped };
}

function readUnityYamlList(file, key) {
  if (!fs.existsSync(file)) return [];
  var text = fs.readFileSync(file, 'utf8');
  var re = new RegExp('(?:^|\\n)  ' + escapeRegExp(key) + ':(?: \\[\\])?\\n((?:  - [^\\n\\r]+\\n?)*)');
  var match = re.exec(text);
  if (!match || !match[1]) return [];
  return match[1].split(/\r?\n/).map(function(line) {
    var item = /^\s*-\s*(.+?)\s*$/.exec(line);
    return item ? item[1].trim().replace(/^"|"$/g, '') : '';
  }).filter(Boolean);
}

function readPhaseSpawnEntities(root, index) {
  var file = path.join(phaseAssetDir(root), 'Phase' + (index || 1) + '.asset');
  return readUnityYamlList(file, 'mSpawnEntities').concat(readUnityYamlList(file, 'spawnEntities')).filter(function(value, idx, list) {
    return list.indexOf(value) === idx;
  });
}

function positionForUnityEntity(visualHints, unityName) {
  var positions = visualHints && visualHints.positions ? visualHints.positions : {};
  var canonical = canonicalEntityName(unityName);
  var direct = positions[canonical] || positions[unityName] || positions[unityEntityName(canonical)];
  var parsed = parseVector3(direct);
  return parsed || null;
}

function replaceTransformLocalPosition(blockText, position) {
  var line = '  m_LocalPosition: {x: ' + Number(position.x).toFixed(3).replace(/\.?0+$/g, '') +
    ', y: ' + Number(position.y || 0).toFixed(3).replace(/\.?0+$/g, '') +
    ', z: ' + Number(position.z).toFixed(3).replace(/\.?0+$/g, '') + '}';
  if (/  m_LocalPosition:\s*\{[^\n\r]+\}/.test(blockText)) {
    return blockText.replace(/  m_LocalPosition:\s*\{[^\n\r]+\}/, line);
  }
  return blockText.replace(/(\n  m_LocalRotation:\s*\{[^\n\r]+\})/, '$1\n' + line);
}

function unityNumber(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(3).replace(/\.?0+$/g, '') || '0';
}

function replaceTransformLocalRotation(blockText, rotation, euler) {
  var line = '  m_LocalRotation: {x: ' + unityNumber(rotation.x) +
    ', y: ' + unityNumber(rotation.y) +
    ', z: ' + unityNumber(rotation.z) +
    ', w: ' + unityNumber(rotation.w) + '}';
  var next = /  m_LocalRotation:\s*\{[^\n\r]+\}/.test(blockText)
    ? blockText.replace(/  m_LocalRotation:\s*\{[^\n\r]+\}/, line)
    : blockText.replace(/(\n  serializedVersion:\s*2)/, '$1\n' + line);
  var eulerLine = '  m_LocalEulerAnglesHint: {x: ' + unityNumber(euler.x) +
    ', y: ' + unityNumber(euler.y) +
    ', z: ' + unityNumber(euler.z) + '}';
  if (/  m_LocalEulerAnglesHint:\s*\{[^\n\r]+\}/.test(next)) {
    return next.replace(/  m_LocalEulerAnglesHint:\s*\{[^\n\r]+\}/, eulerLine);
  }
  return next.replace(/(\n  m_Father:\s*\{fileID:\s*-?\d+\})/, '$1\n' + eulerLine);
}

function replaceTransformLocalScale(blockText, scale) {
  var line = '  m_LocalScale: {x: ' + unityNumber(scale.x == null ? 1 : scale.x) +
    ', y: ' + unityNumber(scale.y == null ? 1 : scale.y) +
    ', z: ' + unityNumber(scale.z == null ? 1 : scale.z) + '}';
  if (/  m_LocalScale:\s*\{[^\n\r]+\}/.test(blockText)) {
    return blockText.replace(/  m_LocalScale:\s*\{[^\n\r]+\}/, line);
  }
  return blockText.replace(/(\n  m_LocalPosition:\s*\{[^\n\r]+\})/, '$1\n' + line);
}

function vectorFromArray(value, fallback) {
  fallback = fallback || { x: 0, y: 0, z: 0 };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      x: Number.isFinite(Number(value.x)) ? Number(value.x) : fallback.x,
      y: Number.isFinite(Number(value.y)) ? Number(value.y) : fallback.y,
      z: Number.isFinite(Number(value.z)) ? Number(value.z) : fallback.z
    };
  }
  if (!Array.isArray(value)) return fallback;
  return {
    x: Number.isFinite(Number(value[0])) ? Number(value[0]) : fallback.x,
    y: Number.isFinite(Number(value[1])) ? Number(value[1]) : fallback.y,
    z: Number.isFinite(Number(value[2])) ? Number(value[2]) : fallback.z
  };
}

function eulerRadiansToQuaternion(euler) {
  var x = Number(euler.x || 0);
  var y = Number(euler.y || 0);
  var z = Number(euler.z || 0);
  var c1 = Math.cos(x / 2);
  var c2 = Math.cos(y / 2);
  var c3 = Math.cos(z / 2);
  var s1 = Math.sin(x / 2);
  var s2 = Math.sin(y / 2);
  var s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3
  };
}

function appendChildToTransformBlock(blockText, childTransformId) {
  if (!childTransformId || new RegExp('\\{fileID:\\s*' + escapeRegExp(childTransformId) + '\\}').test(blockText)) return blockText;
  if (/  m_Children:\s*\[\]/.test(blockText)) {
    return blockText.replace(/  m_Children:\s*\[\]/, '  m_Children:\n  - {fileID: ' + childTransformId + '}');
  }
  if (/  m_Children:\n/.test(blockText)) {
    return blockText.replace(/(  m_Children:\n)/, '$1  - {fileID: ' + childTransformId + '}\n');
  }
  return blockText.replace(/(\n  m_LocalScale:\s*\{[^\n\r]+\})/, '$1\n  m_Children:\n  - {fileID: ' + childTransformId + '}');
}

function primitiveMeshId(geometryType) {
  if (/Sphere|Octahedron|Dodecahedron/i.test(geometryType || '')) return '10207';
  if (/Cylinder|Cone|Torus/i.test(geometryType || '')) return '10206';
  if (/Plane|Circle/i.test(geometryType || '')) return '10209';
  return '10202';
}

function geometryLocalScale(geometry, transformScale) {
  geometry = geometry || {};
  var args = Array.isArray(geometry.args) ? geometry.args.map(Number) : [];
  var type = String(geometry.type || '');
  var scale = { x: 1, y: 1, z: 1 };
  if (/Box/i.test(type)) {
    scale = { x: Number(args[0]) || 1, y: Number(args[1]) || 1, z: Number(args[2]) || 1 };
  } else if (/Sphere|Octahedron|Dodecahedron/i.test(type)) {
    var radius = Number(args[0]) || 0.5;
    scale = { x: radius * 2, y: radius * 2, z: radius * 2 };
  } else if (/Cone/i.test(type)) {
    var coneRadius = Number(args[0]) || 0.5;
    var coneHeight = Number(args[1]) || 1;
    scale = { x: coneRadius * 2, y: coneHeight / 2, z: coneRadius * 2 };
  } else if (/Cylinder/i.test(type)) {
    var r = Math.max(Number(args[0]) || 0.5, Number(args[1]) || 0.5);
    var h = Number(args[2]) || 1;
    scale = { x: r * 2, y: h / 2, z: r * 2 };
  } else if (/Torus/i.test(type)) {
    var outer = (Number(args[0]) || 1) + (Number(args[1]) || 0.05);
    scale = { x: outer * 2, y: Math.max(0.02, Number(args[1]) || 0.05), z: outer * 2 };
  } else if (/Plane/i.test(type)) {
    scale = { x: Number(args[0]) || 1, y: 1, z: Number(args[1]) || Number(args[0]) || 1 };
  }
  transformScale = vectorFromArray(transformScale, { x: 1, y: 1, z: 1 });
  return {
    x: scale.x * transformScale.x,
    y: scale.y * transformScale.y,
    z: scale.z * transformScale.z
  };
}

function ensureGeneratedMaterial(root, seed, displayName, color, options) {
  var shaderGuid = readUnityMetaGuid(path.join(root, 'Assets', 'Shader', 'SimpleLit.shader')) ||
    readUnityMetaGuid(path.join(root, 'Assets', 'Shaders', 'NavPathArrowAplha.shader'));
  if (!shaderGuid) return '';
  var guid = crypto.createHash('sha1').update('programmer-delivery-material:' + seed).digest('hex').slice(0, 32);
  var dir = path.join(root, 'Assets', 'Materials', 'Generated');
  fs.mkdirSync(dir, { recursive: true });
  var file = path.join(dir, displayName + '.mat');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, materialYaml(displayName, shaderGuid, color, options));
    writeNativeAssetMetaWithGuid(file, guid, 2100000);
  } else if (!fs.existsSync(file + '.meta')) {
    writeNativeAssetMetaWithGuid(file, guid, 2100000);
  }
  return guid;
}

function buildPrimitiveBuilderCode() {
  return [
    'using System.Collections.Generic;',
    'using UnityEngine;',
    '',
    'public static class GMP_PrimitiveBuilder',
    '{',
    '    // 按 Three.js 几何类型生成 Unity Mesh。',
    '    public static Mesh Build(string geometryType, float[] args)',
    '    {',
    '        string type = geometryType ?? string.Empty;',
    '        if (type.Contains("Sphere") || type.Contains("Octahedron") || type.Contains("Dodecahedron")) return BuildSphere(Get(args, 0, 0.5f), Mathf.RoundToInt(Get(args, 1, 16f)), Mathf.RoundToInt(Get(args, 2, 12f)));',
    '        if (type.Contains("Cylinder")) return BuildCylinder(Get(args, 0, 0.5f), Get(args, 1, 0.5f), Get(args, 2, 1f), Mathf.RoundToInt(Get(args, 3, 16f)));',
    '        if (type.Contains("Cone")) return BuildCylinder(0f, Get(args, 0, 0.5f), Get(args, 1, 1f), Mathf.RoundToInt(Get(args, 2, 16f)));',
    '        if (type.Contains("Torus")) return BuildTorus(Get(args, 0, 1f), Get(args, 1, 0.08f), Mathf.RoundToInt(Get(args, 2, 12f)), Mathf.RoundToInt(Get(args, 3, 32f)));',
    '        if (type.Contains("Plane")) return BuildPlane(Get(args, 0, 1f), Get(args, 1, 1f));',
    '        return BuildBox(Get(args, 0, 1f), Get(args, 1, 1f), Get(args, 2, 1f));',
    '    }',
    '',
    '    // 安全读取几何参数，缺失时使用默认值。',
    '    private static float Get(float[] args, int index, float fallback)',
    '    {',
    '        return args != null && index >= 0 && index < args.Length ? args[index] : fallback;',
    '    }',
    '',
    '    // 写入顶点和三角面后统一刷新法线与包围盒。',
    '    private static Mesh FinalizeMesh(string name, List<Vector3> vertices, List<int> triangles)',
    '    {',
    '        Mesh mesh = new Mesh();',
    '        mesh.name = name;',
    '        mesh.SetVertices(vertices);',
    '        mesh.SetTriangles(triangles, 0);',
    '        mesh.RecalculateNormals();',
    '        mesh.RecalculateBounds();',
    '        return mesh;',
    '    }',
    '',
    '    // 构建立方体/长方体网格。',
    '    private static Mesh BuildBox(float width, float height, float depth)',
    '    {',
    '        float x = width * 0.5f, y = height * 0.5f, z = depth * 0.5f;',
    '        List<Vector3> v = new List<Vector3> {',
    '            new Vector3(-x,-y,-z), new Vector3(x,-y,-z), new Vector3(x,y,-z), new Vector3(-x,y,-z),',
    '            new Vector3(-x,-y,z), new Vector3(x,-y,z), new Vector3(x,y,z), new Vector3(-x,y,z)',
    '        };',
    '        List<int> t = new List<int> { 0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5 };',
    '        return FinalizeMesh("GMP_Box", v, t);',
    '    }',
    '',
    '    // 构建水平平面网格。',
    '    private static Mesh BuildPlane(float width, float depth)',
    '    {',
    '        float x = width * 0.5f, z = depth * 0.5f;',
    '        List<Vector3> v = new List<Vector3> { new Vector3(-x,0,-z), new Vector3(x,0,-z), new Vector3(x,0,z), new Vector3(-x,0,z) };',
    '        List<int> t = new List<int> { 0,2,1,0,3,2 };',
    '        return FinalizeMesh("GMP_Plane", v, t);',
    '    }',
    '',
    '    // 构建 UV sphere 网格。',
    '    private static Mesh BuildSphere(float radius, int segments, int rings)',
    '    {',
    '        segments = Mathf.Max(8, segments);',
    '        rings = Mathf.Max(6, rings);',
    '        List<Vector3> v = new List<Vector3>();',
    '        List<int> t = new List<int>();',
    '        for (int y = 0; y <= rings; y++)',
    '        {',
    '            float vy = (float)y / rings;',
    '            float phi = vy * Mathf.PI;',
    '            for (int x = 0; x <= segments; x++)',
    '            {',
    '                float vx = (float)x / segments;',
    '                float theta = vx * Mathf.PI * 2f;',
    '                v.Add(new Vector3(Mathf.Sin(phi) * Mathf.Cos(theta), Mathf.Cos(phi), Mathf.Sin(phi) * Mathf.Sin(theta)) * radius);',
    '            }',
    '        }',
    '        for (int y = 0; y < rings; y++)',
    '        {',
    '            for (int x = 0; x < segments; x++)',
    '            {',
    '                int a = y * (segments + 1) + x;',
    '                int b = a + segments + 1;',
    '                t.Add(a); t.Add(b); t.Add(a + 1);',
    '                t.Add(a + 1); t.Add(b); t.Add(b + 1);',
    '            }',
    '        }',
    '        return FinalizeMesh("GMP_Sphere", v, t);',
    '    }',
    '',
    '    // 构建圆柱/圆台网格，topRadius 为 0 时可表达圆锥。',
    '    private static Mesh BuildCylinder(float topRadius, float bottomRadius, float height, int segments)',
    '    {',
    '        segments = Mathf.Max(6, segments);',
    '        List<Vector3> v = new List<Vector3>();',
    '        List<int> t = new List<int>();',
    '        float half = height * 0.5f;',
    '        for (int i = 0; i < segments; i++)',
    '        {',
    '            float a = i * Mathf.PI * 2f / segments;',
    '            float ca = Mathf.Cos(a), sa = Mathf.Sin(a);',
    '            v.Add(new Vector3(ca * bottomRadius, -half, sa * bottomRadius));',
    '            v.Add(new Vector3(ca * topRadius, half, sa * topRadius));',
    '        }',
    '        int bottomCenter = v.Count; v.Add(new Vector3(0, -half, 0));',
    '        int topCenter = v.Count; v.Add(new Vector3(0, half, 0));',
    '        for (int i = 0; i < segments; i++)',
    '        {',
    '            int n = (i + 1) % segments;',
    '            int b0 = i * 2, t0 = b0 + 1, b1 = n * 2, t1 = b1 + 1;',
    '            t.Add(b0); t.Add(t0); t.Add(b1);',
    '            t.Add(b1); t.Add(t0); t.Add(t1);',
    '            if (bottomRadius > 0.001f) { t.Add(bottomCenter); t.Add(b1); t.Add(b0); }',
    '            if (topRadius > 0.001f) { t.Add(topCenter); t.Add(t0); t.Add(t1); }',
    '        }',
    '        return FinalizeMesh("GMP_Cylinder", v, t);',
    '    }',
    '',
    '    // 构建环面网格，用于目标圈和轨道环。',
    '    private static Mesh BuildTorus(float radius, float tubeRadius, int radialSegments, int tubularSegments)',
    '    {',
    '        radialSegments = Mathf.Max(6, radialSegments);',
    '        tubularSegments = Mathf.Max(12, tubularSegments);',
    '        List<Vector3> v = new List<Vector3>();',
    '        List<int> t = new List<int>();',
    '        for (int j = 0; j <= radialSegments; j++)',
    '        {',
    '            float vAngle = j * Mathf.PI * 2f / radialSegments;',
    '            for (int i = 0; i <= tubularSegments; i++)',
    '            {',
    '                float u = i * Mathf.PI * 2f / tubularSegments;',
    '                float x = (radius + tubeRadius * Mathf.Cos(vAngle)) * Mathf.Cos(u);',
    '                float y = tubeRadius * Mathf.Sin(vAngle);',
    '                float z = (radius + tubeRadius * Mathf.Cos(vAngle)) * Mathf.Sin(u);',
    '                v.Add(new Vector3(x, y, z));',
    '            }',
    '        }',
    '        for (int j = 0; j < radialSegments; j++)',
    '        {',
    '            for (int i = 0; i < tubularSegments; i++)',
    '            {',
    '                int a = j * (tubularSegments + 1) + i;',
    '                int b = (j + 1) * (tubularSegments + 1) + i;',
    '                t.Add(a); t.Add(b); t.Add(a + 1);',
    '                t.Add(a + 1); t.Add(b); t.Add(b + 1);',
    '            }',
    '        }',
    '        return FinalizeMesh("GMP_Torus", v, t);',
    '    }',
    '}',
    ''
  ].join('\n');
}

function buildPrimitiveSpecCode() {
  return [
    'using UnityEngine;',
    '',
    '[RequireComponent(typeof(MeshFilter))]',
    '[RequireComponent(typeof(MeshRenderer))]',
    'public class GMP_PrimitiveSpec : MonoBehaviour',
    '{',
    '    public string mGeometryType = "BoxGeometry";',
    '    public float[] mArgs = new float[0];',
    '',
    '    // 运行时启动后根据合同参数生成真实 Mesh。',
    '    private void Awake()',
    '    {',
    '        Rebuild();',
    '    }',
    '',
    '#if UNITY_EDITOR',
    '    // Inspector 或场景反序列化后延迟重建，避开 Unity CheckConsistency 阶段。',
    '    private void OnValidate()',
    '    {',
    '        if (Application.isPlaying) return;',
    '        UnityEditor.EditorApplication.delayCall -= RebuildAfterValidate;',
    '        UnityEditor.EditorApplication.delayCall += RebuildAfterValidate;',
    '    }',
    '',
    '    // Unity 不允许 OnValidate 里直接改 MeshFilter，这里等编辑器空闲后再刷新。',
    '    private void RebuildAfterValidate()',
    '    {',
    '        UnityEditor.EditorApplication.delayCall -= RebuildAfterValidate;',
    '        if (this == null || gameObject == null) return;',
    '        Rebuild();',
    '    }',
    '#endif',
    '',
    '    // 统一入口：按几何类型和参数刷新 MeshFilter.sharedMesh。',
    '    public void Rebuild()',
    '    {',
    '        MeshFilter filter = GetComponent<MeshFilter>();',
    '        if (filter == null) return;',
    '        filter.sharedMesh = GMP_PrimitiveBuilder.Build(mGeometryType, mArgs);',
    '    }',
    '}',
    ''
  ].join('\n');
}

function ensurePrimitiveBuilderScripts(root) {
  var dir = path.join(root, 'Assets', 'Scripts', 'Tool');
  writeGeneratedCs(path.join(dir, 'GMP_PrimitiveBuilder.cs'), buildPrimitiveBuilderCode());
  writeGeneratedCs(path.join(dir, 'GMP_PrimitiveSpec.cs'), buildPrimitiveSpecCode());
  return {
    builderGuid: readUnityMetaGuid(path.join(dir, 'GMP_PrimitiveBuilder.cs')),
    specGuid: readUnityMetaGuid(path.join(dir, 'GMP_PrimitiveSpec.cs')),
    written: 2
  };
}

function meshRendererYaml(id, goId, materialGuid) {
  return [
    '--- !u!23 &' + id,
    'MeshRenderer:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_Enabled: 1',
    '  m_CastShadows: 1',
    '  m_ReceiveShadows: 1',
    '  m_DynamicOccludee: 1',
    '  m_StaticShadowCaster: 0',
    '  m_MotionVectors: 1',
    '  m_LightProbeUsage: 1',
    '  m_ReflectionProbeUsage: 1',
    '  m_RayTracingMode: 2',
    '  m_RayTraceProcedural: 0',
    '  m_RenderingLayerMask: 1',
    '  m_RendererPriority: 0',
    '  m_Materials:',
    '  - {fileID: 2100000, guid: ' + materialGuid + ', type: 2}',
    '  m_StaticBatchInfo:',
    '    firstSubMesh: 0',
    '    subMeshCount: 0',
    '  m_StaticBatchRoot: {fileID: 0}',
    '  m_ProbeAnchor: {fileID: 0}',
    '  m_LightProbeVolumeOverride: {fileID: 0}',
    '  m_ScaleInLightmap: 1',
    '  m_ReceiveGI: 1',
    '  m_PreserveUVs: 1',
    '  m_IgnoreNormalsForChartDetection: 0',
    '  m_ImportantGI: 0',
    '  m_StitchLightmapSeams: 1',
    '  m_SelectedEditorRenderState: 3',
    '  m_MinimumChartSize: 4',
    '  m_AutoUVMaxDistance: 0.5',
    '  m_AutoUVMaxAngle: 89',
    '  m_LightmapParameters: {fileID: 0}',
    '  m_SortingLayerID: 0',
    '  m_SortingLayer: 0',
    '  m_SortingOrder: 0',
    '  m_AdditionalVertexStreams: {fileID: 0}',
    ''
  ].join('\n');
}

function meshFilterYaml(id, goId, meshId) {
  return [
    '--- !u!33 &' + id,
    'MeshFilter:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    meshId ? '  m_Mesh: {fileID: ' + meshId + ', guid: 0000000000000000e000000000000000, type: 0}' : '  m_Mesh: {fileID: 0}',
    ''
  ].join('\n');
}

function primitiveSpecMonoBehaviourYaml(id, goId, specGuid, geometryType, args) {
  var lines = [
    '--- !u!114 &' + id,
    'MonoBehaviour:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_Enabled: 1',
    '  m_EditorHideFlags: 0',
    '  m_Script: {fileID: 11500000, guid: ' + specGuid + ', type: 3}',
    '  m_Name: ',
    '  m_EditorClassIdentifier: ',
    '  mGeometryType: ' + yamlQuotedString(geometryType || 'BoxGeometry'),
    '  mArgs:'
  ];
  args = Array.isArray(args) ? args : [];
  if (!args.length) lines[lines.length - 1] += ' []';
  else args.forEach(function(value) { lines.push('  - ' + unityNumber(value)); });
  lines.push('');
  return lines.join('\n');
}

function meshPrimitiveGameObjectYaml(name, ids, parentTransformId, localPos, localEulerRadians, localScale, meshId, materialGuid, specGuid, geometryType, args, active) {
  var q = eulerRadiansToQuaternion(localEulerRadians || { x: 0, y: 0, z: 0 });
  var eulerHint = {
    x: (Number(localEulerRadians.x || 0) * 180 / Math.PI),
    y: (Number(localEulerRadians.y || 0) * 180 / Math.PI),
    z: (Number(localEulerRadians.z || 0) * 180 / Math.PI)
  };
  return [
    '--- !u!1 &' + ids.go,
    'GameObject:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  serializedVersion: 6',
    '  m_Component:',
    '  - component: {fileID: ' + ids.transform + '}',
    '  - component: {fileID: ' + ids.renderer + '}',
    '  - component: {fileID: ' + ids.filter + '}',
    specGuid ? '  - component: {fileID: ' + ids.spec + '}' : '',
    '  m_Layer: 0',
    '  m_Name: ' + name,
    '  m_TagString: Untagged',
    '  m_Icon: {fileID: 0}',
    '  m_NavMeshLayer: 0',
    '  m_StaticEditorFlags: 0',
    '  m_IsActive: ' + (active === false ? 0 : 1),
    '--- !u!4 &' + ids.transform,
    'Transform:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + ids.go + '}',
    '  serializedVersion: 2',
    '  m_LocalRotation: {x: ' + unityNumber(q.x) + ', y: ' + unityNumber(q.y) + ', z: ' + unityNumber(q.z) + ', w: ' + unityNumber(q.w) + '}',
    '  m_LocalPosition: {x: ' + unityNumber(localPos.x) + ', y: ' + unityNumber(localPos.y) + ', z: ' + unityNumber(localPos.z) + '}',
    '  m_LocalScale: {x: ' + unityNumber(localScale.x) + ', y: ' + unityNumber(localScale.y) + ', z: ' + unityNumber(localScale.z) + '}',
    '  m_ConstrainProportionsScale: 0',
    '  m_Children: []',
    '  m_Father: {fileID: ' + (parentTransformId || 0) + '}',
    '  m_LocalEulerAnglesHint: {x: ' + unityNumber(eulerHint.x) + ', y: ' + unityNumber(eulerHint.y) + ', z: ' + unityNumber(eulerHint.z) + '}',
    meshRendererYaml(ids.renderer, ids.go, materialGuid),
    meshFilterYaml(ids.filter, ids.go, meshId),
    specGuid ? primitiveSpecMonoBehaviourYaml(ids.spec, ids.go, specGuid, geometryType, args) : ''
  ].filter(function(line) { return line !== ''; }).join('\n');
}

function emptySceneGameObjectYaml(name, goId, transformId, parentTransformId, childTransformIds, localPos, active) {
  childTransformIds = childTransformIds || [];
  localPos = localPos || { x: 0, y: 0, z: 0 };
  var children = childTransformIds.length
    ? childTransformIds.map(function(id) { return '  - {fileID: ' + id + '}'; }).join('\n')
    : ' []';
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
    '  m_Layer: 0',
    '  m_Name: ' + name,
    '  m_TagString: Untagged',
    '  m_Icon: {fileID: 0}',
    '  m_NavMeshLayer: 0',
    '  m_StaticEditorFlags: 0',
    '  m_IsActive: ' + (active === false ? 0 : 1),
    '--- !u!4 &' + transformId,
    'Transform:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  serializedVersion: 2',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    '  m_LocalPosition: {x: ' + unityNumber(localPos.x) + ', y: ' + unityNumber(localPos.y) + ', z: ' + unityNumber(localPos.z) + '}',
    '  m_LocalScale: {x: 1, y: 1, z: 1}',
    '  m_ConstrainProportionsScale: 0',
    '  m_Children:' + (children === ' []' ? children : '\n' + children),
    '  m_Father: {fileID: ' + (parentTransformId || 0) + '}',
    '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
    ''
  ].join('\n');
}

function sceneLightGameObjectYaml(name, ids, lightType, color, intensity, range, localPos) {
  localPos = localPos || { x: 0, y: 0, z: 0 };
  color = color || { r: 1, g: 1, b: 1, a: 1 };
  return [
    '--- !u!1 &' + ids.go,
    'GameObject:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  serializedVersion: 6',
    '  m_Component:',
    '  - component: {fileID: ' + ids.transform + '}',
    '  - component: {fileID: ' + ids.light + '}',
    '  m_Layer: 0',
    '  m_Name: ' + name,
    '  m_TagString: Untagged',
    '  m_Icon: {fileID: 0}',
    '  m_NavMeshLayer: 0',
    '  m_StaticEditorFlags: 0',
    '  m_IsActive: 1',
    '--- !u!4 &' + ids.transform,
    'Transform:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + ids.go + '}',
    '  serializedVersion: 2',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    '  m_LocalPosition: {x: ' + unityNumber(localPos.x) + ', y: ' + unityNumber(localPos.y) + ', z: ' + unityNumber(localPos.z) + '}',
    '  m_LocalScale: {x: 1, y: 1, z: 1}',
    '  m_ConstrainProportionsScale: 0',
    '  m_Children: []',
    '  m_Father: {fileID: 0}',
    '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
    '--- !u!108 &' + ids.light,
    'Light:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + ids.go + '}',
    '  m_Enabled: 1',
    '  serializedVersion: 10',
    '  m_Type: ' + (lightType || 2),
    '  m_Shape: 0',
    '  m_Color: ' + colorYaml(color),
    '  m_Intensity: ' + unityNumber(intensity == null ? 1 : intensity),
    '  m_Range: ' + unityNumber(range == null ? 80 : range),
    '  m_SpotAngle: 30',
    '  m_InnerSpotAngle: 21.80208',
    '  m_CookieSize: 10',
    '  m_Shadows:',
    '    m_Type: 0',
    '    m_Resolution: -1',
    '    m_CustomResolution: -1',
    '    m_Strength: 1',
    '    m_Bias: 0.05',
    '    m_NormalBias: 0.4',
    '    m_NearPlane: 0.2',
    '  m_Cookie: {fileID: 0}',
    '  m_DrawHalo: 0',
    '  m_Flare: {fileID: 0}',
    '  m_RenderMode: 0',
    '  m_CullingMask:',
    '    serializedVersion: 2',
    '    m_Bits: 4294967295',
    '  m_RenderingLayerMask: 1',
    '  m_Lightmapping: 4',
    '  m_LightShadowCasterMode: 0',
    '  m_AreaSize: {x: 1, y: 1}',
    '  m_BounceIntensity: 1',
    '  m_ColorTemperature: 6570',
    '  m_UseColorTemperature: 0',
    '  m_BoundingSphereOverride: {x: 0, y: 0, z: 0, w: 0}',
    '  m_UseBoundingSphereOverride: 0',
    '  m_UseViewFrustumForShadowCasterCull: 1',
    '  m_ShadowRadius: 0',
    '  m_ShadowAngle: 0',
    ''
  ].join('\n');
}

function appendYamlBlocks(doc, yamlText) {
  var parsed = splitUnityYaml(String(yamlText || '').replace(/\s+$/g, '') + '\n');
  parsed.blocks.forEach(function(block) { doc.blocks.push(block); });
}

function findTransformComponentId(idx, goId) {
  var ids = idx.goComponents[goId] || [];
  for (var i = 0; i < ids.length; i++) {
    var block = idx.byId[ids[i]];
    if (block && (block.type === '4' || block.type === '224')) return ids[i];
  }
  return '';
}

function materializeSourceEntityPrimitives(root, visualHints) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  var manifest = visualHints && visualHints.visualAssets;
  var contract = manifest && manifest.sourceEntityContract;
  var composites = contract && contract.entityComposites;
  if (!fs.existsSync(sceneFile) || !composites) return { entityCount: 0, primitiveCount: 0 };
  var primitiveScripts = ensurePrimitiveBuilderScripts(root);
  var originalScene = fs.readFileSync(sceneFile, 'utf8');
  if (/m_Name:\s*SourcePrimitive_/.test(originalScene)) {
    return { entityCount: 0, primitiveCount: 0, present: true, manifestSource: manifest.__selectedManifestSource || '', primitiveScriptsWritten: primitiveScripts.written || 0 };
  }
  var doc = splitUnityYaml(originalScene);
  var idx = sceneIndex(doc);
  var removeIds = Object.create(null);
  var entityCount = 0;
  var primitiveCount = 0;
  var rendererRootsRemoved = 0;
  Object.keys(composites).sort().forEach(function(entityName) {
    var composite = composites[entityName] || {};
    var goId = idx.goByName[unityEntityName(entityName)] || idx.goByName[entityName];
    var primitives = Array.isArray(composite.primitives) ? composite.primitives : [];
    if (!goId || !primitives.length) return;
    var transformId = findTransformComponentId(idx, goId);
    var transformBlock = transformId ? idx.byId[transformId] : null;
    if (!transformBlock) return;
    var rootPos = parseVector3(composite.position) || positionForUnityEntity(visualHints, entityName);
    if (rootPos) transformBlock.text = replaceTransformLocalPosition(transformBlock.text, rootPos);
    (idx.goComponents[goId] || []).forEach(function(componentId) {
      var block = idx.byId[componentId];
      if (block && (block.type === '23' || block.type === '33')) {
        removeIds[componentId] = true;
        rendererRootsRemoved++;
      }
    });
    entityCount++;
    primitives.forEach(function(primitive, index) {
      var geometry = primitive.geometry || {};
      var localPos = vectorFromArray(primitive.transform && primitive.transform.position, { x: 0, y: 0, z: 0 });
      var localEuler = vectorFromArray(primitive.transform && primitive.transform.rotation, { x: 0, y: 0, z: 0 });
      if (/Torus/i.test(geometry.type || '')) localEuler = { x: 0, y: 0, z: 0 };
      var localScale = geometryLocalScale(geometry, primitive.transform && primitive.transform.scale);
      var color = colorFromValue(primitive.material && primitive.material.diffuseColor) ||
        colorFromStyle(composite, entityName + ':' + index);
      var seed = 'source-primitive:' + entityName + ':' + index + ':' + (primitive.assetId || '');
      var materialName = 'SourcePrimitive_' + sanitizeIdentifier(entityName, 'Entity') + '_' + String(index).padStart(2, '0');
      var materialGuid = ensureGeneratedMaterial(root, seed, materialName, color, null);
      if (!materialGuid) return;
      var ids = {
        go: deterministicSceneFileId(seed + ':go'),
        transform: deterministicSceneFileId(seed + ':transform'),
        renderer: deterministicSceneFileId(seed + ':renderer'),
        filter: deterministicSceneFileId(seed + ':filter'),
        spec: deterministicSceneFileId(seed + ':spec')
      };
      var childName = 'SourcePrimitive_' + sanitizeIdentifier(entityName, 'Entity') + '_' + String(index).padStart(2, '0');
      transformBlock.text = appendChildToTransformBlock(transformBlock.text, ids.transform);
      appendYamlBlocks(doc, meshPrimitiveGameObjectYaml(
        childName,
        ids,
        transformId,
        localPos,
        localEuler,
        vectorFromArray(primitive.transform && primitive.transform.scale, { x: 1, y: 1, z: 1 }),
        '',
        materialGuid,
        primitiveScripts.specGuid,
        geometry.type || 'BoxGeometry',
        Array.isArray(geometry.args) ? geometry.args : [],
        true
      ));
      primitiveCount++;
    });
  });
  doc.blocks = doc.blocks.filter(function(block) {
    return !removeIds[block.id];
  }).map(function(block) {
    if (block.type !== '1') return block;
    return { type: block.type, id: block.id, text: stripRemovedReferenceLines(block.text, removeIds) };
  });
  if (primitiveCount || rendererRootsRemoved) fs.writeFileSync(sceneFile, joinUnityYaml(doc));
  return {
    entityCount: entityCount,
    primitiveCount: primitiveCount,
    rendererRootsRemoved: rendererRootsRemoved,
    manifestSource: manifest.__selectedManifestSource || '',
    primitiveScriptsWritten: primitiveScripts.written || 0
  };
}

function stableUnit(seed) {
  var hash = crypto.createHash('sha1').update(String(seed)).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}

function scenePrimitiveIds(seed) {
  return {
    go: deterministicSceneFileId(seed + ':go'),
    transform: deterministicSceneFileId(seed + ':transform'),
    renderer: deterministicSceneFileId(seed + ':renderer'),
    filter: deterministicSceneFileId(seed + ':filter'),
    spec: deterministicSceneFileId(seed + ':spec')
  };
}

function appendScenePrimitive(root, doc, specGuid, parentTransformId, name, seed, geometryType, args, color, localPos, localEuler, localScale) {
  var materialGuid = ensureGeneratedMaterial(root, seed, sanitizeIdentifier(name, 'ScenePrimitive') + '_Mat', color, null);
  if (!materialGuid) return '';
  var ids = scenePrimitiveIds(seed);
  appendYamlBlocks(doc, meshPrimitiveGameObjectYaml(
    name,
    ids,
    parentTransformId,
    localPos || { x: 0, y: 0, z: 0 },
    localEuler || { x: 0, y: 0, z: 0 },
    localScale || { x: 1, y: 1, z: 1 },
    '',
    materialGuid,
    specGuid,
    geometryType,
    args || [],
    true
  ));
  return ids.transform;
}

function materializeSceneContractObjects(root, visualHints) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  var scene = visualHints && visualHints.scene ? visualHints.scene : {};
  if (!fs.existsSync(sceneFile) || !scene) return { injected: 0, starCount: 0, ringCount: 0 };
  var original = fs.readFileSync(sceneFile, 'utf8');
  if (/m_Name:\s*__StarField\b/.test(original) && /m_Name:\s*__OrbitalRings\b/.test(original)) {
    return { injected: 0, starCount: 0, ringCount: 0, present: true };
  }
  var primitiveScripts = ensurePrimitiveBuilderScripts(root);
  var doc = splitUnityYaml(original);
  var idx = sceneIndex(doc);
  var injected = 0;
  if (!idx.goByName['__AmbientLight']) {
    var ambientGo = deterministicSceneFileId('scene:ambient:go');
    var ambientTr = deterministicSceneFileId('scene:ambient:transform');
    appendYamlBlocks(doc, emptySceneGameObjectYaml('__AmbientLight', ambientGo, ambientTr, 0, [], { x: 0, y: 0, z: 0 }, true));
    injected++;
  }
  if (!idx.goByName['__RimLight']) {
    var rim = scene.rimLight || {};
    appendYamlBlocks(doc, sceneLightGameObjectYaml('__RimLight', {
      go: deterministicSceneFileId('scene:rim:go'),
      transform: deterministicSceneFileId('scene:rim:transform'),
      light: deterministicSceneFileId('scene:rim:light')
    }, 2, rim.color || colorFromValue('#72DDFF'), rim.intensity == null ? 1 : rim.intensity, rim.distance || 80, vectorFromArray(rim.position, { x: 10, y: 16, z: -16 })));
    injected++;
  }

  var starCount = Math.max(0, Number(scene.decor && scene.decor.stars || 0) || 0);
  if (starCount && !idx.goByName['__StarField']) {
    var starParentGo = deterministicSceneFileId('scene:starfield:go');
    var starParentTr = deterministicSceneFileId('scene:starfield:transform');
    var starChildTransforms = [];
    for (var s = 0; s < starCount; s++) {
      var a = stableUnit('star:a:' + s) * Math.PI * 2;
      var r = 28 + stableUnit('star:r:' + s) * 38;
      var y = 9 + stableUnit('star:y:' + s) * 18;
      var size = 0.05 + stableUnit('star:size:' + s) * 0.05;
      var transformId = appendScenePrimitive(root, doc, primitiveScripts.specGuid, starParentTr,
        'SourcePrimitive_Star_' + String(s).padStart(3, '0'),
        'scene:star:' + s,
        'SphereGeometry',
        [size, 8, 6],
        colorFromValue('#FFFFFF'),
        { x: Math.cos(a) * r, y: y, z: Math.sin(a) * r },
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 1, z: 1 }
      );
      if (transformId) starChildTransforms.push(transformId);
    }
    appendYamlBlocks(doc, emptySceneGameObjectYaml('__StarField', starParentGo, starParentTr, 0, starChildTransforms, { x: 0, y: 0, z: 0 }, true));
    injected += 1 + starChildTransforms.length;
  }

  var ringCount = Math.max(0, Number(scene.decor && scene.decor.orbitalRings || 0) || 0);
  if (ringCount && !idx.goByName['__OrbitalRings']) {
    var ringParentGo = deterministicSceneFileId('scene:rings:go');
    var ringParentTr = deterministicSceneFileId('scene:rings:transform');
    var ringChildTransforms = [];
    for (var i = 0; i < ringCount; i++) {
      var radius = 10 + i * 8;
      var ringTransform = appendScenePrimitive(root, doc, primitiveScripts.specGuid, ringParentTr,
        'SourcePrimitive_OrbitalRing_' + String(i + 1).padStart(2, '0'),
        'scene:ring:' + i,
        'TorusGeometry',
        [radius, 0.035, 8, 96],
        colorFromValue(i % 2 ? '#2B83FF' : '#8DEAFF'),
        { x: 24 + i * 8, y: 0.12 + i * 0.03, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 1, z: 1 }
      );
      if (ringTransform) ringChildTransforms.push(ringTransform);
    }
    appendYamlBlocks(doc, emptySceneGameObjectYaml('__OrbitalRings', ringParentGo, ringParentTr, 0, ringChildTransforms, { x: 0, y: 0, z: 0 }, true));
    injected += 1 + ringChildTransforms.length;
  }

  if (scene.guidance && scene.guidance.present !== false) {
    var playerPos = positionForUnityEntity(visualHints, 'Player') || { x: -8, y: 0, z: 2 };
    var shipPos = positionForUnityEntity(visualHints, 'SpaceShip') || { x: -10, y: 0, z: 4 };
    [
      { name: '__TargetRing', seed: 'scene:target-ring', type: 'TorusGeometry', args: [1.5, 0.055, 8, 64], color: '#FFE45C', pos: { x: playerPos.x, y: 0.08, z: playerPos.z } },
      { name: '__TrailLine', seed: 'scene:trail-line', type: 'BoxGeometry', args: [0.08, 0.08, Math.max(2, Math.hypot(shipPos.x - playerPos.x, shipPos.z - playerPos.z))], color: '#8DEAFF', pos: { x: (playerPos.x + shipPos.x) / 2, y: 1, z: (playerPos.z + shipPos.z) / 2 } },
      { name: '__LaserLine', seed: 'scene:laser-line', type: 'BoxGeometry', args: [0.1, 0.1, 8], color: '#FF6858', pos: { x: 24, y: 1.1, z: 1 } }
    ].forEach(function(item) {
      if (idx.goByName[item.name]) return;
      var parentGo = deterministicSceneFileId(item.seed + ':parent:go');
      var parentTr = deterministicSceneFileId(item.seed + ':parent:transform');
      var childTr = appendScenePrimitive(root, doc, primitiveScripts.specGuid, parentTr, 'SourcePrimitive_' + item.name.replace(/^__/, ''), item.seed + ':primitive', item.type, item.args, colorFromValue(item.color), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
      appendYamlBlocks(doc, emptySceneGameObjectYaml(item.name, parentGo, parentTr, 0, childTr ? [childTr] : [], item.pos, true));
      injected += childTr ? 2 : 1;
    });
  }

  if (injected) fs.writeFileSync(sceneFile, joinUnityYaml(doc));
  return { injected: injected, starCount: starCount, ringCount: ringCount, primitiveScriptsWritten: primitiveScripts.written || 0 };
}

function frameInitialPhaseCameraInScene(doc, idx, visualHints, phaseEntities) {
  var playerPos = positionForUnityEntity(visualHints, 'Player');
  var positions = [];
  phaseEntities.forEach(function(entityName) {
    var pos = positionForUnityEntity(visualHints, entityName);
    if (pos) positions.push(pos);
  });
  if (!playerPos && positions.length) playerPos = positions[0];
  if (!playerPos) return false;

  // storyboard2html source camera: player + (4,0,2), camera offset (10,18,24).
  var target = { x: playerPos.x + 4, y: playerPos.y || 0, z: playerPos.z + 2 };
  var cameraPos = { x: target.x + 10, y: target.y + 18, z: target.z + 24 };
  var direction = {
    x: target.x - cameraPos.x,
    y: target.y - cameraPos.y,
    z: target.z - cameraPos.z
  };
  var rotation = lookRotationQuaternion(direction);
  var euler = { x: 37, y: -22, z: 0 };
  var cameraGoId = idx.goByName['Main Camera'];
  if (!cameraGoId) return false;
  var changed = false;
  (idx.goComponents[cameraGoId] || []).forEach(function(componentId) {
    var component = idx.byId[componentId];
    if (!component) return;
    if (component.type === '4' || component.type === '224') {
      var next = replaceTransformLocalPosition(component.text, cameraPos);
      next = replaceTransformLocalRotation(next, rotation, euler);
      if (next !== component.text) {
        component.text = next;
        changed = true;
      }
    } else if (component.type === '20') {
      var cameraText = component.text;
      if (/  field of view:\s*[^\n\r]+/.test(cameraText)) {
        cameraText = cameraText.replace(/  field of view:\s*[^\n\r]+/, '  field of view: 60');
      }
      if (/  far clip plane:\s*[^\n\r]+/.test(cameraText)) {
        cameraText = cameraText.replace(/  far clip plane:\s*[^\n\r]+/, '  far clip plane: 1000');
      }
      if (cameraText !== component.text) {
        component.text = cameraText;
        changed = true;
      }
    }
  });
  return changed;
}

function normalizeVector3(v) {
  var len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function crossVector3(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function lookRotationQuaternion(direction) {
  var forward = normalizeVector3(direction);
  var right = normalizeVector3(crossVector3({ x: 0, y: 1, z: 0 }, forward));
  var up = crossVector3(forward, right);
  var m00 = right.x, m01 = up.x, m02 = forward.x;
  var m10 = right.y, m11 = up.y, m12 = forward.y;
  var m20 = right.z, m21 = up.z, m22 = forward.z;
  var tr = m00 + m11 + m22;
  var q = { x: 0, y: 0, z: 0, w: 1 };
  if (tr > 0) {
    var s = Math.sqrt(tr + 1.0) * 2;
    q.w = 0.25 * s;
    q.x = (m21 - m12) / s;
    q.y = (m02 - m20) / s;
    q.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    var sx = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    q.w = (m21 - m12) / sx;
    q.x = 0.25 * sx;
    q.y = (m01 + m10) / sx;
    q.z = (m02 + m20) / sx;
  } else if (m11 > m22) {
    var sy = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    q.w = (m02 - m20) / sy;
    q.x = (m01 + m10) / sy;
    q.y = 0.25 * sy;
    q.z = (m12 + m21) / sy;
  } else {
    var sz = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
    q.w = (m10 - m01) / sz;
    q.x = (m02 + m20) / sz;
    q.y = (m12 + m21) / sz;
    q.z = 0.25 * sz;
  }
  return q;
}

function materializeInitialPhaseScene(root, visualHints) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return { positioned: 0, missing: 0, phaseEntities: 0, cameraFramed: false };
  var phaseEntities = readPhaseSpawnEntities(root, 1);
  if (!phaseEntities.length) return { positioned: 0, missing: 0, phaseEntities: 0, cameraFramed: false };
  var doc = splitUnityYaml(fs.readFileSync(sceneFile, 'utf8'));
  var idx = sceneIndex(doc);
  var byId = idx.byId;
  var positioned = 0;
  var missing = 0;
  phaseEntities.forEach(function(entityName) {
    var goId = idx.goByName[entityName] || idx.goByName[unityEntityName(entityName)];
    var pos = positionForUnityEntity(visualHints, entityName);
    if (!goId || !pos) {
      missing++;
      return;
    }
    (idx.goComponents[goId] || []).forEach(function(componentId) {
      var component = byId[componentId];
      if (!component || (component.type !== '4' && component.type !== '224')) return;
      component.text = replaceTransformLocalPosition(component.text, pos);
      positioned++;
    });
    var go = byId[goId];
    if (go) go.text = go.text.replace(/  m_IsActive:\s*0\b/, '  m_IsActive: 1');
  });
  var cameraFramed = frameInitialPhaseCameraInScene(doc, idx, visualHints, phaseEntities);
  if (positioned || cameraFramed) fs.writeFileSync(sceneFile, joinUnityYaml(doc));
  return { positioned: positioned, missing: missing, phaseEntities: phaseEntities.length, cameraFramed: cameraFramed };
}

function tagPlayerEntityInScene(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return false;
  var doc = splitUnityYaml(fs.readFileSync(sceneFile, 'utf8'));
  var idx = sceneIndex(doc);
  var playerGoId = idx.goByName['_player'] || idx.goByName['Player'];
  if (!playerGoId || !idx.byId[playerGoId]) return false;
  var block = idx.byId[playerGoId];
  var next = /\n  m_TagString:\s*[^\n\r]*/.test(block.text)
    ? block.text.replace(/\n  m_TagString:\s*[^\n\r]*/, '\n  m_TagString: Player')
    : block.text.replace(/\n  m_Layer:/, '\n  m_TagString: Player\n  m_Layer:');
  if (next === block.text) return false;
  block.text = next;
  fs.writeFileSync(sceneFile, joinUnityYaml(doc));
  return true;
}

function crc32(buffer) {
  var table = crc32.table;
  if (!table) {
    table = [];
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  var crc = 0xffffffff;
  for (var j = 0; j < buffer.length; j++) crc = table[(crc ^ buffer[j]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  var typeBuf = Buffer.from(type, 'ascii');
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function circlePng(size, rgba, ring) {
  size = size || 64;
  rgba = rgba || [255, 255, 255, 200];
  var rows = [];
  var cx = (size - 1) / 2;
  var cy = (size - 1) / 2;
  var radius = size * 0.46;
  var inner = ring ? size * 0.32 : 0;
  for (var y = 0; y < size; y++) {
    var row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (var x = 0; x < size; x++) {
      var dx = x - cx;
      var dy = y - cy;
      var d = Math.sqrt(dx * dx + dy * dy);
      var alpha = d <= radius && d >= inner ? rgba[3] : 0;
      var off = 1 + x * 4;
      row[off] = rgba[0];
      row[off + 1] = rgba[1];
      row[off + 2] = rgba[2];
      row[off + 3] = alpha;
    }
    rows.push(row);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function writeSpriteMetaWithGuid(file, guid) {
  var lines = [
    'fileFormatVersion: 2',
    'guid: ' + guid,
    'TextureImporter:',
    '  internalIDToNameTable: []',
    '  externalObjects: {}',
    '  serializedVersion: 12',
    '  mipmaps:',
    '    mipMapMode: 0',
    '    enableMipMap: 0',
    '    sRGBTexture: 1',
    '    linearTexture: 0',
    '    fadeOut: 0',
    '    borderMipMap: 0',
    '    mipMapsPreserveCoverage: 0',
    '    alphaTestReferenceValue: 0.5',
    '    mipMapFadeDistanceStart: 1',
    '    mipMapFadeDistanceEnd: 3',
    '  bumpmap:',
    '    convertToNormalMap: 0',
    '    externalNormalMap: 0',
    '    heightScale: 0.25',
    '    normalMapFilter: 0',
    '  isReadable: 0',
    '  streamingMipmaps: 0',
    '  vTOnly: 0',
    '  ignoreMipmapLimit: 0',
    '  grayScaleToAlpha: 0',
    '  generateCubemap: 6',
    '  cubemapConvolution: 0',
    '  seamlessCubemap: 0',
    '  textureFormat: 1',
    '  maxTextureSize: 2048',
    '  textureSettings:',
    '    serializedVersion: 2',
    '    filterMode: 1',
    '    aniso: 1',
    '    mipBias: 0',
    '    wrapU: 1',
    '    wrapV: 1',
    '    wrapW: 1',
    '  nPOTScale: 0',
    '  lightmap: 0',
    '  compressionQuality: 50',
    '  spriteMode: 1',
    '  spriteExtrude: 1',
    '  spriteMeshType: 1',
    '  alignment: 0',
    '  spritePivot: {x: 0.5, y: 0.5}',
    '  spritePixelsToUnits: 100',
    '  spriteBorder: {x: 0, y: 0, z: 0, w: 0}',
    '  spriteGenerateFallbackPhysicsShape: 1',
    '  alphaUsage: 1',
    '  alphaIsTransparency: 1',
    '  spriteTessellationDetail: -1',
    '  textureType: 8',
    '  textureShape: 1',
    '  singleChannelComponent: 0',
    '  flipbookRows: 1',
    '  flipbookColumns: 1',
    '  maxTextureSizeSet: 0',
    '  compressionQualitySet: 0',
    '  textureFormatSet: 0',
    '  ignorePngGamma: 0',
    '  applyGammaDecoding: 0',
    '  platformSettings: []',
    '  spriteSheet:',
    '    serializedVersion: 2',
    '    sprites: []',
    '    outline: []',
    '    physicsShape: []',
    '    bones: []',
    '    spriteID: 00000000000000000000000000000000',
    '    internalID: 0',
    '    vertices: []',
    '    indices: ',
    '    edges: []',
    '    weights: []',
    '    secondaryTextures: []',
    '    nameFileIdTable: {}',
    '  userData: ',
    '  assetBundleName: ',
    '  assetBundleVariant: ',
    ''
  ];
  fs.writeFileSync(file + '.meta', lines.join('\n'));
}

function writeJoystickSprite(root, name, rgba, ring) {
  var dir = path.join(root, 'Assets', 'Sprites', 'Generated');
  fs.mkdirSync(dir, { recursive: true });
  var file = path.join(dir, name + '.png');
  var guid = crypto.createHash('sha1').update('programmer-delivery-joystick-sprite:' + name).digest('hex').slice(0, 32);
  fs.writeFileSync(file, circlePng(96, rgba, ring));
  writeSpriteMetaWithGuid(file, guid);
  return guid;
}

function uiImageMonoBehaviourYaml(id, goId, spriteGuid, color) {
  color = color || { r: 1, g: 1, b: 1, a: 1 };
  return [
    '--- !u!114 &' + id,
    'MonoBehaviour:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_Enabled: 1',
    '  m_EditorHideFlags: 0',
    '  m_Script: {fileID: 11500000, guid: fe87c0e1cc204ed48ad3b37840f39efc, type: 3}',
    '  m_Name: ',
    '  m_EditorClassIdentifier: ',
    '  m_Material: {fileID: 0}',
    '  m_Color: {r: ' + color.r + ', g: ' + color.g + ', b: ' + color.b + ', a: ' + color.a + '}',
    '  m_RaycastTarget: 1',
    '  m_RaycastPadding: {x: 0, y: 0, z: 0, w: 0}',
    '  m_Maskable: 1',
    '  m_OnCullStateChanged:',
    '    m_PersistentCalls:',
    '      m_Calls: []',
    '  m_Sprite: {fileID: 21300000, guid: ' + spriteGuid + ', type: 3}',
    '  m_Type: 0',
    '  m_PreserveAspect: 1',
    '  m_FillCenter: 1',
    '  m_FillMethod: 4',
    '  m_FillAmount: 1',
    '  m_FillClockwise: 1',
    '  m_FillOrigin: 0',
    '  m_UseSpriteMesh: 0',
    '  m_PixelsPerUnitMultiplier: 1',
    ''
  ].join('\n');
}

function yamlQuotedString(value) {
  return '"' + String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function uiTextMonoBehaviourYaml(id, goId, text, fontSize) {
  return [
    '--- !u!114 &' + id,
    'MonoBehaviour:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_Enabled: 1',
    '  m_EditorHideFlags: 0',
    '  m_Script: {fileID: 11500000, guid: 5f7201a12d95ffc409449d95f23cf332, type: 3}',
    '  m_Name: ',
    '  m_EditorClassIdentifier: ',
    '  m_Material: {fileID: 0}',
    '  m_Color: {r: 1, g: 1, b: 1, a: 1}',
    '  m_RaycastTarget: 0',
    '  m_RaycastPadding: {x: 0, y: 0, z: 0, w: 0}',
    '  m_Maskable: 1',
    '  m_OnCullStateChanged:',
    '    m_PersistentCalls:',
    '      m_Calls: []',
    '  m_FontData:',
    '    m_Font: {fileID: 0}',
    '    m_FontSize: ' + (fontSize || 42),
    '    m_FontStyle: 0',
    '    m_BestFit: 0',
    '    m_MinSize: 10',
    '    m_MaxSize: 80',
    '    m_Alignment: 4',
    '    m_AlignByGeometry: 0',
    '    m_RichText: 1',
    '    m_HorizontalOverflow: 1',
    '    m_VerticalOverflow: 1',
    '    m_LineSpacing: 1',
    '  m_Text: ' + yamlQuotedString(text || ''),
    ''
  ].join('\n');
}

function uiTextGameObjectYaml(name, goId, rectId, canvasRendererId, textId, parentRectId, size, anchoredPos, text, fontSize) {
  return [
    '--- !u!1 &' + goId,
    'GameObject:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  serializedVersion: 6',
    '  m_Component:',
    '  - component: {fileID: ' + rectId + '}',
    '  - component: {fileID: ' + canvasRendererId + '}',
    '  - component: {fileID: ' + textId + '}',
    '  m_Layer: 5',
    '  m_Name: ' + yamlQuotedString(name),
    '  m_TagString: Untagged',
    '  m_Icon: {fileID: 0}',
    '  m_NavMeshLayer: 0',
    '  m_StaticEditorFlags: 0',
    '  m_IsActive: 1',
    '--- !u!224 &' + rectId,
    'RectTransform:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    '  m_LocalPosition: {x: 0, y: 0, z: 0}',
    '  m_LocalScale: {x: 1, y: 1, z: 1}',
    '  m_ConstrainProportionsScale: 0',
    '  m_Children: []',
    '  m_Father: {fileID: ' + (parentRectId || 0) + '}',
    '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
    '  m_AnchorMin: {x: 0.5, y: 0.5}',
    '  m_AnchorMax: {x: 0.5, y: 0.5}',
    '  m_AnchoredPosition: {x: ' + anchoredPos.x + ', y: ' + anchoredPos.y + '}',
    '  m_SizeDelta: {x: ' + size.x + ', y: ' + size.y + '}',
    '  m_Pivot: {x: 0.5, y: 0.5}',
    '--- !u!222 &' + canvasRendererId,
    'CanvasRenderer:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_CullTransparentMesh: 1',
    uiTextMonoBehaviourYaml(textId, goId, text, fontSize)
  ].join('\n');
}

function uiRectGameObjectYaml(name, goId, rectId, canvasRendererId, imageId, joystickId, parentRectId, childRectIds, spriteGuid, size, anchoredPos, color, joystickGuid) {
  var components = [
    '  - component: {fileID: ' + rectId + '}',
    '  - component: {fileID: ' + canvasRendererId + '}',
    '  - component: {fileID: ' + imageId + '}'
  ];
  if (joystickId && joystickGuid) components.push('  - component: {fileID: ' + joystickId + '}');
  var children = childRectIds && childRectIds.length
    ? childRectIds.map(function(id) { return '  - {fileID: ' + id + '}'; }).join('\n')
    : ' []';
  return [
    '--- !u!1 &' + goId,
    'GameObject:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  serializedVersion: 6',
    '  m_Component:',
    components.join('\n'),
    '  m_Layer: 5',
    '  m_Name: ' + name,
    '  m_TagString: Untagged',
    '  m_Icon: {fileID: 0}',
    '  m_NavMeshLayer: 0',
    '  m_StaticEditorFlags: 0',
    '  m_IsActive: 1',
    '--- !u!224 &' + rectId,
    'RectTransform:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
    '  m_LocalPosition: {x: 0, y: 0, z: 0}',
    '  m_LocalScale: {x: 1, y: 1, z: 1}',
    '  m_ConstrainProportionsScale: 0',
    '  m_Children:' + (children === ' []' ? children : '\n' + children),
    '  m_Father: {fileID: ' + (parentRectId || 0) + '}',
    '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
    '  m_AnchorMin: {x: 0, y: 0}',
    '  m_AnchorMax: {x: 0, y: 0}',
    '  m_AnchoredPosition: {x: ' + anchoredPos.x + ', y: ' + anchoredPos.y + '}',
    '  m_SizeDelta: {x: ' + size.x + ', y: ' + size.y + '}',
    '  m_Pivot: {x: 0.5, y: 0.5}',
    '--- !u!222 &' + canvasRendererId,
    'CanvasRenderer:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    '  m_GameObject: {fileID: ' + goId + '}',
    '  m_CullTransparentMesh: 1',
    uiImageMonoBehaviourYaml(imageId, goId, spriteGuid, color),
    joystickId && joystickGuid ? monoBehaviourYaml(joystickId, goId, joystickGuid, []) : ''
  ].filter(Boolean).join('\n');
}

function appendChildToTransform(text, parentId, childId) {
  if (!parentId || !childId) return text;
  var re = new RegExp('(--- !u!(?:4|224) &' + escapeRegExp(parentId) + '\\n[\\s\\S]*?)(?=\\n--- !u!\\d+ &-?\\d+|$)');
  return String(text || '').replace(re, function(block) {
    if (new RegExp('\\{fileID:\\s*' + escapeRegExp(childId) + '\\}').test(block)) return block;
    if (/  m_Children:\s*\[\]/.test(block)) {
      return block.replace(/  m_Children:\s*\[\]/, '  m_Children:\n  - {fileID: ' + childId + '}');
    }
    if (/  m_Children:\n/.test(block)) {
      return block.replace(/(  m_Children:\n)/, '$1  - {fileID: ' + childId + '}\n');
    }
    return block.replace(/(\n  m_ConstrainProportionsScale:[^\n\r]*)/, '$1\n  m_Children:\n  - {fileID: ' + childId + '}');
  });
}

function findRectTransformForGameObjectName(sceneText, name) {
  var doc = splitUnityYaml(sceneText);
  var idx = sceneIndex(doc);
  var goId = idx.goByName[name];
  if (!goId) return '';
  var ids = idx.goComponents[goId] || [];
  for (var i = 0; i < ids.length; i++) {
    var block = idx.byId[ids[i]];
    if (block && (block.type === '224' || block.type === '4')) return ids[i];
  }
  return '';
}

function injectJoystickSceneObjects(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return { injected: 0, present: false };
  var text = fs.readFileSync(sceneFile, 'utf8').replace(/\s+$/g, '') + '\n';
  if (/m_Name:\s*JoystickBG\b/.test(text) && /m_Name:\s*JoystickHandle\b/.test(text)) {
    return { injected: 0, present: true };
  }
  var canvasRectId = findRectTransformForGameObjectName(text, 'Canvas');
  if (!canvasRectId) return { injected: 0, present: false, missingCanvas: true };
  var joystickFile = findScriptByClass(root, 'GMP_Joystick');
  if (!joystickFile) return { injected: 0, present: false, missingScript: true };
  ensureUnityMeta(joystickFile);
  var joystickGuid = readUnityMetaGuid(joystickFile);
  if (!joystickGuid) return { injected: 0, present: false, missingScriptGuid: true };

  var bgSpriteGuid = writeJoystickSprite(root, 'JoystickBGCircle', [36, 196, 255, 105], true);
  var handleSpriteGuid = writeJoystickSprite(root, 'JoystickHandleCircle', [255, 255, 255, 210], false);
  var bgGo = deterministicSceneFileId('joystick:bg:go');
  var bgRect = deterministicSceneFileId('joystick:bg:rect');
  var bgCanvasRenderer = deterministicSceneFileId('joystick:bg:canvas-renderer');
  var bgImage = deterministicSceneFileId('joystick:bg:image');
  var bgScript = deterministicSceneFileId('joystick:bg:script');
  var handleGo = deterministicSceneFileId('joystick:handle:go');
  var handleRect = deterministicSceneFileId('joystick:handle:rect');
  var handleCanvasRenderer = deterministicSceneFileId('joystick:handle:canvas-renderer');
  var handleImage = deterministicSceneFileId('joystick:handle:image');
  var bgYaml = uiRectGameObjectYaml(
    'JoystickBG',
    bgGo,
    bgRect,
    bgCanvasRenderer,
    bgImage,
    bgScript,
    canvasRectId,
    [handleRect],
    bgSpriteGuid,
    { x: 200, y: 200 },
    { x: 1760, y: 160 },
    { r: 0.15, g: 0.78, b: 1, a: 0 },
    joystickGuid
  );
  var handleYaml = uiRectGameObjectYaml(
    'JoystickHandle',
    handleGo,
    handleRect,
    handleCanvasRenderer,
    handleImage,
    '',
    bgRect,
    [],
    handleSpriteGuid,
    { x: 80, y: 80 },
    { x: 0, y: 0 },
    { r: 1, g: 1, b: 1, a: 0 },
    ''
  );
  text = appendChildToTransform(text, canvasRectId, bgRect);
  text += bgYaml + '\n' + handleYaml + '\n';
  fs.writeFileSync(sceneFile, text);
  return { injected: 2, present: true };
}

function injectHudTextSceneObjects(root, visualHints) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return { injected: 0, present: false };
  var text = fs.readFileSync(sceneFile, 'utf8').replace(/\s+$/g, '') + '\n';
  var canvasRectId = findRectTransformForGameObjectName(text, 'Canvas');
  if (!canvasRectId) return { injected: 0, present: false, missingCanvas: true };
  var slots = [
    { name: 'Text_', text: '', size: { x: 920, y: 104 }, pos: { x: 0, y: 450 }, fontSize: 52 },
    { name: 'Text_Score: 0', text: 'Score: 0', size: { x: 460, y: 80 }, pos: { x: 680, y: 480 }, fontSize: 40 },
    { name: 'Text', text: '', size: { x: 420, y: 84 }, pos: { x: 0, y: 0 }, fontSize: 32 },
    { name: 'Text_Phase', text: 'Phase 1/8', size: { x: 250, y: 64 }, pos: { x: -770, y: 480 }, fontSize: 30 },
    { name: 'Text_Ice', text: '冰: 0', size: { x: 180, y: 64 }, pos: { x: -550, y: 480 }, fontSize: 30 },
    { name: 'Text_Oxygen', text: '氧气: 0', size: { x: 210, y: 64 }, pos: { x: -360, y: 480 }, fontSize: 30 },
    { name: 'Text_Scrap', text: '铁块: 0', size: { x: 210, y: 64 }, pos: { x: -150, y: 480 }, fontSize: 30 },
    { name: 'Text_Coin', text: '金币: 0', size: { x: 210, y: 64 }, pos: { x: 60, y: 480 }, fontSize: 30 },
    { name: 'Text_Pickaxe', text: '镐子: 0', size: { x: 210, y: 64 }, pos: { x: 270, y: 480 }, fontSize: 30 },
    { name: 'Text_Tip', text: '买氧气并解锁飞船', size: { x: 620, y: 64 }, pos: { x: 650, y: 480 }, fontSize: 30 },
    { name: 'Text_TargetHint', text: '目标: 氧气购买台', size: { x: 700, y: 84 }, pos: { x: 0, y: -390 }, fontSize: 38 },
    { name: 'Text_StepToast', text: '', size: { x: 760, y: 90 }, pos: { x: 0, y: 280 }, fontSize: 38 },
    { name: 'Text_PhaseProgress', text: 'Phase 1 / 8', size: { x: 360, y: 70 }, pos: { x: 700, y: 395 }, fontSize: 32 }
  ];
  var phaseEntities = readPhaseSpawnEntities(root, 1);
  var styles = visualHints && visualHints.styles ? visualHints.styles : {};
  phaseEntities.slice(0, 6).forEach(function(entityName, index) {
    var style = styles[canonicalEntityName(entityName)] || styles[entityName] || {};
    var label = style.label || canonicalEntityName(entityName);
    slots.push({
      name: 'Text_Label_' + sanitizeIdentifier(canonicalEntityName(entityName), 'Entity'),
      text: label,
      size: { x: 240, y: 52 },
      pos: { x: -520 + index * 205, y: 245 - (index % 2) * 46 },
      fontSize: 24
    });
  });
  var injected = 0;
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i];
    if (new RegExp('m_Name:\\s*(?:"' + escapeRegExp(slot.name) + '"|' + escapeRegExp(slot.name) + ')').test(text)) continue;
    var seed = 'ui:text:' + slot.name;
    var goId = deterministicSceneFileId(seed + ':go');
    var rectId = deterministicSceneFileId(seed + ':rect');
    var canvasRendererId = deterministicSceneFileId(seed + ':canvas-renderer');
    var textId = deterministicSceneFileId(seed + ':text');
    text = appendChildToTransform(text, canvasRectId, rectId);
    text += uiTextGameObjectYaml(slot.name, goId, rectId, canvasRendererId, textId, canvasRectId, slot.size, slot.pos, slot.text, slot.fontSize) + '\n';
    injected++;
  }
  if (injected) fs.writeFileSync(sceneFile, text);
  return { injected: injected, present: true, slotCount: slots.length };
}

function phaseAssetGuids(root) {
  var dir = phaseAssetDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function(name) { return /^Phase\d+\.asset$/.test(name); })
    .sort(function(a, b) {
      return Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
    })
    .map(function(name) {
      var meta = path.join(dir, name + '.meta');
      var guid = '';
      if (fs.existsSync(meta)) {
        var match = /^guid:\s*([0-9a-fA-F]+)/m.exec(fs.readFileSync(meta, 'utf8'));
        guid = match ? match[1] : '';
      }
      return guid;
    })
    .filter(Boolean);
}

function sceneObjectExtraSerializedLines(root, name) {
  if (name === 'GMP_Audio') {
    return [
      '  mBgmList: []',
      '  mSfxList: []'
    ];
  }
  if (name !== 'GMP_PhaseController') return [];
  var guids = phaseAssetGuids(root);
  if (!guids.length) {
    return ['  mPhases: []'];
  }
  var lines = ['  mPhases:'];
  guids.forEach(function(guid) {
    lines.push('  - {fileID: 11400000, guid: ' + guid + ', type: 2}');
  });
  return lines;
}

function injectSceneMountedScriptObjects(root) {
  var scene = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(scene)) return { injected: 0, scene: scene, names: [] };
  var names = [
    'GMP_MainManager',
    'GMP_PhaseController',
    'GMP_EntityBindingManager',
    'GMP_AutoPlayDriver',
    'GMP_HudController',
    'GMP_EventModule',
    'GMP_LevelRuleEngine',
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
    text += sceneObjectYaml(name, guid, i, sceneObjectExtraSerializedLines(root, name));
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

function removeEmptyDirs(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return 0;
  var removed = 0;
  fs.readdirSync(root, { withFileTypes: true }).forEach(function(entry) {
    if (!entry.isDirectory()) return;
    removed += removeEmptyDirs(path.join(root, entry.name));
  });
  if (root.indexOf(path.join('Assets', 'Scripts')) >= 0 && fs.existsSync(root)) {
    var entries = fs.readdirSync(root);
    if (!entries.length && path.basename(root) !== 'Scripts') {
      fs.rmdirSync(root);
      removed++;
    }
  }
  return removed;
}

function routeV14ScriptPath(scriptsRoot, file) {
  var name = path.basename(file);
  if (!/\.cs$/i.test(name)) return file;
  if (name === 'MonoSingleton.cs' || name === 'GMP_CoreEnums.cs' ||
      /^GMP_(?:BaseGameFlowEntity|PlayerBase|NPCBase)\.cs$/.test(name)) {
    return path.join(scriptsRoot, 'Core', 'Base', name);
  }
  if (/^GMP_(?:MovementComponent|TriggerComponent|InteractionComponent|InventoryComponent|SkillComponent|SmoothMover|Billboard|Joystick)\.cs$/.test(name)) {
    return path.join(scriptsRoot, 'Core', 'Components', name);
  }
  if (/^GMP_(?:SceneObjectRegistry|ScriptActivator|ResourceIds|GameSceneCtrl)\.cs$/.test(name)) {
    return path.join(scriptsRoot, 'Core', 'Common', name);
  }
  if (/^GMP_(?:MainManager|Pool|ReturnTimer|Audio|EconomyManager|ItemManager|NpcManager|UIManager|HudController|TipsManager|EventModule|PhaseController|PhasePreset|PhaseGate|PhaseTransition)\.cs$/.test(name)) {
    return path.join(scriptsRoot, 'Core', 'Modules', name);
  }
  if (/^GMP_(?:CameraController|UI|VisualGuide)\.cs$/.test(name)) {
    return path.join(scriptsRoot, 'Tool', name);
  }
  if (/^GMP_(?:AutoPlay|AutoPlayDriver)\.cs$/.test(name)) {
    return path.join(scriptsRoot, 'Game', 'AutoPlay', name);
  }
  if (/^GMP_(?:EntityBinding|EntityBindingManager|LevelRuleEngine|LevelEventNames)\.cs$/.test(name)) {
    return path.join(scriptsRoot, 'Game', 'Level', name);
  }
  if (name === 'GMP_Player.cs') {
    return path.join(scriptsRoot, 'Game', 'Player', name);
  }
  if (/^GMP_.*Entity\.cs$/.test(name)) {
    return path.join(scriptsRoot, 'Game', 'Entities', name);
  }
  return path.join(scriptsRoot, 'Game', 'Level', name);
}

function rewriteSingletonBaseToMonoSingleton(scriptsRoot) {
  if (!fs.existsSync(scriptsRoot)) return { changedFiles: 0, removedFiles: 0 };
  var changedFiles = 0;
  walkFiles(scriptsRoot).forEach(function(file) {
    if (path.extname(file).toLowerCase() !== '.cs') return;
    var before = fs.readFileSync(file, 'utf8');
    var next = before
      .replace(/\bGMP_SingletonBase\s*</g, 'MonoSingleton<')
      .replace(/GMP_SingletonBase/g, 'MonoSingleton');
    if (next !== before) {
      fs.writeFileSync(file, next.replace(/\s+$/g, '') + '\n');
      changedFiles++;
    }
  });
  var removedFiles = 0;
  walkFiles(scriptsRoot).forEach(function(file) {
    if (path.basename(file) === 'GMP_SingletonBase.cs') {
      if (removeIfExists(file)) removedFiles++;
      removeIfExists(file + '.meta');
    }
  });
  return { changedFiles: changedFiles, removedFiles: removedFiles };
}

function wirePlayerComponents(scriptsRoot) {
  var file = findScriptByClass(path.dirname(scriptsRoot), 'GMP_Player') || findScriptByClass(scriptsRoot, 'GMP_Player');
  if (!file || !fs.existsSync(file)) return false;
  var text = fs.readFileSync(file, 'utf8');
  var next = text;
  if (next.indexOf('typeof(GMP_MovementComponent)') < 0) {
    next = next.replace(/public class GMP_Player\s*:\s*MonoBehaviour/, [
      '[RequireComponent(typeof(GMP_MovementComponent))]',
      '[RequireComponent(typeof(GMP_TriggerComponent))]',
      '[RequireComponent(typeof(GMP_InteractionComponent))]',
      'public class GMP_Player : MonoBehaviour'
    ].join('\n'));
  }
  if (next.indexOf('GMP_MovementComponent mMovementComponent') < 0) {
    next = next.replace(/(private GMP_Joystick mJoystick;\s*)/, '$1\n    private GMP_MovementComponent mMovementComponent;\n    private GMP_TriggerComponent mTriggerComponent;\n    private GMP_InteractionComponent mInteractionComponent;\n');
  }
  if (next.indexOf('mMovementComponent = GetComponent<GMP_MovementComponent>()') < 0) {
    next = next.replace(/(IsInited = true;\s*)/, '$1\n        mMovementComponent = GetComponent<GMP_MovementComponent>();\n        mTriggerComponent = GetComponent<GMP_TriggerComponent>();\n        mInteractionComponent = GetComponent<GMP_InteractionComponent>();\n');
  }
  next = next.replace(
    /Vector3 move = new Vector3\(h, 0, v\) \* MoveSpeed \* Time\.deltaTime;\s*go\.transform\.position \+= move;\s*go\.transform\.rotation = Quaternion\.LookRotation\(new Vector3\(h, 0, v\)\);/,
    'if (mMovementComponent != null) mMovementComponent.Move(go.transform, new Vector3(h, 0, v), MoveSpeed);'
  );
  if (next !== text) {
    fs.writeFileSync(file, next.replace(/\s+$/g, '') + '\n');
    return true;
  }
  return false;
}

function splitV14OneFileOneClass(scriptsRoot) {
  if (!fs.existsSync(scriptsRoot)) return { changedFiles: 0 };
  var changedFiles = 0;

  var poolFile = path.join(scriptsRoot, 'Core', 'Modules', 'GMP_Pool.cs');
  if (fs.existsSync(poolFile)) {
    var poolText = fs.readFileSync(poolFile, 'utf8');
    var timerMatch = /(?:\n|\r\n)public class GMP_ReturnTimer : MonoBehaviour[\s\S]*$/m.exec(poolText);
    if (timerMatch) {
      var timerCode = [
        'using UnityEngine;',
        '',
        timerMatch[0].replace(/^\s+/, '').replace(/\s+$/g, '')
      ].join('\n');
      writeGeneratedCs(path.join(path.dirname(poolFile), 'GMP_ReturnTimer.cs'), timerCode);
      fs.writeFileSync(poolFile, poolText.slice(0, timerMatch.index).replace(/\s+$/g, '') + '\n');
      changedFiles += 2;
    }
  }

  var bindingManagerFile = path.join(scriptsRoot, 'Game', 'Level', 'GMP_EntityBindingManager.cs');
  if (fs.existsSync(bindingManagerFile)) {
    var managerText = fs.readFileSync(bindingManagerFile, 'utf8');
    var bindingMatch = /(\[System\.Serializable\]\s*(?:\r?\n)public class GMP_EntityBinding\s*\{[\s\S]*?(?:\r?\n)\})(?:\r?\n)+(public class GMP_EntityBindingManager\s*:)/m.exec(managerText);
    if (bindingMatch) {
      var bindingCode = [
        'using UnityEngine;',
        '',
        bindingMatch[1].replace(/\s+$/g, '')
      ].join('\n');
      writeGeneratedCs(path.join(path.dirname(bindingManagerFile), 'GMP_EntityBinding.cs'), bindingCode);
      var nextManager = managerText.slice(0, bindingMatch.index) + bindingMatch[2] + managerText.slice(bindingMatch.index + bindingMatch[0].length);
      fs.writeFileSync(bindingManagerFile, nextManager.replace(/\s+$/g, '') + '\n');
      changedFiles += 2;
    }
  }

  return { changedFiles: changedFiles };
}

function parseCameraVector(value, fallback) {
  if (Array.isArray(value) && value.length >= 3) {
    return { x: Number(value[0]), y: Number(value[1]), z: Number(value[2]) };
  }
  return parseVector3(value) || fallback;
}

function cameraFollowConfigFromVisualHints(visualHints) {
  var camera = visualHints && visualHints.scene && visualHints.scene.camera ? visualHints.scene.camera : {};
  var follow = camera.follow || camera;
  var targetOffset = parseCameraVector(
    follow.targetOffset || follow.target_offset,
    { x: 4, y: 0, z: 2 }
  );
  var posOffset = parseCameraVector(
    follow.posOffset || follow.positionOffset || follow.cameraOffset || follow.pos_offset || follow.position_offset || follow.camera_offset,
    { x: 10, y: 18, z: 24 }
  );
  var lerpFactor = Number(follow.lerpFactor || follow.followLerpFactor || follow.followLerp || follow.lerp || 2.2);
  if (!isFinite(lerpFactor) || lerpFactor <= 0) lerpFactor = 2.2;
  return { targetOffset: targetOffset, posOffset: posOffset, lerpFactor: lerpFactor };
}

function cameraNumberLiteral(value) {
  var n = Number(value);
  if (!isFinite(n)) n = 0;
  var fixed = Math.abs(n - Math.round(n)) < 0.000001 ? String(Math.round(n)) : String(Number(n.toFixed(4)));
  return fixed + 'f';
}

function cameraVectorLiteral(v) {
  return 'new Vector3(' + cameraNumberLiteral(v.x) + ', ' + cameraNumberLiteral(v.y) + ', ' + cameraNumberLiteral(v.z) + ')';
}

function buildDeliveryCameraControllerCode(config) {
  config = config || cameraFollowConfigFromVisualHints(null);
  var targetOffset = cameraVectorLiteral(config.targetOffset);
  var posOffset = cameraVectorLiteral(config.posOffset);
  var lerpFactor = cameraNumberLiteral(config.lerpFactor);
  return [
    '// ============================================================================',
    '// GMP_CameraController.cs — 程序员交付版源场景镜头',
    '// ----------------------------------------------------------------------------',
    '// 职责：保留 Game.unity 中 storyboard2html/source HTML 写入的首帧相机姿态，',
    '//       并在运行时按源 HTML 的玩家跟随公式平滑更新镜头。',
    '// ============================================================================',
    '',
    'using UnityEngine;',
    '',
    'public class GMP_CameraController : MonoBehaviour',
    '{',
    '    private static GMP_CameraController mInstance;',
    '    public static GMP_CameraController instance',
    '    {',
    '        get',
    '        {',
    '            if (mInstance == null)',
    '            {',
    '                var obj = GMP_SceneObjectRegistry.Find("GMP_CameraController");',
    '                mInstance = obj != null ? obj.GetComponent<GMP_CameraController>() : null;',
    '            }',
    '            return mInstance;',
    '        }',
    '    }',
    '',
    '    public Camera Main { get { return mMainCam; } } // 主相机缓存，避免每帧 Camera.main。',
    '    private Camera mMainCam;',
    '    private bool IsInited = false;',
    '    private Vector3 mTargetPosition;',
    '    private Quaternion mTargetRotation;',
    '    private bool IsHasTarget = false;',
    '    private float mTargetOrthoSize = 8f;',
    '    private bool IsHasOrthoTarget = false;',
    '',
    '    public float PanLerpRate = ' + lerpFactor + '; // 与 sourceSceneContract.camera 的跟随 lerpFactor 对齐。',
    '    public float RotateLerpRate = ' + lerpFactor + '; // 备用旋转平滑速率，常规跟随直接 LookAt 目标点。',
    '    public float ZoomLerpRate = 1.0f; // 只在正交相机项目里使用，透视源场景不改 FOV。',
    '    public float MinOrthoSize = 4.5f; // 防止正交项目 zoom 过近。',
    '    public float MaxOrthoSize = 12f; // 防止正交项目 zoom 过远。',
    '    public float SettleDistance = 0.005f; // 手动 FramePoint 收敛阈值。',
    '',
    '    public void Init()',
    '    {',
    '        if (IsInited) return;',
    '        IsInited = true;',
    '        mMainCam = Camera.main;',
    '        if (mMainCam == null) return;',
    '        mTargetPosition = mMainCam.transform.position;',
    '        mTargetRotation = mMainCam.transform.rotation;',
    '        mTargetOrthoSize = mMainCam.orthographicSize;',
    '    }',
    '',
    '    private void Awake()',
    '    {',
    '        if (mInstance != null && mInstance != this) { enabled = false; return; }',
    '        mInstance = this;',
    '        Init();',
    '    }',
    '',
    '    private Transform ResolvePlayerTransform()',
    '    {',
    '        GameObject taggedPlayer = null;',
    '        try { taggedPlayer = GameObject.FindWithTag("Player"); } catch (UnityException) { taggedPlayer = null; }',
    '        if (taggedPlayer != null) return taggedPlayer.transform;',
    '        var playerController = GMP_Player.instance;',
    '        if (playerController != null && playerController.Trans != null) return playerController.Trans;',
    '        var player = GMP_SceneObjectRegistry.Find("Player");',
    '        if (player == null) player = GMP_SceneObjectRegistry.Find("_player");',
    '        if (player == null) player = GameObject.Find("_player");',
    '        if (player == null) player = GameObject.Find("Player");',
    '        return player != null ? player.transform : null;',
    '    }',
    '',
    '    private void FollowSourceHtmlPlayerCamera()',
    '    {',
    '        if (mMainCam == null) return;',
    '        Transform player = ResolvePlayerTransform();',
    '        if (player == null) return;',
    '        Vector3 target = player.position + ' + targetOffset + ';',
    '        Vector3 pos = target + ' + posOffset + ';',
    '        mMainCam.transform.position = Vector3.Lerp(mMainCam.transform.position, pos, Time.deltaTime * ' + lerpFactor + ');',
    '        mMainCam.transform.LookAt(target);',
    '    }',
    '',
    '    public void LookAt(Vector3 worldPos)',
    '    {',
    '        if (mMainCam == null) return;',
    '        mTargetRotation = Quaternion.LookRotation(worldPos - mMainCam.transform.position);',
    '        IsHasTarget = true;',
    '    }',
    '',
    '    public void MoveTo(Vector3 worldPosition)',
    '    {',
    '        mTargetPosition = worldPosition;',
    '        IsHasTarget = true;',
    '    }',
    '',
    '    public void SetOrthographicSize(float size)',
    '    {',
    '        if (size <= 0f) return;',
    '        mTargetOrthoSize = Mathf.Clamp(size, MinOrthoSize, MaxOrthoSize);',
    '        IsHasOrthoTarget = true;',
    '    }',
    '',
    '    public void FramePoint(Vector3 worldPosition, float orthoSize)',
    '    {',
    '        if (mMainCam == null) return;',
    '        SetOrthographicSize(orthoSize);',
    '        Vector3 target = worldPosition + ' + targetOffset + ';',
    '        mTargetPosition = target + ' + posOffset + ';',
    '        mTargetRotation = Quaternion.LookRotation(target - mTargetPosition);',
    '        IsHasTarget = true;',
    '    }',
    '',
    '    public void SetCameraHeight(float height, float zOffset)',
    '    {',
    '        if (mMainCam == null) return;',
    '        Vector3 cur = mMainCam.transform.position;',
    '        mTargetPosition = new Vector3(cur.x, height, zOffset);',
    '        IsHasTarget = true;',
    '    }',
    '',
    '    private void LateUpdate()',
    '    {',
    '        if (mMainCam == null) return;',
    '        FollowSourceHtmlPlayerCamera();',
    '        Transform t = mMainCam.transform;',
    '        if (IsHasTarget && ResolvePlayerTransform() == null)',
    '        {',
    '            t.position = Vector3.Lerp(t.position, mTargetPosition, PanLerpRate * Time.deltaTime);',
    '            t.rotation = Quaternion.Slerp(t.rotation, mTargetRotation, RotateLerpRate * Time.deltaTime);',
    '            if ((t.position - mTargetPosition).sqrMagnitude < SettleDistance * SettleDistance)',
    '            {',
    '                t.position = mTargetPosition;',
    '            }',
    '        }',
    '        if (IsHasOrthoTarget && mMainCam.orthographic)',
    '        {',
    '            float curSize = mMainCam.orthographicSize;',
    '            float nextSize = Mathf.Lerp(curSize, mTargetOrthoSize, ZoomLerpRate * Time.deltaTime);',
    '            if (Mathf.Abs(nextSize - mTargetOrthoSize) < 0.01f) nextSize = mTargetOrthoSize;',
    '            mMainCam.orthographicSize = nextSize;',
    '        }',
    '    }',
    '',
    '    public Ray ScreenPointToRay(Vector2 screenPoint)',
    '    {',
    '        if (mMainCam == null) return new Ray();',
    '        return mMainCam.ScreenPointToRay(screenPoint);',
    '    }',
    '',
    '    public bool IsReady { get { return mMainCam != null; } }',
    '}'
  ].join('\n');
}

function repairDeliveryCameraController(scriptsRoot, visualHints) {
  var file = findScriptByClass(scriptsRoot, 'GMP_CameraController');
  if (!file || !fs.existsSync(file)) return false;
  var before = fs.readFileSync(file, 'utf8');
  var next = buildDeliveryCameraControllerCode(cameraFollowConfigFromVisualHints(visualHints));
  if (before.replace(/\s+$/g, '') === next) return false;
  writeGeneratedCs(file, next);
  return true;
}

function applyV14Architecture(root, visualHints) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  if (!fs.existsSync(scriptsRoot)) return { changedFiles: 0 };
  var summary = { changedFiles: 0, movedFiles: 0, removedEmptyDirs: 0, singletonBaseRemoved: 0, playerComponentsWired: false };
  var coreBase = path.join(scriptsRoot, 'Core', 'Base');
  var components = path.join(scriptsRoot, 'Core', 'Components');
  var modules = path.join(scriptsRoot, 'Core', 'Modules');
  fs.mkdirSync(coreBase, { recursive: true });
  fs.mkdirSync(components, { recursive: true });
  fs.mkdirSync(modules, { recursive: true });
  writeGeneratedCs(path.join(coreBase, 'GMP_CoreEnums.cs'), buildCoreEnumsCode());
  writeGeneratedCs(path.join(components, 'GMP_MovementComponent.cs'), buildMovementComponentCode());
  writeGeneratedCs(path.join(components, 'GMP_TriggerComponent.cs'), buildTriggerComponentCode());
  writeGeneratedCs(path.join(components, 'GMP_InteractionComponent.cs'), buildInteractionComponentCode());
  writeGeneratedCs(path.join(components, 'GMP_InventoryComponent.cs'), buildInventoryComponentCode());
  writeGeneratedCs(path.join(components, 'GMP_SkillComponent.cs'), buildSkillComponentCode());
  writeGeneratedCs(path.join(modules, 'GMP_EventModule.cs'), buildEventModuleCode());
  summary.changedFiles += 7;

  var staleRuleEngine = findScriptByClass(root, 'GMP_EventRuleEngine');
  if (staleRuleEngine) {
    if (removeIfExists(staleRuleEngine)) summary.changedFiles++;
    removeIfExists(staleRuleEngine + '.meta');
  }

  var singleton = rewriteSingletonBaseToMonoSingleton(scriptsRoot);
  summary.changedFiles += singleton.changedFiles;
  summary.singletonBaseRemoved = singleton.removedFiles;

  if (wirePlayerComponents(scriptsRoot)) {
    summary.changedFiles++;
    summary.playerComponentsWired = true;
  }

  var files = walkFiles(scriptsRoot).filter(function(file) {
    return path.extname(file).toLowerCase() === '.cs';
  }).sort();
  files.forEach(function(file) {
    var target = routeV14ScriptPath(scriptsRoot, file);
    if (file !== target && moveFileWithMeta(file, target)) {
      summary.movedFiles++;
    }
  });

  var oneClassSummary = splitV14OneFileOneClass(scriptsRoot);
  summary.changedFiles += oneClassSummary.changedFiles;

  if (repairDeliveryCameraController(scriptsRoot, visualHints)) {
    summary.changedFiles++;
    summary.deliveryCameraControllerFollowRepaired = true;
  }

  if (repairDeliveryAudioManager(scriptsRoot)) {
    summary.changedFiles++;
    summary.audioManagerRewritten = true;
  }

  ['Core', 'Tool', 'Game'].forEach(function(name) {
    fs.mkdirSync(path.join(scriptsRoot, name), { recursive: true });
  });
  fs.mkdirSync(path.join(scriptsRoot, 'Game', 'Phases'), { recursive: true });
  summary.removedEmptyDirs = removeEmptyDirs(scriptsRoot);
  ['Core', 'Tool', 'Game'].forEach(function(name) {
    fs.mkdirSync(path.join(scriptsRoot, name), { recursive: true });
  });
  return summary;
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
    GMP_EntityBindingManager: true,
    GMP_EventModule: true,
    GMP_LevelRuleEngine: true,
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

function extractFirstStringArrayValues(code, varNames) {
  for (var i = 0; i < varNames.length; i++) {
    var found = extractStringArrayValues(code, varNames[i]);
    if (found) {
      found.varName = varNames[i];
      return found;
    }
  }
  return null;
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
  var ids = extractFirstStringArrayValues(code, ['mEntityBindingIds', '_entityBindingIds']);
  var pools = extractFirstStringArrayValues(code, ['mEntityBindingPools', '_entityBindingPools']);
  if (!ids || !pools || !ids.values.length || ids.values.length !== pools.values.length) {
    var scrubbed = scrubPrimitivePoolStrings(code);
    if (scrubbed !== code) {
      fs.writeFileSync(mainFile, scrubbed.replace(/\s+$/g, '') + '\n');
      return { bindings: 0, sceneRenamed: 0, changedFiles: 1 };
    }
    return { bindings: 0, sceneRenamed: 0, changedFiles: 0 };
  }

  ids.values = ids.values.map(function(value) { return normalizeDeliveryEntityName(value, []); });
  var changedFiles = 0;
  var map = [];
  for (var i = 0; i < ids.values.length; i++) {
    if (pools.values[i] && pools.values[i] !== ids.values[i]) {
      map.push({ from: pools.values[i], to: ids.values[i] });
    }
  }
  var nextCode = code.slice(0, pools.match.index) +
    stringArrayLiteral(pools.varName || 'mEntityBindingPools', ids.values) +
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

function writeDeterministicAssetMeta(file, seed) {
  var meta = file + '.meta';
  var guid = crypto.createHash('sha1').update('programmer-delivery-asset:' + seed).digest('hex').slice(0, 32);
  var lines = [
    'fileFormatVersion: 2',
    'guid: ' + guid,
    'NativeFormatImporter:',
    '  externalObjects: {}',
    '  mainObjectFileID: 11400000',
    '  userData:',
    '  assetBundleName:',
    '  assetBundleVariant:',
    ''
  ];
  fs.writeFileSync(meta, lines.join('\n'));
  return guid;
}

function phaseAssetDir(root) {
  var v14 = path.join(root, 'Assets', 'Scripts', 'Game', 'Phases');
  if (fs.existsSync(v14)) return v14;
  return path.join(root, 'Assets', 'Phases');
}

function collectPhaseIdsFromRuntime(code) {
  var found = Object.create(null);
  var ids = [];
  String(code || '').replace(/Phase_(phase\d+)_Init/g, function(_, id) {
    if (!found[id]) {
      found[id] = true;
      ids.push(id);
    }
    return _;
  });
  ids.sort(function(a, b) {
    return Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
  });
  if (!ids.length) {
    for (var i = 1; i <= 8; i++) ids.push('phase' + i);
  }
  return ids;
}

function collectDeliveryEntityIds(code) {
  var ids = extractFirstStringArrayValues(code, ['mEntityBindingIds', '_entityBindingIds']);
  if (ids && ids.values && ids.values.length) {
    var normalized = [];
    ids.values.forEach(function(value) {
      var next = normalizeDeliveryEntityName(value, []);
      if (next && normalized.indexOf(next) < 0) normalized.push(next);
    });
    return normalized;
  }
  var found = Object.create(null);
  var out = [];
  String(code || '').replace(/\bpublic\s+GameObject\s+([_m]?[A-Za-z][A-Za-z0-9_]*)\s*;/g, function(_, name) {
    var next = normalizeDeliveryEntityName(name, []);
    if (!found[next]) {
      found[next] = true;
      out.push(next);
    }
    return _;
  });
  return out;
}

function parsePhaseDeliveryInfo(code, phaseIds, entityIds) {
  var text = String(code || '');
  var out = [];
  for (var i = 0; i < phaseIds.length; i++) {
    var id = phaseIds[i];
    var title = '阶段 ' + (i + 1);
    var titleRe = new RegExp('Shot\\s+' + (i + 1) + '[\\s\\S]{0,240}?标题:\\s*([^\\n\\r]+)');
    var titleMatch = titleRe.exec(text);
    if (titleMatch) title = titleMatch[1].trim();
    var initRe = new RegExp('void\\s+Phase_' + escapeRegExp(id) + '_Init\\s*\\(\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}');
    var initMatch = initRe.exec(text);
    var block = initMatch ? initMatch[1] : '';
    var visible = [];
    var visibleMatch = /入画物体:\s*([^\n\r]+)/.exec(text.slice(Math.max(0, text.indexOf('Phase: ' + id) - 120), text.indexOf('Phase: ' + id) + 600));
    if (visibleMatch) {
      visible = visibleMatch[1].split(',').map(function(v) {
        return normalizeDeliveryEntityName(v.trim(), entityIds);
      }).filter(Boolean);
    }
    if (!visible.length) {
      block.replace(/PlaceObj\(\s*([_m]?[A-Za-z][A-Za-z0-9_]*)/g, function(_, name) {
        var next = normalizeDeliveryEntityName(name, entityIds);
        if (next && visible.indexOf(next) < 0) visible.push(next);
        return _;
      });
    }
    if (visible.indexOf('_player') < 0) visible.unshift('_player');
    var target = '';
    var targetMatch = /GMP_VisualGuide\.HighlightTarget\(\s*([_m]?[A-Za-z][A-Za-z0-9_]*)\s*\)/.exec(block);
    if (targetMatch) target = normalizeDeliveryEntityName(targetMatch[1], entityIds);
    else if (visible.length > 1) target = visible[1];
    out.push({
      phaseId: id,
      title: title,
      targetEntity: target,
      spawnEntities: visible
    });
  }
  return out;
}

function normalizeDeliveryEntityName(rawName, entityIds) {
  var name = String(rawName || '').trim();
  if (!name) return '';
  entityIds = entityIds || [];
  if (entityIds.indexOf(name) >= 0) return name;
  if (/^m[A-Z]/.test(name)) {
    var converted = '_' + name.charAt(1).toLowerCase() + name.slice(2);
    if (entityIds.indexOf(converted) >= 0) return converted;
    return converted;
  }
  if (name.charAt(0) !== '_') {
    var underscored = '_' + name.charAt(0).toLowerCase() + name.slice(1);
    if (entityIds.indexOf(underscored) >= 0) return underscored;
  }
  return name;
}

function readCsharpMethodBody(code, methodName) {
  var re = new RegExp('\\bbool\\s+' + escapeRegExp(methodName) + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  var match = re.exec(String(code || ''));
  if (!match) return '';
  var openIdx = match.index + match[0].lastIndexOf('{');
  var closeIdx = findMatchingBrace(code, openIdx);
  if (closeIdx < 0) return '';
  return code.slice(openIdx + 1, closeIdx);
}

function extractEntityGateTarget(body) {
  var text = String(body || '');
  var entityMatch = /\bEntityAdvanced\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/.exec(text);
  if (entityMatch) return entityMatch[1];
  var stateMatch = /\b([A-Za-z_][A-Za-z0-9_]*)State\s*>=\s*2\b/.exec(text);
  if (stateMatch) return stateMatch[1];
  return '';
}

function parsePhaseGateInfo(code, phaseIds, entityIds) {
  var out = Object.create(null);
  for (var i = 0; i < phaseIds.length; i++) {
    var phaseId = phaseIds[i];
    var methodName = i + 1 < phaseIds.length ? 'Phase_' + phaseIds[i + 1] + '_GateReady' : 'EndGame_GateReady';
    var body = readCsharpMethodBody(code, methodName);
    var target = normalizeDeliveryEntityName(extractEntityGateTarget(body), entityIds);
    if (target) {
      out[phaseId] = {
        kind: 'entity',
        target: target,
        threshold: 2
      };
    } else {
      out[phaseId] = {
        kind: 'timer',
        target: '',
        threshold: 12
      };
    }
  }
  return out;
}

function csharpStringArrayLiteral(values, indent) {
  indent = indent || '        ';
  if (!values || !values.length) return 'new string[0]';
  return 'new string[] { ' + values.map(function(value) { return '"' + csString(value) + '"'; }).join(', ') + ' }';
}

function buildPhasePresetCode() {
  return [
    'using System.Collections.Generic;',
    'using UnityEngine;',
    '',
    '[CreateAssetMenu(menuName = "GMP/GMP_PhasePreset")]',
    'public class GMP_PhasePreset : ScriptableObject',
    '{',
    '    public string mPhaseId; // 阶段唯一 ID,与生成流程中的 phase1/phase2 对齐。',
    '    public string mGuideText; // 进入阶段后显示给玩家的引导文案。',
    '    public string mTargetEntity; // 当前阶段主要目标实体名,为空表示不绑定单一目标。',
    '    public int mTargetCount; // 目标数量或进度阈值。',
    '    public string mResourceKey; // 阶段关联资源 key,例如 gold/ice。',
    '    public int mResourceThreshold; // 资源达成阈值。',
    '    public bool IsDamage; // 当前阶段是否包含破坏/攻击行为。',
    '    public float mMinSeconds = 12f; // 阶段最短停留秒数。',
    '    public List<string> mSpawnEntities = new List<string>(); // 进入阶段时需要显示的实体。',
    '    public List<string> mHideEntities = new List<string>(); // 进入阶段时需要隐藏的实体。',
    '    public GMP_PhaseGate mGate = new GMP_PhaseGate(); // 阶段完成判定配置。',
    '}'
  ].join('\n');
}

function phaseGateKindEnumValue(kind) {
  var value = String(kind || '').trim().toLowerCase();
  if (value === 'timer') return 1;
  if (value === 'resource') return 2;
  if (value === 'entity') return 3;
  if (value === 'entity_count') return 4;
  return 0;
}

function buildPhaseGateCode() {
  return [
    'using UnityEngine;',
    '',
    '[System.Serializable]',
    'public class GMP_PhaseGate',
    '{',
    '    public GMP_PhaseGateKind mKind = GMP_PhaseGateKind.None; // gate 类型,使用 enum 避免字符串魔法值。',
    '    public string mTarget; // gate 目标实体或资源。',
    '    public int mThreshold; // gate 阈值。',
    '',
    '    public bool IsReady(float elapsedSeconds)',
    '    {',
    '        if (elapsedSeconds < 0f) return false;',
    '        switch (mKind)',
    '        {',
    '            case GMP_PhaseGateKind.None:',
    '                return true;',
    '            case GMP_PhaseGateKind.Timer:',
    '                return elapsedSeconds >= Mathf.Max(0, mThreshold);',
    '            case GMP_PhaseGateKind.Resource:',
    '                if (string.IsNullOrEmpty(mTarget) || GMP_EconomyManager.instance == null) return false;',
    '                return GMP_EconomyManager.instance.GetResource(mTarget) >= Mathf.Max(1, mThreshold);',
    '            case GMP_PhaseGateKind.Entity:',
    '                if (string.IsNullOrEmpty(mTarget) || GMP_EntityBindingManager.instance == null) return false;',
    '                return (int)GMP_EntityBindingManager.instance.GetState(mTarget) >= Mathf.Max(1, mThreshold);',
    '            case GMP_PhaseGateKind.EntityCount:',
    '                if (GMP_EntityBindingManager.instance == null) return false;',
    '                return GMP_EntityBindingManager.instance.GetActiveCount(mTarget) >= Mathf.Max(1, mThreshold);',
    '            default:',
    '                return true;',
    '        }',
    '    }',
    '}'
  ].join('\n');
}

function buildPhaseControllerCode() {
  return [
    'using System.Collections.Generic;',
    'using UnityEngine;',
    '',
    'public class GMP_PhaseController : MonoSingleton<GMP_PhaseController>',
    '{',
    '    public List<GMP_PhasePreset> mPhases = new List<GMP_PhasePreset>(); // Inspector 拖入的阶段资产列表。',
    '    public int mCurrentIndex = -1; // 当前阶段索引。',
    '    public float mPhaseTimer = 0f; // 当前阶段运行时间。',
    '    public float mPhaseRealTimer = 0f; // 当前阶段真实墙钟时间。',
    '    private float mLastRealClock = 0f; // 上一帧真实时间戳。',
    '    private bool IsFlowStarted = false; // 是否已经进入第一阶段。',
    '',
    '    public GMP_PhasePreset CurrentPhase',
    '    {',
    '        get',
    '        {',
    '            if (mCurrentIndex < 0 || mCurrentIndex >= mPhases.Count) return null;',
    '            return mPhases[mCurrentIndex];',
    '        }',
    '    }',
    '',
    '    void Start()',
    '    {',
    '        StartFlow();',
    '    }',
    '',
    '    public void StartFlow()',
    '    {',
    '        if (IsFlowStarted) return;',
    '        IsFlowStarted = true;',
    '        EnterPhase(0);',
    '    }',
    '',
    '    public void Tick(float dt)',
    '    {',
    '        if (!IsFlowStarted) StartFlow();',
    '        if (CurrentPhase == null) return;',
    '        mPhaseTimer += dt;',
    '        float now = Time.realtimeSinceStartup;',
    '        float realDt = now - mLastRealClock;',
    '        if (realDt < 0f || realDt > 1f) realDt = 0f;',
    '        mPhaseRealTimer += realDt;',
    '        mLastRealClock = now;',
    '        GMP_PhasePreset preset = CurrentPhase;',
    '        float required = GMP_AutoPlayDriver.instance != null && GMP_AutoPlayDriver.instance.IsActive ? 12f : Mathf.Max(2f, preset.mMinSeconds);',
    '        bool IsDwellReady = mPhaseTimer >= required || mPhaseRealTimer >= required;',
    '        bool IsGateReady = preset.mGate == null || preset.mGate.IsReady(Mathf.Max(mPhaseTimer, mPhaseRealTimer));',
    '        if (IsDwellReady && IsGateReady)',
    '        {',
    '            AdvancePhase();',
    '        }',
    '    }',
    '',
    '    public void EnterPhase(int index)',
    '    {',
    '        if (mPhases.Count == 0) return;',
    '        mCurrentIndex = Mathf.Clamp(index, 0, mPhases.Count - 1);',
    '        mPhaseTimer = 0f;',
    '        mPhaseRealTimer = 0f;',
    '        mLastRealClock = Time.realtimeSinceStartup;',
    '        GMP_PhasePreset preset = CurrentPhase;',
    '        if (GMP_EntityBindingManager.instance != null) GMP_EntityBindingManager.instance.ShowPhaseEntities(preset);',
    '        if (GMP_HudController.instance != null) GMP_HudController.instance.SetGuideText(mCurrentIndex + 1, mPhases.Count, preset != null ? preset.mGuideText : "");',
    '        if (GMP_AutoPlayDriver.instance != null) GMP_AutoPlayDriver.instance.SetPhaseTargets(preset);',
    '        if (GMP_LevelRuleEngine.instance != null) GMP_LevelRuleEngine.instance.OnEnterPhase(preset);',
    '    }',
    '',
    '    public void AdvancePhase()',
    '    {',
    '        if (mCurrentIndex + 1 >= mPhases.Count)',
    '        {',
    '            if (GMP_MainManager.instance != null) GMP_MainManager.instance.MarkSuccess();',
    '            return;',
    '        }',
    '        EnterPhase(mCurrentIndex + 1);',
    '    }',
    '',
    '    public void CompletePhase()',
    '    {',
    '        AdvancePhase();',
    '    }',
    '',
    '    public void TryReportStuck()',
    '    {',
    '        if (GMP_HudController.instance != null) GMP_HudController.instance.SetGuideText(mCurrentIndex + 1, mPhases.Count, "阶段停留过久，请检查目标实体绑定。");',
    '    }',
    '}'
  ].join('\n');
}

function csharpVector3Literal(position) {
  if (!position) return 'new Vector3(0f, 0f, 0f)';
  function f(n) {
    var v = Number(n || 0);
    var s = v.toFixed(3).replace(/\.?0+$/g, '');
    if (s === '-0') s = '0';
    return s + 'f';
  }
  return 'new Vector3(' + f(position.x) + ', ' + f(position.y) + ', ' + f(position.z) + ')';
}

function buildDefaultPositionSwitchLines(entityIds, visualHints) {
  var lines = [];
  (entityIds || []).forEach(function(entityName) {
    var pos = positionForUnityEntity(visualHints, entityName);
    if (!pos) return;
    lines.push('        if (entityName == "' + csString(entityName) + '") return ' + csharpVector3Literal(pos) + ';');
  });
  return lines;
}

function buildEntityBindingManagerCode(entityIds, visualHints) {
  entityIds = entityIds && entityIds.length ? entityIds : ['_player'];
  var positionLines = buildDefaultPositionSwitchLines(entityIds, visualHints);
  return [
    'using System.Collections.Generic;',
    'using UnityEngine;',
    '',
    '[System.Serializable]',
    'public class GMP_EntityBinding',
    '{',
    '    public string mEntityName; // 业务实体名。',
    '    public GameObject mSceneObject; // 场景中拖入的实体对象。',
    '    public int mInitialState; // 初始状态。',
    '}',
    '',
    'public class GMP_EntityBindingManager : MonoSingleton<GMP_EntityBindingManager>',
    '{',
    '    public List<GMP_EntityBinding> mBindings = new List<GMP_EntityBinding>(); // Inspector 可维护的实体绑定表。',
    '    private string[] mEntityNames = ' + csharpStringArrayLiteral(entityIds) + ';',
    '    private GMP_EntityState[] mEntityStates; // 与 mEntityNames 对齐的轻量状态表。',
    '    private Vector3[] mOriginalPositions; // 运行时显示/隐藏不改源场景坐标。',
    '    private bool IsInitialized = false; // 防止重复初始化。',
    '',
    '    public void Init()',
    '    {',
    '        if (IsInitialized) return;',
    '        IsInitialized = true;',
    '        GMP_GameSceneCtrl.Init(gameObject);',
    '        mEntityStates = new GMP_EntityState[mEntityNames.Length];',
    '        mOriginalPositions = new Vector3[mEntityNames.Length];',
    '        for (int i = 0; i < mEntityNames.Length; i++)',
    '        {',
    '            GMP_GameSceneCtrl.instance.Register(mEntityNames[i], mEntityNames[i]);',
    '            CacheOriginalPosition(i);',
    '        }',
    '        HideAllExceptPlayer();',
    '    }',
    '',
    '    public void Tick(float dt)',
    '    {',
    '        Init();',
    '    }',
    '',
    '    public void Spawn(string entityName, int count)',
    '    {',
    '        Init();',
    '        Show(entityName);',
    '        SetState(entityName, GMP_EntityState.Active);',
    '    }',
    '',
    '    public GameObject Get(string entityName)',
    '    {',
    '        Init();',
    '        return GMP_GameSceneCtrl.instance != null ? GMP_GameSceneCtrl.instance.Get(entityName) : null;',
    '    }',
    '',
    '    public void Show(string entityName)',
    '    {',
    '        Init();',
    '        GameObject target = Get(entityName);',
    '        if (target == null) return;',
    '        int index = FindEntityIndex(entityName);',
    '        Vector3 pos = index >= 0 && mOriginalPositions != null ? mOriginalPositions[index] : target.transform.position;',
    '        if (pos.y < -100f) pos = DefaultPosition(entityName);',
    '        target.transform.position = pos;',
    '        SetVisible(target, true);',
    '        target.transform.localScale = Vector3.one * DefaultScale(entityName);',
    '        if (GetState(entityName) == GMP_EntityState.Hidden) SetState(entityName, GMP_EntityState.Active);',
    '    }',
    '',
    '    public void Hide(string entityName)',
    '    {',
    '        Init();',
    '        GameObject target = Get(entityName);',
    '        if (target != null) SetVisible(target, false);',
    '        SetState(entityName, GMP_EntityState.Hidden);',
    '    }',
    '',
    '    public void ShowPhaseEntities(GMP_PhasePreset preset)',
    '    {',
    '        Init();',
    '        HideAllExceptPlayer();',
    '        if (preset == null || preset.mSpawnEntities == null) return;',
    '        for (int i = 0; i < preset.mSpawnEntities.Count; i++) Show(preset.mSpawnEntities[i]);',
    '    }',
    '',
    '    public bool IsNearPlayer(string entityName, float range)',
    '    {',
    '        GameObject player = Get("_player");',
    '        GameObject target = Get(entityName);',
    '        if (player == null || target == null) return false;',
    '        return Vector3.Distance(player.transform.position, target.transform.position) <= range;',
    '    }',
    '',
    '    public void MarkEntityComplete(string entityName)',
    '    {',
    '        GameObject target = Get(entityName);',
    '        if (target != null) target.transform.position += new Vector3(0f, 0.5f, 0f);',
    '        SetState(entityName, GMP_EntityState.Completed);',
    '    }',
    '',
    '    public GMP_EntityState GetState(string entityName)',
    '    {',
    '        if (mEntityStates == null) Init();',
    '        for (int i = 0; i < mEntityNames.Length; i++) if (mEntityNames[i] == entityName) return mEntityStates[i];',
    '        return GMP_EntityState.Hidden;',
    '    }',
    '',
    '    public int GetActiveCount(string entityName)',
    '    {',
    '        Init();',
    '        int count = 0;',
    '        for (int i = 0; i < mEntityNames.Length; i++)',
    '        {',
    '            if (!string.IsNullOrEmpty(entityName) && mEntityNames[i] != entityName) continue;',
    '            GameObject target = Get(mEntityNames[i]);',
    '            if (target != null && IsVisible(target)) count++;',
    '        }',
    '        return count;',
    '    }',
    '',
    '    private void SetState(string entityName, GMP_EntityState state)',
    '    {',
    '        if (mEntityStates == null) Init();',
    '        for (int i = 0; i < mEntityNames.Length; i++) if (mEntityNames[i] == entityName) { mEntityStates[i] = state; return; }',
    '    }',
    '',
    '    private int FindEntityIndex(string entityName)',
    '    {',
    '        for (int i = 0; i < mEntityNames.Length; i++) if (mEntityNames[i] == entityName) return i;',
    '        return -1;',
    '    }',
    '',
    '    private void CacheOriginalPosition(int index)',
    '    {',
    '        if (index < 0 || index >= mEntityNames.Length || mOriginalPositions == null) return;',
    '        GameObject target = GMP_GameSceneCtrl.instance != null ? GMP_GameSceneCtrl.instance.Get(mEntityNames[index]) : null;',
    '        Vector3 pos = target != null ? target.transform.position : DefaultPosition(mEntityNames[index]);',
    '        if (pos.y < -100f) pos = DefaultPosition(mEntityNames[index]);',
    '        mOriginalPositions[index] = pos;',
    '        if (target != null) target.transform.position = pos;',
    '    }',
    '',
    '    private void SetVisible(GameObject target, bool visible)',
    '    {',
    '        if (target == null) return;',
    '        Renderer[] renderers = target.GetComponentsInChildren<Renderer>(true);',
    '        for (int i = 0; i < renderers.Length; i++) renderers[i].enabled = visible;',
    '    }',
    '',
    '    private bool IsVisible(GameObject target)',
    '    {',
    '        if (target == null) return false;',
    '        Renderer[] renderers = target.GetComponentsInChildren<Renderer>(true);',
    '        for (int i = 0; i < renderers.Length; i++) if (renderers[i].enabled) return true;',
    '        return false;',
    '    }',
    '',
    '    private void HideAllExceptPlayer()',
    '    {',
    '        for (int i = 0; i < mEntityNames.Length; i++)',
    '        {',
    '            if (mEntityNames[i] == "_player") continue;',
    '            Hide(mEntityNames[i]);',
    '        }',
    '        Show("_player");',
    '    }',
    '',
    '    private Vector3 DefaultPosition(string entityName)',
    '    {',
  ].concat(positionLines).concat([
    '        int index = 0;',
    '        for (int i = 0; i < mEntityNames.Length; i++) if (mEntityNames[i] == entityName) { index = i; break; }',
    '        float x = (index % 6) * 2.4f - 6f;',
    '        float z = (index / 6) * 2.2f - 2f;',
    '        if (entityName == "_player") return new Vector3(-1.5f, 0f, -2f);',
    '        if (entityName == "_ctaButton") return new Vector3(0f, 2f, 0f);',
    '        return new Vector3(x, 0f, z);',
    '    }',
    '',
    '    private float DefaultScale(string entityName)',
    '    {',
    '        if (entityName == "_ctaButton") return 0.5f;',
    '        return 0.7f;',
    '    }',
    '}'
  ]).join('\n');
}

function buildThinMainManagerCode() {
  return [
    'using UnityEngine;',
    '',
    'public class GMP_MainManager : MonoSingleton<GMP_MainManager>',
    '{',
    '    public GMP_GameState mGameState = GMP_GameState.Start; // 当前游戏状态。',
    '',
    '    protected override void Awake()',
    '    {',
    '        base.Awake();',
    '    }',
    '',
    '    void Start()',
    '    {',
    '        mGameState = GMP_GameState.Run;',
    '        if (GMP_EntityBindingManager.instance != null) GMP_EntityBindingManager.instance.Init();',
    '        if (GMP_HudController.instance != null) GMP_HudController.instance.Init();',
    '        if (GMP_AutoPlayDriver.instance != null) GMP_AutoPlayDriver.instance.Init();',
    '        if (GMP_PhaseController.instance != null) GMP_PhaseController.instance.StartFlow();',
    '    }',
    '',
    '    void Update()',
    '    {',
    '        if (mGameState == GMP_GameState.End || mGameState == GMP_GameState.Success) return;',
    '        float dt = Time.deltaTime;',
    '        if (GMP_PhaseController.instance != null) GMP_PhaseController.instance.Tick(dt);',
    '        if (GMP_EntityBindingManager.instance != null) GMP_EntityBindingManager.instance.Tick(dt);',
    '        if (GMP_AutoPlayDriver.instance != null) GMP_AutoPlayDriver.instance.Tick(dt);',
    '        if (GMP_HudController.instance != null) GMP_HudController.instance.Tick(dt);',
    '        if (GMP_LevelRuleEngine.instance != null) GMP_LevelRuleEngine.instance.Tick(dt);',
    '    }',
    '',
    '    public void MarkSuccess()',
    '    {',
    '        mGameState = GMP_GameState.Success;',
    '        if (GMP_HudController.instance != null) GMP_HudController.instance.SetGuideText(0, 0, "试玩完成，点击按钮下载。");',
    '    }',
    '}'
  ].join('\n');
}

function buildAutoPlayDriverCode() {
  return [
    'using System.Collections.Generic;',
    'using UnityEngine;',
    '',
    'public class GMP_AutoPlayDriver : MonoSingleton<GMP_AutoPlayDriver>',
    '{',
    '    public bool IsActive = false; // 当前是否进入自动播放。',
    '    private bool IsInitialized = false; // 防止重复绑定回调。',
    '',
    '    public void Init()',
    '    {',
    '        if (IsInitialized) return;',
    '        IsInitialized = true;',
    '        if (GMP_AutoPlay.instance != null) GMP_AutoPlay.instance.OnArrive = HandleAutoPlayArrive;',
    '    }',
    '',
    '    public void SetPhaseTargets(GMP_PhasePreset preset)',
    '    {',
    '        Init();',
    '        if (preset == null || preset.mSpawnEntities == null || GMP_AutoPlay.instance == null) return;',
    '        List<string> targets = new List<string>();',
    '        if (!string.IsNullOrEmpty(preset.mTargetEntity)) targets.Add(preset.mTargetEntity);',
    '        for (int i = 0; i < preset.mSpawnEntities.Count; i++)',
    '        {',
    '            string name = preset.mSpawnEntities[i];',
    '            if (!string.IsNullOrEmpty(name) && !targets.Contains(name)) targets.Add(name);',
    '        }',
    '        GMP_AutoPlay.instance.SetTargets(targets.ToArray());',
    '    }',
    '',
    '    public void Tick(float dt)',
    '    {',
    '        Init();',
    '        if (GMP_AutoPlay.instance == null) return;',
    '        GMP_AutoPlay.instance.CheckActivation(Time.time);',
    '        IsActive = GMP_AutoPlay.instance.IsActive;',
    '        if (IsActive) GMP_AutoPlay.instance.Tick();',
    '    }',
    '',
    '    private void HandleAutoPlayArrive(string targetName)',
    '    {',
    '        if (GMP_LevelRuleEngine.instance != null) GMP_LevelRuleEngine.instance.HandleAutoPlayArrive(targetName);',
    '    }',
    '}'
  ].join('\n');
}

function buildHudControllerCode() {
  return [
    'using UnityEngine;',
    'using UnityEngine.UI;',
    '',
    'public class GMP_HudController : MonoSingleton<GMP_HudController>',
    '{',
    '    public Canvas mCanvas; // 运行时 UI 画布。',
    '    public Text mGuideText; // 阶段引导文本。',
    '    public Text mScoreText; // 分数文本。',
    '    private string mCurrentGuide = ""; // 当前引导缓存。',
    '    private bool IsInitialized = false; // 防止重复创建 UI。',
    '',
    '    public void Init()',
    '    {',
    '        if (IsInitialized) return;',
    '        IsInitialized = true;',
    '        mCanvas = GMP_UI.CreateCanvas(1920, 1080);',
    '        mGuideText = GMP_UI.CreateText(mCanvas, "", new Vector2(0, 450), 52);',
    '        mScoreText = GMP_UI.CreateText(mCanvas, "Score: 0", new Vector2(680, 480), 40);',
    '    }',
    '',
    '    public void Tick(float dt)',
    '    {',
    '        Init();',
    '    }',
    '',
    '    public void SetGuideText(int phaseIndex, int totalPhases, string text)',
    '    {',
    '        Init();',
    '        mCurrentGuide = text == null ? "" : text;',
    '        if (mGuideText == null) return;',
    '        string prefix = phaseIndex > 0 && totalPhases > 0 ? "[" + phaseIndex + "/" + totalPhases + "] " : "";',
    '        mGuideText.text = prefix + mCurrentGuide;',
    '    }',
    '',
    '    public void SetScore(string text)',
    '    {',
    '        Init();',
    '        if (mScoreText != null) mScoreText.text = text == null ? "" : text;',
    '    }',
    '}'
  ].join('\n');
}

function buildLevelEventNamesCode() {
  return [
    'public static class GMP_LevelEventNames',
    '{',
    '    public const string PhaseEntered = "level.phase_entered";',
    '    public const string TargetCompleted = "level.target_completed";',
    '}'
  ].join('\n');
}

function buildLevelRuleEngineCode() {
  return [
    'using UnityEngine;',
    '',
    'public class GMP_LevelRuleEngine : MonoSingleton<GMP_LevelRuleEngine>',
    '{',
    '    public bool IsPhaseActionDone = false; // 当前阶段是否已经产生可观察动作。',
    '    private GMP_PhasePreset mActivePhase; // 当前阶段配置。',
    '',
    '    public void OnEnterPhase(GMP_PhasePreset preset)',
    '    {',
    '        mActivePhase = preset;',
    '        IsPhaseActionDone = false;',
    '        if (GMP_EventModule.instance != null) GMP_EventModule.instance.Publish(GMP_LevelEventNames.PhaseEntered, preset);',
    '    }',
    '',
    '    public void Tick(float dt)',
    '    {',
    '        if (mActivePhase == null) return;',
    '        if (GMP_Player.instance != null) GMP_Player.instance.Tick(dt, GMP_AutoPlayDriver.instance != null && GMP_AutoPlayDriver.instance.IsActive);',
    '        if (Input.GetMouseButtonDown(0)) TryInteractWithTarget();',
    '        TryInteractWithTarget();',
    '    }',
    '',
    '    public bool IsPhaseComplete(GMP_PhasePreset preset, float phaseTimer, float phaseRealTimer)',
    '    {',
    '        if (preset == null) return false;',
    '        return preset.mGate == null || preset.mGate.IsReady(Mathf.Max(phaseTimer, phaseRealTimer));',
    '    }',
    '',
    '    public void HandleAutoPlayArrive(string targetName)',
    '    {',
    '        MarkTarget(targetName);',
    '    }',
    '',
    '    private void TryInteractWithTarget()',
    '    {',
    '        if (mActivePhase == null || string.IsNullOrEmpty(mActivePhase.mTargetEntity)) return;',
    '        if (GMP_EntityBindingManager.instance == null) return;',
    '        if (GMP_EntityBindingManager.instance.IsNearPlayer(mActivePhase.mTargetEntity, 2.5f)) MarkTarget(mActivePhase.mTargetEntity);',
    '    }',
    '',
    '    private void MarkTarget(string targetName)',
    '    {',
    '        if (string.IsNullOrEmpty(targetName) || GMP_EntityBindingManager.instance == null) return;',
    '        GMP_EntityBindingManager.instance.MarkEntityComplete(targetName);',
    '        IsPhaseActionDone = true;',
    '        if (GMP_HudController.instance != null) GMP_HudController.instance.SetScore("Target: " + targetName);',
    '        if (GMP_EventModule.instance != null) GMP_EventModule.instance.Publish(GMP_LevelEventNames.TargetCompleted, targetName);',
    '    }',
    '}'
  ].join('\n');
}

function replaceSpawnWrappers(body) {
  var mappings = [];
  var wrapperRe = /^\s*void\s+Spawn([A-Z][A-Za-z0-9_]*)\s*\(\s*int\s+count\s*\)\s*\{\s*SpawnBoundEntity\(([^,]+),\s*ref\s+([^,]+),\s*count\);\s*\}\s*$/gm;
  var next = String(body || '').replace(wrapperRe, function(match, entity, goExpr, stateExpr) {
    mappings.push({ entity: entity, goExpr: goExpr.trim(), stateExpr: stateExpr.trim() });
    return '';
  });
  mappings.forEach(function(map) {
    var re = new RegExp('\\bSpawn' + escapeRegExp(map.entity) + '\\s*\\(', 'g');
    next = next.replace(re, 'Spawn("' + map.entity + '", ');
  });
  if (mappings.length && !/\bpublic\s+void\s+Spawn\s*\(\s*string\s+entityName/.test(next)) {
    var lines = [
      '    // 统一实体生成入口：由 EntityBindingManager 或旧逻辑传入实体名。',
      '    public void Spawn(string entityName, int count)',
      '    {',
      '        switch (entityName)',
      '        {'
    ];
    mappings.forEach(function(map) {
      lines.push('            case "' + map.entity + '": SpawnBoundEntity(' + map.goExpr + ', ref ' + map.stateExpr + ', count); break;');
    });
    lines.push('        }');
    lines.push('    }');
    next = next.replace(/(\s*void\s+SpawnBoundEntity\s*\([^}]+\}\n)/, '$1\n' + lines.join('\n') + '\n');
  }
  return { body: next, removed: mappings.length };
}

function emitPhasePresetAssets(root, phaseInfos) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var phaseScript = path.join(scriptsRoot, 'Common', 'GMP_PhasePreset.cs');
  var gateScript = path.join(scriptsRoot, 'Common', 'GMP_PhaseGate.cs');
  removeIfExists(path.join(scriptsRoot, 'Common', 'PhasePreset.cs'));
  removeIfExists(path.join(scriptsRoot, 'Common', 'PhasePreset.cs.meta'));
  removeIfExists(path.join(scriptsRoot, 'Common', 'PhaseGate.cs'));
  removeIfExists(path.join(scriptsRoot, 'Common', 'PhaseGate.cs.meta'));
  writeGeneratedCs(phaseScript, buildPhasePresetCode());
  writeGeneratedCs(gateScript, buildPhaseGateCode());
  var phaseGuid = readUnityMetaGuid(phaseScript);
  removeIfExists(path.join(root, 'Assets', 'Phases'));
  var dir = path.join(root, 'Assets', 'Scripts', 'Game', 'Phases');
  fs.mkdirSync(dir, { recursive: true });
  var count = 0;
  for (var i = 0; i < phaseInfos.length; i++) {
    var info = phaseInfos[i];
    var gate = info.gate || { kind: 'timer', target: '', threshold: 12 };
    var phaseName = 'Phase' + (i + 1);
    var asset = path.join(dir, phaseName + '.asset');
    var guid = writeDeterministicAssetMeta(asset, info.phaseId);
    var spawnLines = [];
    (info.spawnEntities || []).forEach(function(name) {
      spawnLines.push('  - ' + name);
    });
    var yaml = [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!114 &11400000',
      'MonoBehaviour:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_PrefabInstance: {fileID: 0}',
      '  m_PrefabAsset: {fileID: 0}',
      '  m_GameObject: {fileID: 0}',
      '  m_Enabled: 1',
      '  m_EditorHideFlags: 0',
      '  m_Script: {fileID: 11500000, guid: ' + phaseGuid + ', type: 3}',
      '  m_Name: ' + phaseName,
      '  m_EditorClassIdentifier: ',
      '  mPhaseId: ' + info.phaseId,
      '  mGuideText: "' + csString(info.title) + '"',
      '  mTargetEntity: "' + csString(info.targetEntity || '') + '"',
      '  mTargetCount: ' + (gate.kind === 'entity_count' ? gate.threshold : 0),
      '  mResourceKey: "' + csString(gate.kind === 'resource' ? gate.target : '') + '"',
      '  mResourceThreshold: ' + (gate.kind === 'resource' ? gate.threshold : 0),
      '  IsDamage: 0',
      '  mMinSeconds: 12',
      '  mSpawnEntities:' + (spawnLines.length ? '' : ' []')
    ].concat(spawnLines).concat([
      '  mHideEntities: []',
      '  mGate:',
      '    mKind: ' + phaseGateKindEnumValue(gate.kind),
      '    mTarget: "' + csString(gate.target || '') + '"',
      '    mThreshold: ' + (gate.threshold || 0),
      ''
    ]).join('\n');
    fs.writeFileSync(asset, yaml);
    if (guid) count++;
  }
  return count;
}

function splitMainManagerForV12(root, visualHints) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var mainFile = path.join(scriptsRoot, 'MainManager.cs');
  if (!fs.existsSync(mainFile)) return { changedFiles: 0, runtimeFiles: 0, phaseAssets: 0, spawnWrappersRemoved: 0 };
  var code = fs.readFileSync(mainFile, 'utf8');
  var classRe = /\bpublic\s+class\s+MainManager\s*:\s*MonoSingleton<MainManager>\s*\{/m;
  var match = classRe.exec(code);
  if (!match) return { changedFiles: 0, runtimeFiles: 0, phaseAssets: 0, spawnWrappersRemoved: 0 };
  var openIdx = match.index + match[0].lastIndexOf('{');
  var closeIdx = findMatchingBrace(code, openIdx);
  if (closeIdx < 0) return { changedFiles: 0, runtimeFiles: 0, phaseAssets: 0, spawnWrappersRemoved: 0 };
  var body = code.slice(openIdx + 1, closeIdx);
  var phaseIds = collectPhaseIdsFromRuntime(body);
  var entityIds = collectDeliveryEntityIds(code);
  var phaseInfos = parsePhaseDeliveryInfo(code, phaseIds, entityIds);
  var phaseGates = parsePhaseGateInfo(code, phaseIds, entityIds);
  phaseInfos.forEach(function(info) {
    info.gate = phaseGates[info.phaseId] || { kind: 'timer', target: '', threshold: 12 };
    if (info.gate.target) {
      info.targetEntity = info.gate.target;
      if ((info.spawnEntities || []).indexOf(info.gate.target) < 0) info.spawnEntities.push(info.gate.target);
    }
  });
  var spawn = replaceSpawnWrappers(body);

  removeIfExists(mainFile);
  removeIfExists(mainFile + '.meta');
  [
    'PhaseController.cs',
    'EntityBindingManager.cs',
    'AutoPlayDriver.cs',
    'HudController.cs',
    'EventRuleEngine.cs',
    'LevelRuleEngine.cs',
    'GMP_MainManager.cs',
    'GMP_PhaseController.cs',
    'GMP_EntityBindingManager.cs',
    'GMP_AutoPlayDriver.cs',
    'GMP_HudController.cs',
    'GMP_EventRuleEngine.cs',
    'GMP_LevelRuleEngine.cs',
    'GMP_LevelEventNames.cs',
    'GMP_PhasePreset.cs',
    'GMP_PhaseGate.cs'
  ].forEach(function(name) {
    removeIfExists(path.join(scriptsRoot, name));
    removeIfExists(path.join(scriptsRoot, name + '.meta'));
  });
  walkFiles(scriptsRoot).forEach(function(file) {
    var base = path.basename(file);
    if (/\.Part\d*\.cs(?:\.meta)?$/.test(base) || /(?:Runtime|Facade)\.cs(?:\.meta)?$/.test(base)) removeIfExists(file);
  });

  var managerDir = path.join(scriptsRoot, 'Manager');
  writeGeneratedCs(path.join(managerDir, 'GMP_MainManager.cs'), buildThinMainManagerCode());
  writeGeneratedCs(path.join(managerDir, 'GMP_PhaseController.cs'), buildPhaseControllerCode());
  writeGeneratedCs(path.join(managerDir, 'GMP_EntityBindingManager.cs'), buildEntityBindingManagerCode(entityIds, visualHints));
  writeGeneratedCs(path.join(managerDir, 'GMP_AutoPlayDriver.cs'), buildAutoPlayDriverCode());
  writeGeneratedCs(path.join(managerDir, 'GMP_HudController.cs'), buildHudControllerCode());
  writeGeneratedCs(path.join(managerDir, 'GMP_LevelRuleEngine.cs'), buildLevelRuleEngineCode());
  writeGeneratedCs(path.join(managerDir, 'GMP_LevelEventNames.cs'), buildLevelEventNamesCode());
  var phaseAssets = emitPhasePresetAssets(root, phaseInfos);
  return {
    changedFiles: 9 + phaseAssets,
    runtimeFiles: 0,
    phaseAssets: phaseAssets,
    spawnWrappersRemoved: spawn.removed
  };
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
  var isV14Layout = fs.existsSync(path.join(root, 'Assets', 'Scripts', 'Core'))
    && fs.existsSync(path.join(root, 'Assets', 'Scripts', 'Game'));
  var managerPath = isV14Layout ? 'Assets/Scripts/Core/Modules' : (managerDir ? relativeUnix(root, managerDir) : 'Assets/Scripts/Manager');
  var scriptsRoot = managerDir && isReferenceScriptsManagerDir(managerDir) ? path.dirname(managerDir) : null;
  var commonPath = isV14Layout ? 'Assets/Scripts/Core/Common' : (scriptsRoot ? relativeUnix(root, path.join(scriptsRoot, 'Common')) : 'Assets/Program/Script/Commons');
  var entityPath = isV14Layout ? 'Assets/Scripts/Game/Entities' : (managerDir ? relativeUnix(root, resolveEntityDir(managerDir)) : 'Assets/Scripts/Entities');
  var isReferenceMainManager = managerDir
    && isReferenceScriptsLayout(managerDir)
    && (fs.existsSync(path.join(managerDir, 'GMP_MainManager.cs')) || fs.existsSync(path.join(managerDir, 'MainManager.cs')));
  var boundary = isV14Layout ? [
    '## 程序员交付边界',
    '',
    '- `Assets/Scripts/` 顶层只保留 `Core` / `Tool` / `Game` 三个目录；每个游戏只在 `Game` 里写具体业务逻辑。',
    '- `Assets/Scripts/Core/Base/` 放 `MonoSingleton`、核心 enum、实体/玩家/NPC 基类；继承深度控制在简单可读范围。',
    '- `Assets/Scripts/Core/Components/` 放 `GMP_MovementComponent`、`GMP_TriggerComponent`、`GMP_InteractionComponent`、`GMP_InventoryComponent`、`GMP_SkillComponent` 等可复用能力。',
    '- `Assets/Scripts/Core/Modules/` 放 `GMP_MainManager.cs` 主管理器和通用模块，包括 Phase、Event、Pool、Audio、Economy、UI；Core 不写具体关卡事件名。',
    '- `Assets/Scripts/Tool/` 放相机、UI、视觉引导等跨项目工具。',
    '- `Assets/Scripts/Game/Level/` 放关卡流程与业务规则，`Assets/Scripts/Game/Entities/` 放本游戏具体实体，`Assets/Scripts/Game/Player/` 放本游戏 Player。',
    '- `Assets/Scripts/Game/Phases/` 中的 Phase asset 使用 `GMP_PhaseGateKind` enum 数值，禁止回退到字符串 gate。',
    ''
  ].join('\n') : (isReferenceMainManager ? [
    '## 程序员交付边界',
    '',
    '- `GMP_MainManager.cs` 是 Unity 生命周期入口、主 `Update()` 和阶段调度的单文件入口，继承 `MonoSingleton<GMP_MainManager>`。',
    '- `MonoSingleton.cs` 提供参考工程同款 `instance` 访问方式，场景中只挂一个主入口实例。',
    '- `Game.unity` 已预挂 `GMP_MainManager` 与关键 GMP 管理器对象，脚本物体不再由代码运行时创建。',
    '- `' + entityPath + '/` 中的实体类承载领域属性，例如 `GMP_BaseBuildElement`、`GMP_BuildEntity`、`GMP_BarrackEntity`。',
    '- 新增建筑、兵营、炮塔、资源、战斗单位时，优先新增或扩展 `Entities/` 下的具体类。',
    '- 参考工程式脚本布局：`' + managerPath + '/` 放 `GMP_MainManager.cs`、`MonoSingleton.cs`，`Manager/`、`Player/`、`UI/`、`Audio/`、`Common/` 按职责归类工具脚本，`' + entityPath + '/` 放领域对象。',
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
  ].join('\n'));
  text = text.replace(
    /- Assets\/Program\/Script\/Manager\/\s+—[^\n]*/g,
    '- ' + managerPath + '/  — ' + (isV14Layout ? 'GMP_MainManager、Phase、Event、UI、Economy 等核心模块' : (isReferenceMainManager ? 'GMP_MainManager.cs 单文件主入口' : 'GameFlowManagerMain.cs 主入口与 Flow/Input/Resource/UI/Scene partial 拆分'))
  );
  text = text.replace(
    /- Assets\/Scripts\/Manager\/\s+—[^\n]*/g,
    '- ' + (isV14Layout ? 'Assets/Scripts/' : managerPath + '/') + '  — ' + (isV14Layout ? 'Core / Tool / Game 三层程序员交付结构' : (isReferenceMainManager ? 'GMP_MainManager.cs 单文件主入口' : 'GameFlowManagerMain.cs 主入口与 Flow/Input/Resource/UI/Scene partial 拆分'))
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
  var isV14Layout = fs.existsSync(path.join(root, 'Assets', 'Scripts', 'Core'))
    && fs.existsSync(path.join(root, 'Assets', 'Scripts', 'Game'));
  var entityDirText = isV14Layout ? 'Assets/Scripts/Game/Entities' : (summary.entityDir ? relativeUnix(root, summary.entityDir) : 'Assets/Scripts/Entities');
  var managerDirText = isV14Layout ? 'Assets/Scripts/Core/Modules' : (summary.managerDir ? relativeUnix(root, summary.managerDir) : 'Assets/Scripts/Manager');
  var referenceMain = !!summary.referenceMainManager || isV14Layout;
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
    isV14Layout
      ? '- 将脚本重切为 `Assets/Scripts/Core` / `Assets/Scripts/Tool` / `Assets/Scripts/Game` 三层，Core/Tool 保持通用，Game 承载本项目业务。'
      : (referenceMain
      ? '- 合并 Blueprint 构建期 `GameFlowManagerMain*.cs` partial，交付为参考工程式 `GMP_MainManager.cs` 单文件入口。'
      : '- 保留 `GameFlowManagerMain` 5 个 partial 拆分（`GameFlowManagerMain.cs` + `Flow/Input/Resource/UI/Scene`）；不再合并到单一类，也不再生成 `GameFlow*Base.cs` 横切继承链。'),
    '- 移除默认关闭的生成遗留路径，避免程序员维护死代码。',
    isV14Layout
      ? '- 生成 `' + entityDirText + '/` 本项目具体实体类，具体实体直接继承 Core 基类，可复用能力通过 Core/Components 组合。'
      : '- 生成 `' + entityDirText + '/` 领域类：`BaseGameFlowEntity` 承载绑定、命名、可见性和位移等通用属性，具体实体类直接继承基类。',
    '',
    '## 后续维护建议',
    isV14Layout
      ? '- v14 入口目录：`' + managerDirText + '/` 放主管理器和核心模块；`Assets/Scripts/Game/Level/` 放关卡流程；`' + entityDirText + '/` 放本项目实体。'
      : '- 参考工程式入口目录：`' + managerDirText + '/` 放 Manager 主流程；`' + entityDirText + '/` 放领域对象；UI/Player 相关脚本后续优先进入同级 `UI/`、`Player/` 目录。',
    isV14Layout
      ? '- 玩法主流程从 `GMP_MainManager.cs`、`GMP_PhaseController.cs` 和 `Game/Level/GMP_LevelRuleEngine.cs` 开始阅读；字段统一采用 `mXxx` 命名，bool 字段采用 `IsXxx`。'
      : (referenceMain
      ? '- 玩法主流程从 `GMP_MainManager.cs` 的 `Start()`、`Update()`、`CheckEventRules()` 开始阅读；字段统一采用 `mXxx` 命名，bool 字段采用 `IsXxx`。'
      : '- 玩法主流程从 `GameFlowManagerMain.cs` 的 `Start()`、`Update()`、`CheckEventRules()` 开始阅读，按职责进入对应 partial：' + partialListText + '。'),
    isV14Layout
      ? '- 新增业务逻辑优先写入 `Assets/Scripts/Game/`；只有多个项目可复用的能力才下沉到 `Core/Components` 或 `Tool`。'
      : (referenceMain
      ? '- 新增主流程逻辑时优先在 `GMP_MainManager.cs` 内按阶段/系统分段组织，不再新增 `GameFlowManagerMain.*.cs` companion 文件。'
      : '- 不要把功能再塞回 `GameFlowManagerMain.cs`：流程进 `Flow.cs`、输入进 `Input.cs`、资源进 `Resource.cs`、界面进 `UI.cs`、场景进 `Scene.cs`。'),
    isV14Layout
      ? '- Player/实体通过 Movement、Trigger、Interaction、Inventory、Skill 等组件组合能力，不再用 Build/Resource/Combat 多层继承表达一次性玩法。'
      : '- 建筑、资源、战斗单位等领域属性优先放在 `Entities/` 下的具体类，不要再用 partial 文件承载领域对象。',
    '- `GMP_*.cs` 是通用工具库；业务逻辑优先写在 Game/Level 或实体领域类中，不要直接改工具库公共行为。',
    '',
    '## 清理统计',
    '- C# 文件处理数：' + summary.csFiles,
    '- 修改的 C# 文件数：' + summary.changedFiles,
    '- 保留的 GameFlowManagerMain partial 文件数：' + keptCount,
    '- 清理的 GameFlow*Base 残留文件数：' + staleBaseRemoved,
    '- ' + (referenceMain ? 'GMP_MainManager.cs' : 'GameFlowManagerMain.cs') + ' 行数：' + mainLines,
    '- ' + (referenceMain ? 'GMP_MainManager.cs' : '最长 partial 文件') + ' 行数：' + maxPartialLines,
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
    '- MainManager 运行时代码拆分文件数：' + (summary.runtimeSplitFiles || 0),
    '- 生成 GMP_PhasePreset 资产数：' + (summary.phasePresetAssets || 0),
    '- 移除 SpawnXxx wrapper 数：' + (summary.spawnWrappersRemoved || 0),
    '- 统一 GMP_ 类名前缀数：' + (summary.prefixedClasses || 0),
    '- v14 架构迁移移动脚本数：' + (summary.v14ArchitectureMovedFiles || 0),
    '- v14 Player 组件接线完成：' + (summary.v14PlayerComponentsWired ? '是' : '否'),
    '- 移除 UnusedSceneModel 场景对象数：' + (summary.unusedSceneModelsRemoved || 0),
    '- Phase1 初始可见实体数：' + (summary.initialPhaseEntities || 0),
    '- Phase1 初始落位 Transform 数：' + (summary.initialPhaseEntitiesPositioned || 0),
    '- Phase1 主相机取景已调整：' + (summary.initialPhaseCameraFramed ? '是' : '否'),
    '- Player 对象已标记 Player tag 用于镜头跟随：' + (summary.playerTaggedForCameraFollow ? '是' : '否'),
    '- 交付版镜头保留源首帧并跟随 Player：' + (summary.deliveryCameraControllerFollowRepaired ? '是' : '否'),
    '- 源场景背景/雾/地面色已同步：' + (summary.sceneContractApplied ? '是' : '否'),
    '- 生成 fallback 材质数：' + (summary.fallbackMaterialsGenerated || 0),
    '- 注入摇杆 UI 对象数：' + (summary.joystickObjectsInjected || 0),
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

function normalizeScriptFilesForDelivery(scriptsRoot) {
  var summary = { changedFiles: 0, methodCommentsInserted: 0 };
  if (!fs.existsSync(scriptsRoot)) return summary;
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
  return summary;
}

function normalizeProgrammerDeliveryScripts(root, project) {
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

  var firstPass = normalizeScriptFilesForDelivery(scriptsRoot);
  summary.changedFiles += firstPass.changedFiles;
  summary.methodCommentsInserted += firstPass.methodCommentsInserted;

  var visualHints = readVisualHints(root, project || {});
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

  var splitSummary = splitMainManagerForV12(root, visualHints);
  summary.runtimeSplitFiles = splitSummary.runtimeFiles;
  summary.phasePresetAssets = splitSummary.phaseAssets;
  summary.spawnWrappersRemoved = splitSummary.spawnWrappersRemoved;
  if (splitSummary.changedFiles) summary.changedFiles += splitSummary.changedFiles;

  var prefixSummary = prefixNonGmpClassNames(scriptsRoot);
  summary.prefixedClasses = Object.keys(prefixSummary.classMap || {}).length;
  summary.prefixedClassFilesRenamed = prefixSummary.renamed || 0;
  if (prefixSummary.changedFiles || prefixSummary.renamed) summary.changedFiles += (prefixSummary.changedFiles || 0) + (prefixSummary.renamed || 0);

  var generatedPass = normalizeScriptFilesForDelivery(scriptsRoot);
  summary.changedFiles += generatedPass.changedFiles;
  summary.methodCommentsInserted += generatedPass.methodCommentsInserted;

  var architectureSummary = applyV14Architecture(root, visualHints);
  summary.v14ArchitectureMovedFiles = architectureSummary.movedFiles || 0;
  summary.v14ArchitectureChangedFiles = architectureSummary.changedFiles || 0;
  summary.v14SingletonBaseRemoved = architectureSummary.singletonBaseRemoved || 0;
  summary.v14PlayerComponentsWired = !!architectureSummary.playerComponentsWired;
  summary.deliveryCameraControllerFollowRepaired = !!architectureSummary.deliveryCameraControllerFollowRepaired;
  if (architectureSummary.changedFiles || architectureSummary.movedFiles) {
    summary.changedFiles += (architectureSummary.changedFiles || 0) + (architectureSummary.movedFiles || 0);
  }

  var stripSummary = stripUnusedSceneModels(root);
  summary.unusedSceneModelsRemoved = stripSummary.removedGameObjects || 0;
  summary.unusedSceneModelBlocksRemoved = stripSummary.removedBlocks || 0;
  if (stripSummary.removedBlocks) summary.changedFiles++;

  var initialSceneSummary = materializeInitialPhaseScene(root, visualHints);
  summary.initialPhaseEntities = initialSceneSummary.phaseEntities || 0;
  summary.initialPhaseEntitiesPositioned = initialSceneSummary.positioned || 0;
  summary.initialPhaseEntitiesMissing = initialSceneSummary.missing || 0;
  summary.initialPhaseCameraFramed = !!initialSceneSummary.cameraFramed;
  if (initialSceneSummary.positioned || initialSceneSummary.cameraFramed) summary.changedFiles++;

  summary.playerTaggedForCameraFollow = tagPlayerEntityInScene(root);
  if (summary.playerTaggedForCameraFollow) summary.changedFiles++;

  var sceneContractSummary = applySceneContract(root, visualHints);
  summary.sceneContractApplied = !!sceneContractSummary.applied;
  summary.sceneContractGroundColor = !!sceneContractSummary.groundColor;
  summary.sceneContractFog = !!sceneContractSummary.fog;
  if (sceneContractSummary.applied) summary.changedFiles++;

  var sourcePrimitiveSummary = materializeSourceEntityPrimitives(root, visualHints);
  summary.sourcePrimitiveEntityCount = sourcePrimitiveSummary.entityCount || 0;
  summary.sourcePrimitiveRendererCount = sourcePrimitiveSummary.primitiveCount || 0;
  summary.sourcePrimitiveManifestSource = sourcePrimitiveSummary.manifestSource || '';
  summary.sourcePrimitiveScriptsWritten = sourcePrimitiveSummary.primitiveScriptsWritten || 0;
  if (sourcePrimitiveSummary.primitiveCount || sourcePrimitiveSummary.rendererRootsRemoved || sourcePrimitiveSummary.primitiveScriptsWritten) summary.changedFiles++;

  var sceneObjectSummary = materializeSceneContractObjects(root, visualHints);
  summary.sceneContractObjectsInjected = sceneObjectSummary.injected || 0;
  summary.sceneContractStarCount = sceneObjectSummary.starCount || 0;
  summary.sceneContractOrbitalRingCount = sceneObjectSummary.ringCount || 0;
  if (sceneObjectSummary.injected) summary.changedFiles++;

  var materialSummary = emitFallbackMaterials(root, visualHints);
  summary.fallbackMaterialsGenerated = materialSummary.generated || 0;
  summary.fallbackMaterialMissingGuidCount = materialSummary.missing || 0;
  summary.fallbackMaterialShaderMissing = !!materialSummary.shaderMissing;
  if (materialSummary.generated) summary.changedFiles += materialSummary.generated;

  var joystickSummary = injectJoystickSceneObjects(root);
  summary.joystickObjectsInjected = joystickSummary.injected || 0;
  summary.joystickObjectsPresent = !!joystickSummary.present;
  if (joystickSummary.injected) summary.changedFiles += joystickSummary.injected;

  var hudTextSummary = injectHudTextSceneObjects(root, visualHints);
  summary.hudTextObjectsInjected = hudTextSummary.injected || 0;
  summary.hudTextObjectsPresent = !!hudTextSummary.present;
  summary.hudTextSlotCount = hudTextSummary.slotCount || 0;
  if (hudTextSummary.injected) summary.changedFiles += hudTextSummary.injected;

  var sceneSummary = injectSceneMountedScriptObjects(root);
  summary.sceneObjectsInjected = sceneSummary.injected;
  summary.sceneObjectNames = sceneSummary.names;

  var legacySceneScriptSummary = repairLegacySceneScriptReferences(root);
  summary.legacySceneScriptActivatorRefsRemapped = legacySceneScriptSummary.scriptActivatorRemapped || 0;
  summary.legacyPlaceholderScriptsRemoved = legacySceneScriptSummary.placeholderScriptsRemoved || 0;
  if (legacySceneScriptSummary.scriptActivatorRemapped || legacySceneScriptSummary.placeholderScriptsRemoved) summary.changedFiles++;
  var packageSceneScriptSummary = repairKnownPackageSceneScriptReferences(root);
  summary.knownPackageSceneScriptRefsRemapped = packageSceneScriptSummary.remapped || 0;
  if (packageSceneScriptSummary.remapped) summary.changedFiles++;
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

  var normalizeSummary = normalizeProgrammerDeliveryScripts(root, options.project || {});
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
  summary.runtimeSplitFiles = normalizeSummary.runtimeSplitFiles || 0;
  summary.phasePresetAssets = normalizeSummary.phasePresetAssets || 0;
  summary.spawnWrappersRemoved = normalizeSummary.spawnWrappersRemoved || 0;
  summary.prefixedClasses = normalizeSummary.prefixedClasses || 0;
  summary.prefixedClassFilesRenamed = normalizeSummary.prefixedClassFilesRenamed || 0;
  summary.unusedSceneModelsRemoved = normalizeSummary.unusedSceneModelsRemoved || 0;
  summary.unusedSceneModelBlocksRemoved = normalizeSummary.unusedSceneModelBlocksRemoved || 0;
  summary.initialPhaseEntities = normalizeSummary.initialPhaseEntities || 0;
  summary.initialPhaseEntitiesPositioned = normalizeSummary.initialPhaseEntitiesPositioned || 0;
  summary.initialPhaseEntitiesMissing = normalizeSummary.initialPhaseEntitiesMissing || 0;
  summary.initialPhaseCameraFramed = normalizeSummary.initialPhaseCameraFramed || false;
  summary.playerTaggedForCameraFollow = normalizeSummary.playerTaggedForCameraFollow || false;
  summary.sceneContractApplied = normalizeSummary.sceneContractApplied || false;
  summary.sceneContractGroundColor = normalizeSummary.sceneContractGroundColor || false;
  summary.sceneContractFog = normalizeSummary.sceneContractFog || false;
  summary.sourcePrimitiveEntityCount = normalizeSummary.sourcePrimitiveEntityCount || 0;
  summary.sourcePrimitiveRendererCount = normalizeSummary.sourcePrimitiveRendererCount || 0;
  summary.sourcePrimitiveManifestSource = normalizeSummary.sourcePrimitiveManifestSource || '';
  summary.sourcePrimitiveScriptsWritten = normalizeSummary.sourcePrimitiveScriptsWritten || 0;
  summary.sceneContractObjectsInjected = normalizeSummary.sceneContractObjectsInjected || 0;
  summary.sceneContractStarCount = normalizeSummary.sceneContractStarCount || 0;
  summary.sceneContractOrbitalRingCount = normalizeSummary.sceneContractOrbitalRingCount || 0;
  summary.fallbackMaterialsGenerated = normalizeSummary.fallbackMaterialsGenerated || 0;
  summary.fallbackMaterialMissingGuidCount = normalizeSummary.fallbackMaterialMissingGuidCount || 0;
  summary.fallbackMaterialShaderMissing = normalizeSummary.fallbackMaterialShaderMissing || false;
  summary.joystickObjectsInjected = normalizeSummary.joystickObjectsInjected || 0;
  summary.joystickObjectsPresent = normalizeSummary.joystickObjectsPresent || false;
  summary.hudTextObjectsInjected = normalizeSummary.hudTextObjectsInjected || 0;
  summary.hudTextObjectsPresent = normalizeSummary.hudTextObjectsPresent || false;
  summary.hudTextSlotCount = normalizeSummary.hudTextSlotCount || 0;
  summary.v14ArchitectureMovedFiles = normalizeSummary.v14ArchitectureMovedFiles || 0;
  summary.v14ArchitectureChangedFiles = normalizeSummary.v14ArchitectureChangedFiles || 0;
  summary.v14SingletonBaseRemoved = normalizeSummary.v14SingletonBaseRemoved || 0;
  summary.v14PlayerComponentsWired = normalizeSummary.v14PlayerComponentsWired || false;
  summary.deliveryCameraControllerFollowRepaired = normalizeSummary.deliveryCameraControllerFollowRepaired || false;
  summary.legacySceneScriptActivatorRefsRemapped = normalizeSummary.legacySceneScriptActivatorRefsRemapped || 0;
  summary.legacyPlaceholderScriptsRemoved = normalizeSummary.legacyPlaceholderScriptsRemoved || 0;
  summary.knownPackageSceneScriptRefsRemapped = normalizeSummary.knownPackageSceneScriptRefsRemapped || 0;
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
