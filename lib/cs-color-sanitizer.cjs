// cs-color-sanitizer.cjs
// LLM 输出的 `new Color(R, G, B[, A])` 经常按 0-255 写,
// Unity Color 是 0-1,任意分量 > 1 都会被 clamp 到 1 → 屏幕变白闪一帧。
// 这个函数扫描所有 `new Color(...)` 字面量,如果有任何分量 > 1.5,
// 把所有分量按 /255 重写。Alpha 通道 (4th arg) 同样处理。
// 副作用:阉割 LLM 偶尔故意做的 emissive HDR 颜色 (>1)。试玩广告里我们不用 HDR。

var COLOR_LITERAL = /new\s+Color\s*\(\s*([0-9]+(?:\.[0-9]+)?)f?\s*,\s*([0-9]+(?:\.[0-9]+)?)f?\s*,\s*([0-9]+(?:\.[0-9]+)?)f?\s*(?:,\s*([0-9]+(?:\.[0-9]+)?)f?\s*)?\)/g;

function sanitizeColors(code) {
  if (typeof code !== 'string' || code.indexOf('new Color') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var next = code.replace(COLOR_LITERAL, function(match, r, g, b, a) {
    var rn = parseFloat(r);
    var gn = parseFloat(g);
    var bn = parseFloat(b);
    var an = a != null ? parseFloat(a) : null;
    var any = Math.max(rn, gn, bn, an == null ? 0 : an);
    if (any <= 1.5) return match; // already 0-1
    fixes++;
    function fmt(v) {
      var f = (v / 255).toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');
      return f + 'f';
    }
    if (an != null) {
      var aOut = an > 1.5 ? fmt(an) : (an + 'f');
      return 'new Color(' + fmt(rn) + ', ' + fmt(gn) + ', ' + fmt(bn) + ', ' + aOut + ')';
    }
    return 'new Color(' + fmt(rn) + ', ' + fmt(gn) + ', ' + fmt(bn) + ')';
  });
  return { code: next, changed: fixes > 0, fixes: fixes };
}

module.exports = { sanitizeColors: sanitizeColors };
