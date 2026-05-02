/**
 * Delivery class validator — non-blocking warnings for programmer delivery output.
 *
 * 反馈 01 (2026-04-26) Phase B.1:覆盖反馈条 4/5/6 中"GameFlowManagerMain 单文件过大、
 * HandlePlayerInteractions 单方法过长 / 嵌套判断过多"等 anti-pattern。
 *
 * 仅产出 warning,不阻塞交付流程;阈值可通过 opts.thresholds 覆盖。
 */
var fs = require('fs');
var path = require('path');
var { findMatchingBrace } = require('../lib/programmer-delivery-cleaner.cjs');

var DEFAULT_THRESHOLDS = {
  // 文件行数软上限。programmer-delivery-cleaner.cjs 现有硬约定是 1000 行,
  // 800 给一段缓冲空间,让作者在突破硬上限前先看到信号。
  fileLines: 800,
  // 单方法体行数软上限。100 行以上的方法基本都包含多职责或大量分支。
  methodLines: 100,
  // 控制流嵌套深度软上限。5 层以上的 if/switch/for/foreach 通常指示
  // HandlePlayerInteractions-类的判断逻辑应被拆成小方法 (反馈条 6)。
  nestingDepth: 5,
  // 反馈 01 #2 (2026-05-02) Wave B:条件分支注释覆盖率检查的最小块行数。
  // 单行 `if (x) Foo();` 或 2 行小 if 不强制注释,避免噪声;>=3 行才查。
  conditionMinBlockLines: 3,
};

/**
 * 提取所有方法定义,返回 {name, openIdx, closeIdx, body, line} 列表。
 * 复用 method-check.cjs 的签名识别风格 + cleaner 的字符串/注释感知 brace 匹配。
 *
 * 显式过滤构造器 (name == class/struct/record name) 和对象初始化器
 * (`new Helper() { A = 1 }`),避免对数据初始化或类型声明误报方法警告。
 * 漏识别 expression-bodied (`Foo() => ...`) 是有意为之 — 这类必短无须警告。
 */
function findMethods(code) {
  // 先收集本文件声明的类型名,用来过滤构造器
  var classNames = Object.create(null);
  var classRe = /\b(?:class|struct|interface|record|enum)\s+([A-Z_]\w*)/g;
  var cm;
  while ((cm = classRe.exec(code)) !== null) classNames[cm[1]] = true;

  var methods = [];
  var re = /(?:void|int|float|bool|string|double|long|char|IEnumerator|FormDef|ResourceDef|\w+[\[\]<>]*)\s+([A-Z_]\w*)\s*\([^)]*\)/g;
  var m;
  while ((m = re.exec(code)) !== null) {
    var name = m[1];
    // 构造器: 名字与本文件某个 class/struct/record 同名 — 跳过 (虽然长构造器也是 smell,
    // 但语义上不是 method,标签会让 warning 看着像 "类名作为方法名出错";后续如要覆盖
    // 可作为单独规则 delivery-ctor-length)
    if (classNames[name]) continue;
    // 对象初始化器: `new Helper() { A = 1 }` — 此时 m[0] 形如 "new Helper()",
    // 直接看 m[0] 是否以 "new " 开头即可跳过 (m[0] 的"返回类型"位置就是 "new")
    if (/^new\s+/.test(m[0])) continue;

    var sigEnd = m.index + m[0].length;
    var braceIdx = code.indexOf('{', sigEnd);
    if (braceIdx < 0) continue;
    var between = code.slice(sigEnd, braceIdx);
    // 抽象/接口声明 (`...);`) 或表达式体 (`... =>`) 不是方法体,跳过
    if (/;|=>/.test(between)) continue;
    var closeIdx = findMatchingBrace(code, braceIdx);
    if (closeIdx < 0) continue;
    var line = code.slice(0, m.index).split('\n').length;
    methods.push({
      name: name,
      openIdx: braceIdx,
      closeIdx: closeIdx,
      body: code.slice(braceIdx + 1, closeIdx),
      line: line,
    });
  }
  return methods;
}

/**
 * 计算代码块内的最大花括号嵌套深度,跳过字符串/注释/字符字面量。
 * 与 cleaner.cjs 的 findMatchingBrace 用相同的 mode-machine。
 */
function maxNestingDepth(body) {
  var depth = 0;
  var maxDepth = 0;
  var mode = 'code';
  var verbatim = false;
  for (var i = 0; i < body.length; i++) {
    var c = body[i];
    var next = body[i + 1];
    if (mode === 'lineComment') {
      if (c === '\n') mode = 'code';
      continue;
    }
    if (mode === 'blockComment') {
      if (c === '*' && next === '/') { mode = 'code'; i++; }
      continue;
    }
    if (mode === 'string') {
      if (verbatim && c === '"' && next === '"') i++;
      else if (c === '"') { mode = 'code'; verbatim = false; }
      else if (!verbatim && c === '\\') i++;
      continue;
    }
    if (mode === 'char') {
      if (c === '\\') i++;
      else if (c === "'") mode = 'code';
      continue;
    }
    if (c === '/' && next === '/') { mode = 'lineComment'; i++; continue; }
    if (c === '/' && next === '*') { mode = 'blockComment'; i++; continue; }
    if (c === '@' && next === '"') { mode = 'string'; verbatim = true; i++; continue; }
    if (c === '"') { mode = 'string'; verbatim = false; continue; }
    if (c === "'") { mode = 'char'; continue; }
    if (c === '{') { depth++; if (depth > maxDepth) maxDepth = depth; }
    if (c === '}') { depth--; }
  }
  return maxDepth;
}

// ---------------------------------------------------------------------------
// 反馈 01 #1 / #2 (2026-05-02) Wave B — 注释覆盖率
//
// 反馈条 1:每个变量名/方法都要详细注释。
// 反馈条 2:每种条件也必须有详细注释。
//
// 实现思路:
//   - findFields:抓 `(public|private|protected|internal) [static] [readonly] Type Name;` 形式的字段。
//     不查 local var、property 自动 getter/setter(它们要么短命要么自带语义),也不查 const(命名通常自解释)。
//   - findConditions:抓 if / else if / switch case 块。conditionMinBlockLines 之内的小块跳过,
//     避免对 `if (x == null) return;` 这种 trivially small 的 guard 喷警告。
//   - hasCommentAbove(lines, lineIdx1Based):往上找第一非空行,判断是否 `//` / `///` 起头。
//     同时支持同行尾注释:lines[lineIdx-1] 在第一段非字符串 token 后含 `//`。
//
// 三类规则(都是 warning,不阻塞):
//   - delivery-comment-coverage-field
//   - delivery-comment-coverage-method
//   - delivery-comment-coverage-condition
// ---------------------------------------------------------------------------

// 字段声明粗匹配:`(public|private|protected|internal) [modifier...] Type Name [;|=]`。
// 故意宽松:把伪装成字段的方法也匹配,后面用方法识别去重。
function findFields(code) {
  var fields = [];
  // (修饰符) (Type 含泛型/数组) (Name) (= 或 ;)
  // Type 以大写字母 / 关键字 / 内置类型起头。
  var re = /(public|private|protected|internal)\s+(?:(?:static|readonly|const|new|virtual|override|abstract|sealed|extern)\s+)*([A-Za-z_][\w<>?,\[\]\s\.]*?)\s+([A-Z_]\w*)\s*[;=]/g;
  var methodNames = Object.create(null);
  findMethods(code).forEach(function(m) { methodNames[m.name] = true; });
  // 类/结构体名也跳过(避免把 `public class Foo` 之类匹进字段)
  var classNames = Object.create(null);
  var classRe = /\b(?:class|struct|interface|record|enum)\s+([A-Z_]\w*)/g;
  var cm;
  while ((cm = classRe.exec(code)) !== null) classNames[cm[1]] = true;

  var m;
  while ((m = re.exec(code)) !== null) {
    var typeStr = m[2].trim();
    var name = m[3];
    if (methodNames[name]) continue;
    if (classNames[name]) continue;
    // Type 包含 class/struct/interface/enum 关键字 → 是类声明,不是字段
    if (/\b(?:class|struct|interface|enum|record|namespace|using|return|throw|new)\b/.test(typeStr)) continue;
    // Type 以小写字母开头但不是内置原语 → 大概率是变量/赋值表达式而不是字段
    var line = code.slice(0, m.index).split('\n').length;
    fields.push({ name: name, type: typeStr, line: line, idx: m.index });
  }
  return fields;
}

// 找 if / else if / switch case 块,只回传体积 >= conditionMinBlockLines 的。
// 内联 `if (x) return;` 跳过 — 那种 guard 太常见,强制注释会噪声炸场。
function findConditions(code, minBlockLines) {
  var out = [];
  var re = /\b(if|else\s+if|switch|case\b[^:\n]*:)/g;
  var m;
  while ((m = re.exec(code)) !== null) {
    var kind = m[1].replace(/\s+/g, ' ');
    var startIdx = m.index;
    var lineNo = code.slice(0, startIdx).split('\n').length;
    var blockLines = 1;
    if (kind.indexOf('case') === 0) {
      // case 块体积 = 到下一个 case/default/} 为止的行数
      var rest = code.slice(startIdx + m[0].length);
      var stop = rest.search(/\b(?:case\b|default\s*:)|\}/);
      blockLines = stop > 0 ? rest.slice(0, stop).split('\n').length : 1;
    } else {
      // if/else if/switch:找匹配的右括号 `)`,再看下一个非空字符是不是 `{`
      var parenStart = code.indexOf('(', startIdx);
      if (parenStart < 0) continue;
      var pdepth = 0;
      var parenEnd = -1;
      for (var i = parenStart; i < code.length; i++) {
        if (code[i] === '(') pdepth++;
        else if (code[i] === ')') { pdepth--; if (pdepth === 0) { parenEnd = i; break; } }
      }
      if (parenEnd < 0) continue;
      // 跳过空白找下一个有意义字符
      var j = parenEnd + 1;
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] !== '{') continue; // 内联或单语句,跳过
      var closeIdx = findMatchingBrace(code, j);
      if (closeIdx < 0) continue;
      blockLines = code.slice(j, closeIdx).split('\n').length;
    }
    if (blockLines < minBlockLines) continue;
    out.push({ kind: kind, line: lineNo, idx: startIdx, blockLines: blockLines });
  }
  return out;
}

// 检查 lineIdx (1-based) 上方是否有紧邻的 // 或 /// 注释行,或同行尾有 //。
function hasCommentAbove(lines, lineIdx1) {
  var sameLine = lines[lineIdx1 - 1] || '';
  // 同行尾注释:粗暴检测 `//`,过滤掉字符串里的(简化,假设交付代码不会在 if 行写大字符串)
  var slashIdx = sameLine.indexOf('//');
  if (slashIdx >= 0) {
    var prefix = sameLine.slice(0, slashIdx);
    var quotes = prefix.split('"').length - 1;
    if (quotes % 2 === 0) return true;
  }
  // 往上找第一个非空白行
  for (var i = lineIdx1 - 2; i >= 0; i--) {
    var ln = (lines[i] || '').trim();
    if (ln === '') continue;
    if (ln.indexOf('//') === 0) return true;          // // 普通注释
    if (ln.indexOf('///') === 0) return true;         // /// XML doc
    if (/\*\/\s*$/.test(ln)) return true;             // */ 块注释结尾
    return false;
  }
  return false;
}

function findMatchingBrace(code, openIdx) {
  // 只在本模块内部用;cleaner 已经导出但有循环依赖风险时本地实现一份。
  var depth = 0;
  for (var i = openIdx; i < code.length; i++) {
    var c = code[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function validateCommentCoverage(code, fileName, thresholds) {
  var warnings = [];
  var lines = code.split('\n');
  var minBlock = (thresholds && thresholds.conditionMinBlockLines) || 3;

  findFields(code).forEach(function(f) {
    if (!hasCommentAbove(lines, f.line)) {
      warnings.push({
        rule: 'delivery-comment-coverage-field',
        severity: 'warning',
        file: fileName,
        line: f.line,
        message: fileName + ':' + f.line + ' 字段 ' + f.name + ' 缺中文注释 — 反馈条 1 要求每个变量都标注用途。',
        details: { field: f.name, type: f.type },
      });
    }
  });

  findMethods(code).forEach(function(meth) {
    if (!hasCommentAbove(lines, meth.line)) {
      warnings.push({
        rule: 'delivery-comment-coverage-method',
        severity: 'warning',
        file: fileName,
        line: meth.line,
        message: fileName + ':' + meth.line + ' 方法 ' + meth.name + ' 缺中文注释 — 反馈条 1 要求每个方法都说明职责。',
        details: { method: meth.name },
      });
    }
  });

  findConditions(code, minBlock).forEach(function(cond) {
    if (!hasCommentAbove(lines, cond.line)) {
      warnings.push({
        rule: 'delivery-comment-coverage-condition',
        severity: 'warning',
        file: fileName,
        line: cond.line,
        message: fileName + ':' + cond.line + ' ' + cond.kind + ' 块 (' + cond.blockLines + ' 行) 缺注释 — 反馈条 2 要求每种条件说明判断意图。',
        details: { kind: cond.kind, blockLines: cond.blockLines },
      });
    }
  });

  return warnings;
}

function validateFileSize(code, fileName, thresholds) {
  var lines = code.split('\n').length;
  if (lines > thresholds.fileLines) {
    return [{
      rule: 'delivery-class-file-size',
      severity: 'warning',
      file: fileName,
      message: fileName + ' 共 ' + lines + ' 行,超过软上限 ' + thresholds.fileLines + ' 行 — 建议按职责拆分 (反馈条 4/5)。',
      details: { lines: lines, threshold: thresholds.fileLines },
    }];
  }
  return [];
}

function validateMethodLength(code, fileName, thresholds) {
  var warnings = [];
  findMethods(code).forEach(function(m) {
    var bodyLines = m.body.split('\n').length;
    if (bodyLines > thresholds.methodLines) {
      warnings.push({
        rule: 'delivery-method-length',
        severity: 'warning',
        file: fileName,
        line: m.line,
        message: fileName + ':' + m.line + ' 方法 ' + m.name + ' 共 ' + bodyLines + ' 行,超过软上限 ' + thresholds.methodLines + ' 行 — 建议拆分子方法 (反馈条 6)。',
        details: { method: m.name, lines: bodyLines, threshold: thresholds.methodLines },
      });
    }
  });
  return warnings;
}

function validateNestingDepth(code, fileName, thresholds) {
  var warnings = [];
  findMethods(code).forEach(function(m) {
    var depth = maxNestingDepth(m.body);
    if (depth >= thresholds.nestingDepth) {
      warnings.push({
        rule: 'delivery-method-nesting',
        severity: 'warning',
        file: fileName,
        line: m.line,
        message: fileName + ':' + m.line + ' 方法 ' + m.name + ' 嵌套深度达 ' + depth + ',超过软上限 ' + thresholds.nestingDepth + ' — 建议拆分判断逻辑 (反馈条 6)。',
        details: { method: m.name, depth: depth, threshold: thresholds.nestingDepth },
      });
    }
  });
  return warnings;
}

/**
 * 验证单个 C# 源文件,合并三类规则的 warning。
 */
function validateCSharpSource(code, fileName, opts) {
  var thresholds = Object.assign({}, DEFAULT_THRESHOLDS, opts && opts.thresholds);
  // 反馈 01 #1/#2 (Wave B):注释覆盖率检查默认开,可通过 opts.commentCoverage = false 关掉。
  // 关闭口子留给单元测试或第三方工具集成,默认对所有交付走最严档。
  var enableCoverage = !(opts && opts.commentCoverage === false);
  var out = [].concat(
    validateFileSize(code, fileName, thresholds),
    validateMethodLength(code, fileName, thresholds),
    validateNestingDepth(code, fileName, thresholds)
  );
  if (enableCoverage) {
    out = out.concat(validateCommentCoverage(code, fileName, thresholds));
  }
  return out;
}

/**
 * 递归遍历交付目录,对所有 .cs 文件应用 validateCSharpSource。
 */
function validateDeliveryDirectory(root, opts) {
  var warnings = [];
  if (!fs.existsSync(root)) return warnings;
  function walk(dir) {
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return; }
    for (var i = 0; i < entries.length; i++) {
      var p = path.join(dir, entries[i]);
      var st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) walk(p);
      else if (path.extname(entries[i]).toLowerCase() === '.cs') {
        var code;
        try { code = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
        var fileWarnings = validateCSharpSource(code, entries[i], opts);
        for (var j = 0; j < fileWarnings.length; j++) warnings.push(fileWarnings[j]);
      }
    }
  }
  walk(root);
  return warnings;
}

module.exports = {
  DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
  findMethods: findMethods,
  findFields: findFields,
  findConditions: findConditions,
  hasCommentAbove: hasCommentAbove,
  maxNestingDepth: maxNestingDepth,
  validateFileSize: validateFileSize,
  validateMethodLength: validateMethodLength,
  validateNestingDepth: validateNestingDepth,
  validateCommentCoverage: validateCommentCoverage,
  validateCSharpSource: validateCSharpSource,
  validateDeliveryDirectory: validateDeliveryDirectory,
};
