/**
 * Storyboard PDF Generator
 * Generates a professional storyboard PDF matching the reference format:
 * Portrait A4, 4-column table (序号, 文字描述, 画面, 注释)
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PAGE_W = 595; // A4 portrait
const PAGE_H = 842;
const MARGIN = 30;
const TABLE_W = PAGE_W - MARGIN * 2;

// Column widths (proportional to reference: 序号~6%, 文字描述~25%, 画面~50%, 注释~19%)
const COL_WIDTHS = [
  Math.round(TABLE_W * 0.06),  // 序号
  Math.round(TABLE_W * 0.25),  // 文字描述
  Math.round(TABLE_W * 0.50),  // 画面
];
COL_WIDTHS.push(TABLE_W - COL_WIDTHS[0] - COL_WIDTHS[1] - COL_WIDTHS[2]); // 注释 (remainder)

const HEADER_LABELS = ['序号', '文字描述', '画面', '注释'];
const BORDER_COLOR = '#000';
const BORDER_WIDTH = 0.5;
const CELL_PAD = 4;

function fetchImage(url) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve(null);
    if (url.startsWith('data:image/svg')) return resolve(null);
    if (url.startsWith('data:image/')) {
      const match = url.match(/base64,(.+)/);
      if (match) return resolve(Buffer.from(match[1], 'base64'));
      return resolve(null);
    }
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) return resolve(null);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', () => resolve(null));
  });
}

function drawRect(doc, x, y, w, h) {
  doc.save()
    .lineWidth(BORDER_WIDTH)
    .strokeColor(BORDER_COLOR)
    .rect(x, y, w, h)
    .stroke()
    .restore();
}

function drawMergedRow(doc, x, y, w, h, text, opts = {}) {
  const { fontSize = 12, bold = false, align = 'center', fillColor = '#000' } = opts;
  drawRect(doc, x, y, w, h);
  doc.font(bold ? 'CJK-Bold' : 'CJK')
    .fontSize(fontSize)
    .fillColor(fillColor)
    .text(text, x + CELL_PAD, y + CELL_PAD, {
      width: w - CELL_PAD * 2,
      height: h - CELL_PAD * 2,
      align,
      lineBreak: true,
    });
}

function measureTextHeight(doc, text, width, fontSize, fontName) {
  doc.font(fontName || 'CJK').fontSize(fontSize);
  return doc.heightOfString(text || '', { width: width - CELL_PAD * 2 }) + CELL_PAD * 2;
}

function buildDescriptionText(frame) {
  const parts = [];
  if (frame.interaction) {
    parts.push('玩家看到什么：' + (frame.scene || frame.interaction || ''));
  } else if (frame.scene) {
    parts.push('玩家看到什么：' + frame.scene);
  }
  if (frame.controlMethod) {
    parts.push('玩家做什么：' + frame.controlMethod);
  }
  if (frame.ui) {
    parts.push('UI：' + frame.ui);
  }
  if (frame.animation) {
    parts.push('镜头：' + frame.animation);
  }
  // Fallback: use raw description/interaction
  if (parts.length === 0) {
    if (frame.description) parts.push(frame.description);
    if (frame.interaction) parts.push(frame.interaction);
    if (frame.prompt) parts.push(frame.prompt);
  }
  return parts.join('\n');
}

async function generateStoryboardPDF(frames, options = {}) {
  const { projectName = '分镜板', subtitle = '', outputPath, serverBaseUrl = '' } = options;

  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: MARGIN });
  const buffers = [];

  if (outputPath) {
    doc.pipe(fs.createWriteStream(outputPath));
  } else {
    doc.on('data', b => buffers.push(b));
  }

  // Register Chinese fonts
  let hasCJK = false;
  let cjkFontPath = null;
  const fontPaths = [
    '/usr/share/fonts/chinese/NotoSansSC-Regular.ttf',
    '/usr/share/fonts/chinese/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
    '/usr/share/fonts/wqy-microhei/wqy-microhei.ttc',
  ];
  const boldFontPaths = [
    '/usr/share/fonts/chinese/NotoSansCJKsc-Bold.otf',
    '/usr/share/fonts/truetype/noto/NotoSansSC-Bold.ttf',
  ];
  for (const fp of fontPaths) {
    if (fs.existsSync(fp)) {
      doc.registerFont('CJK', fp);
      cjkFontPath = fp;
      hasCJK = true;
      break;
    }
  }
  let hasBold = false;
  for (const fp of boldFontPaths) {
    if (fs.existsSync(fp)) {
      doc.registerFont('CJK-Bold', fp);
      hasBold = true;
      break;
    }
  }
  if (!hasCJK) {
    doc.registerFont('CJK', 'Helvetica');
  }
  if (!hasBold) {
    // Use the same CJK font file for bold (not the registered name)
    doc.registerFont('CJK-Bold', cjkFontPath || 'Helvetica-Bold');
  }

  // Pre-fetch all images
  const imageBuffers = [];
  for (const frame of frames) {
    let imgUrl = frame.imageUrl || '';
    if (imgUrl && !imgUrl.startsWith('http') && !imgUrl.startsWith('data:') && serverBaseUrl) {
      imgUrl = serverBaseUrl + imgUrl;
    }
    imageBuffers.push(await fetchImage(imgUrl));
  }

  // Pre-fetch annotation images
  const annotationBuffers = [];
  for (const frame of frames) {
    const annoUrl = frame.annotationImage || frame.referenceImage || '';
    let url = annoUrl;
    if (url && !url.startsWith('http') && !url.startsWith('data:') && serverBaseUrl) {
      url = serverBaseUrl + url;
    }
    annotationBuffers.push(await fetchImage(url));
  }

  let curY = MARGIN;

  // === Title row (merged) ===
  const titleH = 36;
  drawMergedRow(doc, MARGIN, curY, TABLE_W, titleH, projectName, { fontSize: 18, bold: true });
  curY += titleH;

  // === Subtitle/flow row (merged, optional) ===
  if (subtitle) {
    const subH = 24;
    drawMergedRow(doc, MARGIN, curY, TABLE_W, subH, subtitle, { fontSize: 11, bold: true });
    curY += subH;
  }

  // === "需求描述" section label (merged) ===
  const sectionH = 22;
  drawMergedRow(doc, MARGIN, curY, TABLE_W, sectionH, '需求描述', { fontSize: 12, bold: true });
  curY += sectionH;

  // === Column headers ===
  const headerH = 22;
  let colX = MARGIN;
  for (let c = 0; c < 4; c++) {
    drawRect(doc, colX, curY, COL_WIDTHS[c], headerH);
    doc.font('CJK-Bold').fontSize(9).fillColor('#000')
      .text(HEADER_LABELS[c], colX + CELL_PAD, curY + 5, {
        width: COL_WIDTHS[c] - CELL_PAD * 2, align: 'center', lineBreak: false,
      });
    colX += COL_WIDTHS[c];
  }
  curY += headerH;

  // === Content rows ===
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const phaseTitle = `Phase ${i + 1}:\n${frame.title || ''}`;
    const descText = buildDescriptionText(frame);
    const fullDesc = phaseTitle + '\n\n' + descText;

    // Calculate row height based on content
    const descH = measureTextHeight(doc, fullDesc, COL_WIDTHS[1], 7, 'CJK');
    const minImgH = 100; // minimum height for image column
    const rowH = Math.max(descH, minImgH, 80);

    // Check if we need a new page
    if (curY + rowH > PAGE_H - MARGIN) {
      doc.addPage();
      curY = MARGIN;
    }

    colX = MARGIN;

    // Col 1: 序号
    drawRect(doc, colX, curY, COL_WIDTHS[0], rowH);
    doc.font('CJK-Bold').fontSize(20).fillColor('#000')
      .text(String(i + 1), colX, curY + rowH / 2 - 12, {
        width: COL_WIDTHS[0], align: 'center', lineBreak: false,
      });
    colX += COL_WIDTHS[0];

    // Col 2: 文字描述
    drawRect(doc, colX, curY, COL_WIDTHS[1], rowH);
    // Phase title (bold)
    doc.font('CJK-Bold').fontSize(8).fillColor('#000')
      .text(phaseTitle, colX + CELL_PAD, curY + CELL_PAD, {
        width: COL_WIDTHS[1] - CELL_PAD * 2, lineBreak: true,
      });
    const titleTextH = doc.heightOfString(phaseTitle, { width: COL_WIDTHS[1] - CELL_PAD * 2 });
    // Description text (regular)
    doc.font('CJK').fontSize(7).fillColor('#333')
      .text(descText, colX + CELL_PAD, curY + CELL_PAD + titleTextH + 4, {
        width: COL_WIDTHS[1] - CELL_PAD * 2,
        height: rowH - CELL_PAD * 2 - titleTextH - 4,
        lineBreak: true,
      });
    colX += COL_WIDTHS[1];

    // Col 3: 画面
    drawRect(doc, colX, curY, COL_WIDTHS[2], rowH);
    const imgBuf = imageBuffers[i];
    if (imgBuf) {
      try {
        const imgPad = 4;
        doc.image(imgBuf, colX + imgPad, curY + imgPad, {
          fit: [COL_WIDTHS[2] - imgPad * 2, rowH - imgPad * 2],
          align: 'center',
          valign: 'center',
        });
      } catch (e) {
        // Placeholder on image error
        doc.font('CJK').fontSize(10).fillColor('#999')
          .text('(图片加载失败)', colX + CELL_PAD, curY + rowH / 2 - 6, {
            width: COL_WIDTHS[2] - CELL_PAD * 2, align: 'center',
          });
      }
    } else {
      // Placeholder
      doc.save().rect(colX + 4, curY + 4, COL_WIDTHS[2] - 8, rowH - 8).fill('#f5f5f5').restore();
      doc.font('CJK').fontSize(10).fillColor('#999')
        .text(`#${frame.id || i + 1}`, colX + CELL_PAD, curY + rowH / 2 - 6, {
          width: COL_WIDTHS[2] - CELL_PAD * 2, align: 'center',
        });
    }
    colX += COL_WIDTHS[2];

    // Col 4: 注释
    drawRect(doc, colX, curY, COL_WIDTHS[3], rowH);
    const annoBuf = annotationBuffers[i];
    if (annoBuf) {
      try {
        doc.image(annoBuf, colX + CELL_PAD, curY + CELL_PAD, {
          fit: [COL_WIDTHS[3] - CELL_PAD * 2, rowH - CELL_PAD * 2 - 14],
          align: 'center',
        });
      } catch (e) { /* skip */ }
      const caption = frame.annotationText || frame.referenceText || '';
      if (caption) {
        doc.font('CJK').fontSize(6).fillColor('#666')
          .text(caption, colX + CELL_PAD, curY + rowH - 14, {
            width: COL_WIDTHS[3] - CELL_PAD * 2, align: 'center', lineBreak: false,
          });
      }
    }

    doc.fillColor('#000'); // reset
    curY += rowH;
  }

  doc.end();

  if (!outputPath) {
    return new Promise(resolve => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));
    });
  }
}

module.exports = { generateStoryboardPDF };
