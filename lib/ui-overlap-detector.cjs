/**
 * UI overlap detector — non-blocking warning for programmer delivery output.
 *
 * 反馈 01 (2026-04-26) Phase B.2:覆盖反馈条 "blueprint 生成的工程在 Unity 引擎打开后,
 * 画面的 UI/文字 会重叠"。在 cleaner 写 PROGRAMMER_HANDOFF 之前扫一遍生成的 C#,
 * 把 GFM_UI.Create{Text,Button,ProgressBar} 调用的 anchoredPosition + sizeDelta
 * 还原成 Canvas AABB,两两 AABB 相交即列入告警。
 *
 * 仅产出 warning,不阻塞交付,也不改 cleaner 主流程。
 *
 * 已知边界:
 *  - 只解析 GFM_UI.Create* 这套 helper 的字面量参数;直接 anchoredPosition=...
 *    赋值的写法暂不识别(后续阶段再加)。
 *  - 假定 RectTransform pivot = (0.5, 0.5),即 anchoredPosition 为矩形中心。
 *    GFM_UI helper 内部从未改 pivot,目前这条假设跟 Unity 默认值一致。
 *  - AddWorldLabel 是 world-space 跟随实体的标签,跟 Canvas 重叠无关,跳过。
 */
var fs = require('fs');
var path = require('path');

// CreateText 默认 size = (400, fontSize*2),与 GFM_UI.cs CreateText 一致。
var CREATE_TEXT_DEFAULT_WIDTH = 400;

// 数字字面量(允许 -3.5f / 1080 / .5 等)。
var NUM = '(-?\\d+(?:\\.\\d+)?f?|-?\\.\\d+f?)';
// new Vector2(x, y) — 也接受 new UnityEngine.Vector2 之类的写法。
var VEC2 = 'new\\s+(?:UnityEngine\\.)?Vector2\\s*\\(\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*\\)';

function toNumber(token) {
  if (token == null) return NaN;
  var t = String(token).trim();
  if (t.endsWith('f') || t.endsWith('F')) t = t.slice(0, -1);
  var n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function lineNumber(source, idx) {
  var slice = source.slice(0, idx);
  var nl = 0;
  for (var i = 0; i < slice.length; i++) if (slice.charCodeAt(i) === 10) nl++;
  return nl + 1;
}

function rectFromCenter(pos, size) {
  var halfW = size.w / 2;
  var halfH = size.h / 2;
  return {
    minX: pos.x - halfW,
    maxX: pos.x + halfW,
    minY: pos.y - halfH,
    maxY: pos.y + halfH,
  };
}

function rectsOverlap(a, b) {
  return !(a.minX >= b.maxX || a.maxX <= b.minX || a.minY >= b.maxY || a.maxY <= b.minY);
}

function overlapArea(a, b) {
  var w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  var h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return Math.round(w * h);
}

function relPath(root, file) {
  var rel = path.relative(root, file);
  return rel.split(path.sep).join('/');
}

// CreateText(canvas, "<content>", new Vector2(x,y), <fontSize>)
function extractCreateText(source, fileLabel) {
  var elements = [];
  var re = new RegExp(
    'GFM_UI\\.CreateText\\s*\\(\\s*[^,]+,\\s*"((?:\\\\.|[^"\\\\])*)"\\s*,\\s*' + VEC2 + '\\s*,\\s*' + NUM + '\\s*\\)',
    'g'
  );
  var m;
  while ((m = re.exec(source)) !== null) {
    var content = m[1];
    var x = toNumber(m[2]);
    var y = toNumber(m[3]);
    var fontSize = toNumber(m[4]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(fontSize)) continue;
    var size = { w: CREATE_TEXT_DEFAULT_WIDTH, h: fontSize * 2 };
    elements.push({
      kind: 'Text',
      label: content || '<empty>',
      file: fileLabel,
      line: lineNumber(source, m.index),
      pos: { x: x, y: y },
      size: size,
      rect: rectFromCenter({ x: x, y: y }, size),
    });
  }
  return elements;
}

// CreateButton(canvas, "<text>", new Vector2(x,y), new Vector2(w,h), <onClick>)
function extractCreateButton(source, fileLabel) {
  var elements = [];
  var re = new RegExp(
    'GFM_UI\\.CreateButton\\s*\\(\\s*[^,]+,\\s*"((?:\\\\.|[^"\\\\])*)"\\s*,\\s*' + VEC2 + '\\s*,\\s*' + VEC2 + '\\s*,',
    'g'
  );
  var m;
  while ((m = re.exec(source)) !== null) {
    var label = m[1];
    var x = toNumber(m[2]);
    var y = toNumber(m[3]);
    var w = toNumber(m[4]);
    var h = toNumber(m[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    var size = { w: w, h: h };
    elements.push({
      kind: 'Button',
      label: label || '<empty>',
      file: fileLabel,
      line: lineNumber(source, m.index),
      pos: { x: x, y: y },
      size: size,
      rect: rectFromCenter({ x: x, y: y }, size),
    });
  }
  return elements;
}

// CreateProgressBar(canvas, new Vector2(x,y), new Vector2(w,h), fillColor)
function extractCreateProgressBar(source, fileLabel) {
  var elements = [];
  var re = new RegExp(
    'GFM_UI\\.CreateProgressBar\\s*\\(\\s*[^,]+,\\s*' + VEC2 + '\\s*,\\s*' + VEC2 + '\\s*,',
    'g'
  );
  var m;
  while ((m = re.exec(source)) !== null) {
    var x = toNumber(m[1]);
    var y = toNumber(m[2]);
    var w = toNumber(m[3]);
    var h = toNumber(m[4]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    var size = { w: w, h: h };
    elements.push({
      kind: 'ProgressBar',
      label: '<progress>',
      file: fileLabel,
      line: lineNumber(source, m.index),
      pos: { x: x, y: y },
      size: size,
      rect: rectFromCenter({ x: x, y: y }, size),
    });
  }
  return elements;
}

function extractFromSource(source, fileLabel) {
  return [].concat(
    extractCreateText(source, fileLabel),
    extractCreateButton(source, fileLabel),
    extractCreateProgressBar(source, fileLabel)
  );
}

function findCsFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  var found = [];
  var stack = [rootDir];
  while (stack.length) {
    var dir = stack.pop();
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (var i = 0; i < entries.length; i++) {
      var ent = entries[i];
      var full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // 跳过常见的非交付目录
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        stack.push(full);
      } else if (ent.isFile() && full.endsWith('.cs')) {
        found.push(full);
      }
    }
  }
  return found;
}

function detectOverlaps(elements) {
  var overlaps = [];
  for (var i = 0; i < elements.length; i++) {
    for (var j = i + 1; j < elements.length; j++) {
      var a = elements[i];
      var b = elements[j];
      if (!rectsOverlap(a.rect, b.rect)) continue;
      overlaps.push({
        a: { kind: a.kind, label: a.label, file: a.file, line: a.line, pos: a.pos, size: a.size },
        b: { kind: b.kind, label: b.label, file: b.file, line: b.line, pos: b.pos, size: b.size },
        area: overlapArea(a.rect, b.rect),
      });
    }
  }
  return overlaps;
}

/**
 * 扫描交付目录,返回 { elements, overlaps }。
 * 入参可以是任意目录;通常传 cleaner 的 deliveryRoot,会递归找 *.cs。
 */
function detectUiOverlap(deliveryRoot) {
  var files = findCsFiles(deliveryRoot);
  var allElements = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var label = relPath(deliveryRoot, file);
    var src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    var els = extractFromSource(src, label);
    for (var k = 0; k < els.length; k++) allElements.push(els[k]);
  }
  return {
    elements: allElements,
    overlaps: detectOverlaps(allElements),
  };
}

module.exports = {
  detectUiOverlap: detectUiOverlap,
  extractFromSource: extractFromSource,
  rectsOverlap: rectsOverlap,
  rectFromCenter: rectFromCenter,
};
