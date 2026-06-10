'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var PDFDocument = require('pdfkit');
var storyboardAi = require('../engine/storyboard-ai.cjs');

var PAGE_W = 1128;
var PAGE_H = 2540;
var TEMPLATE_VERSION = 'customer-storyboard-pdf.v1';

var DEFAULT_TEMPLATE_PHASES = [
  ['phase1', '开局目标', '玩家看到核心场景、主角、资源点和最终目标；用箭头/高亮明确第一步操作。', '前往目标', '首帧全景'],
  ['phase2', '首次移动', '引导玩家用摇杆或点击移动到第一个目标，画面需要展示路径、目标光圈和手指提示。', '移动到目标', '移动到目标'],
  ['phase3', '首次采集', '玩家采集或拾取第一个资源，资源从目标飞向背包或计数条，产生明确爽感反馈。', '采集资源', '采集反馈'],
  ['phase4', '首次交付/售卖', '引导玩家返回基地、机器或售卖点完成交付，资源转换为金币、能量或进度。', '交付资源', '收益反馈'],
  ['phase5', '建造设施', '玩家消耗收益建造第一个关键设施，展示地贴、进度、建成动画和新功能解锁。', '建造设施', '设施建成'],
  ['phase6', '升级工具', '玩家升级工具、车辆或角色，强化下一轮效率，画面体现外观和采集速度变化。', '升级工具', '升级新形态'],
  ['phase7', '第二轮采集', '用升级后的工具重复核心操作，但目标、速度、反馈必须明显不同，避免画面重复。', '强化采集', '强化采集'],
  ['phase8', '解锁新区域', '引导玩家建造或打开新房间/新地图区域，镜头展示新内容的位置和进入路径。', '解锁区域', '新区域出现'],
  ['phase9', '冲突/障碍出现', '敌人、障碍、缺口或订单压力出现，制造继续操作的理由，画面需要有明显威胁或目标差距。', '处理威胁', '威胁出现'],
  ['phase10', '处理冲突', '玩家攻击、修复、防守或清障，完成一次高反馈动作，显示敌人消失、设施恢复或道路打通。', '完成处理', '完成反馈'],
  ['phase11', '高潮展示', '镜头拉远或集中展示完整系统运转，多个已解锁设施或角色同时可见，强化成就感。', '展示全景', '终局全景'],
  ['phase12', 'CTA收口', '展示最终奖励、下载按钮或继续游玩动机；CTA 只在最终阶段出现，不能提前跳转。', '点击CTA', 'CTA按钮'],
].map(function(row) {
  return {
    phaseId: row[0],
    title: row[1],
    sceneText: row[2],
    playerAction: row[3],
    feedback: '',
    uiText: 'UI：箭头、高亮框、手指图标、资源条、目标提示。',
    primaryTarget: '',
    canonicalInteraction: row[0] === 'phase12' ? 'click:CtaButton' : 'observe',
    image: '',
    visualPrompt: row[4],
    sourceEvidence: [],
  };
});

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function firstExisting(paths) {
  for (var i = 0; i < paths.length; i += 1) {
    if (paths[i] && fs.existsSync(paths[i])) return paths[i];
  }
  return '';
}

function registerFonts(doc) {
  var regular = firstExisting([
    '/usr/share/fonts/chinese/NotoSansSC-Regular.ttf',
    '/usr/share/fonts/chinese/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
    '/usr/share/fonts/wqy-microhei/wqy-microhei.ttc',
  ]);
  var bold = firstExisting([
    '/usr/share/fonts/chinese/NotoSansCJKsc-Bold.otf',
    '/usr/share/fonts/truetype/noto/NotoSansSC-Bold.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  ]);
  doc.registerFont('CJK', regular || 'Helvetica');
  doc.registerFont('CJKBold', bold || regular || 'Helvetica-Bold');
}

function fetchUrl(url) {
  return new Promise(function(resolve) {
    if (!url) return resolve(null);
    var mod = /^https:/i.test(url) ? https : http;
    var req = mod.get(url, { timeout: 10000 }, function(res) {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() { resolve(Buffer.concat(chunks)); });
    });
    req.on('error', function() { resolve(null); });
    req.on('timeout', function() { req.destroy(); resolve(null); });
  });
}

async function loadImageBuffer(image, baseDir, serverBaseUrl) {
  if (!image) return null;
  if (Buffer.isBuffer(image)) return image;
  var text = stringValue(image);
  if (!text) return null;
  if (/^data:image\//i.test(text)) {
    var match = text.match(/base64,(.+)$/);
    return match ? Buffer.from(match[1], 'base64') : null;
  }
  if (/^https?:\/\//i.test(text)) return fetchUrl(text);
  if (serverBaseUrl && text[0] === '/') return fetchUrl(serverBaseUrl.replace(/\/$/, '') + text);
  var filePath = path.resolve(baseDir || process.cwd(), text);
  try {
    return fs.readFileSync(filePath);
  } catch (e) {
    return null;
  }
}

function phaseDescription(phase) {
  var lines = [];
  if (phase.sceneText) lines.push('玩家看到什么：' + phase.sceneText);
  if (phase.playerAction) lines.push('玩家做什么：' + phase.playerAction);
  if (phase.feedback) lines.push('操作反馈：' + phase.feedback);
  if (phase.uiText) lines.push(phase.uiText.indexOf('UI') === 0 ? phase.uiText : 'UI：' + phase.uiText);
  if (!lines.length && phase.visualPrompt) lines.push('画面方向：' + phase.visualPrompt);
  return lines.join('\n');
}

function buildTemplateStoryboardAi(options) {
  options = options || {};
  return storyboardAi.normalizeStoryboardAi({
    projectName: options.projectName || 'AI试玩广告分镜模板',
    coreLoop: options.coreLoop || '开局目标 -> 首次操作 -> 资源反馈 -> 建造/升级 -> 冲突升级 -> 高潮收口 -> CTA',
    phases: DEFAULT_TEMPLATE_PHASES,
  });
}

function buildCustomerStoryboardRows(input, options) {
  var ai = input && input.kind === storyboardAi.STORYBOARD_AI_KIND
    ? input
    : storyboardAi.normalizeStoryboardAi(input || {}, options || {});
  return ai.phases.map(function(phase, index) {
    return {
      rowNo: index + 1,
      phaseId: phase.phaseId,
      phaseTitle: phase.title,
      description: phaseDescription(phase),
      image: phase.image,
      imageLabel: phase.visualPrompt || phase.visualBrief && safeArray(phase.visualBrief.mustShow).join(' / ') || phase.title,
      sourceEvidence: phase.sourceEvidence || [],
    };
  });
}

function createDrawingApi(doc) {
  var black = '#111111';
  var grid = '#1d1d1d';
  return {
    rect: function(x, y, w, h, fill) {
      doc.save();
      if (fill) doc.rect(x, y, w, h).fill(fill);
      doc.lineWidth(1).strokeColor(grid).rect(x, y, w, h).stroke();
      doc.restore();
    },
    text: function(t, x, y, w, h, opt) {
      opt = opt || {};
      doc.font(opt.bold ? 'CJKBold' : 'CJK')
        .fontSize(opt.size || 18)
        .fillColor(opt.color || black)
        .text(String(t || ''), x, y, {
          width: w,
          height: h,
          align: opt.align || 'left',
          valign: opt.valign || 'top',
          lineGap: opt.lineGap == null ? 2 : opt.lineGap,
          ellipsis: opt.ellipsis || false,
        });
    },
  };
}

function centered(draw, t, x, y, w, h, opt) {
  opt = opt || {};
  var size = opt.size || 18;
  var lines = String(t || '').split('\n');
  var lineH = size * 1.28;
  var blockH = lines.length * lineH;
  var yy = y + Math.max(0, (h - blockH) / 2);
  lines.forEach(function(line) {
    draw.text(line, x + 4, yy, w - 8, lineH + 2, Object.assign({}, opt, { size: size, align: 'center' }));
    yy += lineH;
  });
}

function drawPlaceholder(doc, draw, x, y, w, h, label) {
  doc.save().rect(x, y, w, h).fill('#dfe7f3').restore();
  doc.save().lineWidth(1).strokeColor('#7b8794').rect(x, y, w, h).stroke().restore();
  doc.save();
  doc.moveTo(x + 34, y + h - 34)
    .lineTo(x + w * 0.36, y + h * 0.58)
    .lineTo(x + w * 0.53, y + h * 0.72)
    .lineTo(x + w - 34, y + h * 0.34)
    .strokeColor('#9aa7b6')
    .lineWidth(4)
    .stroke();
  doc.circle(x + w - 46, y + 38, 14).fill('#f8fafc');
  doc.restore();
  centered(draw, label || '画面', x, y + h * 0.40, w, 30, { size: 20, bold: true, color: '#334155' });
  centered(draw, '截图 / 视频关键帧 / AI图', x, y + h * 0.58, w, 22, { size: 12, color: '#64748b' });
}

function drawImageOrPlaceholder(doc, draw, imageBuffer, x, y, w, h, label) {
  if (imageBuffer) {
    try {
      doc.image(imageBuffer, x, y, { fit: [w, h], align: 'center', valign: 'center' });
      doc.save().lineWidth(1).strokeColor('#7b8794').rect(x, y, w, h).stroke().restore();
      return;
    } catch (e) {}
  }
  drawPlaceholder(doc, draw, x, y, w, h, label);
}

function outputPromise(doc, outputPath, buffers) {
  if (outputPath) {
    return new Promise(function(resolve, reject) {
      doc.on('end', function() { resolve({ outputPath: outputPath }); });
      doc.on('error', reject);
    });
  }
  return new Promise(function(resolve, reject) {
    doc.on('data', function(chunk) { buffers.push(chunk); });
    doc.on('end', function() { resolve(Buffer.concat(buffers)); });
    doc.on('error', reject);
  });
}

async function generateCustomerStoryboardPDF(input, options) {
  options = options || {};
  var ai = input && input.kind === storyboardAi.STORYBOARD_AI_KIND
    ? input
    : storyboardAi.normalizeStoryboardAi(input || {}, options);
  storyboardAi.assertStoryboardAi(ai);
  var rows = buildCustomerStoryboardRows(ai, options);
  if (!rows.length) throw new Error('customer storyboard PDF requires at least one phase');

  var outputPath = options.outputPath ? path.resolve(options.outputPath) : '';
  if (outputPath) fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  var doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: 0, bufferPages: false });
  var buffers = [];
  var outPromise = outputPromise(doc, outputPath, buffers);
  if (outputPath) doc.pipe(fs.createWriteStream(outputPath));
  registerFonts(doc);

  var imageBuffers = [];
  for (var i = 0; i < rows.length; i += 1) {
    imageBuffers.push(await loadImageBuffer(rows[i].image, options.baseDir, options.serverBaseUrl));
  }

  var draw = createDrawingApi(doc);
  var cols = {
    no: 88,
    phase: 178,
    desc: 350,
  };
  cols.image = PAGE_W - cols.no - cols.phase - cols.desc;
  var xs = [0, cols.no, cols.no + cols.phase, cols.no + cols.phase + cols.desc, PAGE_W];

  var y = 0;
  draw.rect(0, y, PAGE_W, 46, null);
  centered(draw, ai.project.name || 'AI试玩广告分镜', 0, y, PAGE_W, 46, { size: 25, bold: true });
  y += 46;
  draw.rect(0, y, PAGE_W, 54, null);
  centered(draw, '核心流程：' + (ai.project.coreLoop || ''), 0, y + 4, PAGE_W, 22, { size: 16, bold: true });
  centered(draw, '说明：每行对应一个客户确认节点；确认后再进入后续试玩制作流程', 0, y + 28, PAGE_W, 18, { size: 11, color: '#555555' });
  y += 54;
  draw.rect(0, y, PAGE_W, 44, null);
  centered(draw, '需求描述', 0, y, PAGE_W, 44, { size: 19, bold: true });
  y += 44;

  var headerH = 46;
  draw.rect(xs[0], y, cols.no, headerH, '#eeeeee');
  draw.rect(xs[1], y, cols.phase + cols.desc, headerH, '#eeeeee');
  draw.rect(xs[3], y, cols.image, headerH, '#eeeeee');
  centered(draw, '序号', xs[0], y, cols.no, headerH, { size: 15, bold: true });
  centered(draw, '文字描述', xs[1], y, cols.phase + cols.desc, headerH, { size: 15, bold: true });
  centered(draw, '画面', xs[3], y, cols.image, headerH, { size: 15, bold: true });
  y += headerH;

  var rowH = (PAGE_H - y) / rows.length;
  rows.forEach(function(row, index) {
    draw.rect(xs[0], y, cols.no, rowH, null);
    draw.rect(xs[1], y, cols.phase, rowH, null);
    draw.rect(xs[2], y, cols.desc, rowH, null);
    draw.rect(xs[3], y, cols.image, rowH, null);

    centered(draw, String(row.rowNo), xs[0], y, cols.no, rowH, { size: 39, bold: true, color: '#0f172a' });
    draw.text('Phase ' + (index + 1) + ':', xs[1] + 14, y + 45, cols.phase - 28, 24, { size: 15, bold: true });
    draw.text(row.phaseTitle, xs[1] + 14, y + 76, cols.phase - 28, 58, { size: 18, bold: true, align: 'center' });
    draw.text(row.phaseId, xs[1] + 14, y + rowH - 34, cols.phase - 28, 20, { size: 10, color: '#64748b', align: 'center' });

    draw.text(row.description, xs[2] + 16, y + 20, cols.desc - 32, rowH - 40, { size: 13, lineGap: 3 });

    var pad = 10;
    drawImageOrPlaceholder(doc, draw, imageBuffers[index], xs[3] + pad, y + pad, cols.image - pad * 2, rowH - pad * 2, row.imageLabel);

    y += rowH;
  });

  draw.rect(0, 0, PAGE_W, PAGE_H, null);
  doc.end();
  return outPromise;
}

function buildPdfMap(input, options) {
  var ai = input && input.kind === storyboardAi.STORYBOARD_AI_KIND
    ? input
    : storyboardAi.normalizeStoryboardAi(input || {}, options || {});
  return {
    schemaVersion: 'customer-storyboard-pdf-map.v1',
    template: TEMPLATE_VERSION,
    project: ai.project,
    semanticHash: ai.semanticHash,
    rows: ai.phases.map(function(phase, index) {
      return {
        rowNo: index + 1,
        phaseId: phase.phaseId,
        title: phase.title,
        canonicalInteraction: phase.canonicalInteraction,
        primaryTarget: phase.primaryTarget || null,
      };
    }),
  };
}

module.exports = {
  TEMPLATE_VERSION: TEMPLATE_VERSION,
  PAGE_W: PAGE_W,
  PAGE_H: PAGE_H,
  DEFAULT_TEMPLATE_PHASES: DEFAULT_TEMPLATE_PHASES,
  buildTemplateStoryboardAi: buildTemplateStoryboardAi,
  buildCustomerStoryboardRows: buildCustomerStoryboardRows,
  buildPdfMap: buildPdfMap,
  generateCustomerStoryboardPDF: generateCustomerStoryboardPDF,
  _internals: {
    phaseDescription: phaseDescription,
    loadImageBuffer: loadImageBuffer,
  },
};
