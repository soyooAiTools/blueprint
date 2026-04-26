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
  return [].concat(
    validateFileSize(code, fileName, thresholds),
    validateMethodLength(code, fileName, thresholds),
    validateNestingDepth(code, fileName, thresholds)
  );
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
  maxNestingDepth: maxNestingDepth,
  validateFileSize: validateFileSize,
  validateMethodLength: validateMethodLength,
  validateNestingDepth: validateNestingDepth,
  validateCSharpSource: validateCSharpSource,
  validateDeliveryDirectory: validateDeliveryDirectory,
};
