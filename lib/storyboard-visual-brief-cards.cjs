'use strict';

var fs = require('fs');
var path = require('path');
var sharp = require('sharp');

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapText(text, maxChars, maxLines) {
  var source = stringValue(text);
  var lines = [];
  var current = '';
  for (var i = 0; i < source.length; i += 1) {
    current += source[i];
    if (current.length >= maxChars || /[。；，,]/.test(source[i])) {
      lines.push(current.replace(/[，,]$/, '').trim());
      current = '';
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current.trim());
  return lines.filter(Boolean);
}

function textSvg(lines, x, y, options) {
  options = options || {};
  var size = options.size || 28;
  var color = options.color || '#172033';
  var weight = options.weight || 500;
  var lineGap = options.lineGap || Math.round(size * 1.35);
  return safeArray(lines).map(function(line, index) {
    return '<text x="' + x + '" y="' + (y + index * lineGap) + '" font-size="' + size + '" font-weight="' + weight + '" fill="' + color + '">' + escapeXml(line) + '</text>';
  }).join('\n');
}

function cardSvg(phase, width, height) {
  width = width || 960;
  height = height || 520;
  var brief = phase.visualBrief || {};
  var mustShow = safeArray(brief.mustShow).slice(0, 5).join(' / ') || phase.primaryTarget || phase.title;
  var ui = safeArray(brief.ui).slice(0, 2).join(' / ') || phase.uiText || '';
  var title = phase.title || phase.phaseId;
  var sceneLines = wrapText(phase.sceneText || phase.visualPrompt || '', 28, 4);
  var actionLines = wrapText(phase.playerAction || '', 28, 2);
  var feedbackLines = wrapText(phase.feedback || '', 28, 2);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">',
    '<rect width="' + width + '" height="' + height + '" fill="#dfe7f3"/>',
    '<rect x="24" y="24" width="' + (width - 48) + '" height="' + (height - 48) + '" rx="0" fill="#eef4fb" stroke="#8ea0b8" stroke-width="3"/>',
    '<path d="M80 ' + (height - 84) + ' L330 310 L470 360 L' + (width - 80) + ' 160" fill="none" stroke="#8da0b4" stroke-width="10" stroke-linecap="round"/>',
    '<circle cx="' + (width - 90) + '" cy="82" r="28" fill="#ffffff" opacity=".9"/>',
    '<rect x="52" y="52" width="150" height="42" fill="#172033" opacity=".78"/>',
    '<text x="72" y="82" font-size="24" font-weight="800" fill="#ffffff">' + escapeXml(phase.phaseId || '') + '</text>',
    '<text x="52" y="145" font-size="44" font-weight="900" fill="#22304a">' + escapeXml(title) + '</text>',
    textSvg(sceneLines, 54, 200, { size: 25, color: '#334155', weight: 600, lineGap: 34 }),
    '<text x="54" y="355" font-size="22" font-weight="900" fill="#2563eb">必须出现</text>',
    '<text x="164" y="355" font-size="22" font-weight="700" fill="#334155">' + escapeXml(mustShow) + '</text>',
    '<text x="54" y="397" font-size="22" font-weight="900" fill="#16a34a">玩家动作</text>',
    textSvg(actionLines, 164, 397, { size: 21, color: '#334155', weight: 600, lineGap: 30 }),
    '<text x="54" y="455" font-size="22" font-weight="900" fill="#ea580c">反馈</text>',
    textSvg(feedbackLines, 164, 455, { size: 21, color: '#334155', weight: 600, lineGap: 30 }),
    '<text x="54" y="' + (height - 38) + '" font-size="18" font-weight="700" fill="#64748b">' + escapeXml(ui) + '</text>',
    '</svg>',
  ].join('\n');
}

async function renderVisualBriefCard(phase, outPath, options) {
  options = options || {};
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  var svg = cardSvg(phase, options.width || 960, options.height || 520);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

async function renderVisualBriefCards(storyboardAi, outDir, options) {
  fs.mkdirSync(outDir, { recursive: true });
  var phases = safeArray(storyboardAi && storyboardAi.phases);
  for (var i = 0; i < phases.length; i += 1) {
    var phase = phases[i];
    var fileName = 'phase' + String(i + 1).padStart(2, '0') + '.png';
    var outPath = path.join(outDir, fileName);
    await renderVisualBriefCard(phase, outPath, options || {});
    phase.image = path.relative(options && options.baseDir || path.dirname(outDir), outPath);
  }
  return storyboardAi;
}

module.exports = {
  renderVisualBriefCard: renderVisualBriefCard,
  renderVisualBriefCards: renderVisualBriefCards,
  _internals: {
    cardSvg: cardSvg,
    wrapText: wrapText,
  },
};
