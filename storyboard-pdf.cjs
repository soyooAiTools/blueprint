/**
 * Storyboard PDF Generator
 * Generates a professional storyboard PDF from parsed frames
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PAGE_W = 842; // A4 landscape
const PAGE_H = 595;
const MARGIN = 40;
const COL_W = (PAGE_W - MARGIN * 3) / 2; // 2 frames per row
const ROW_H = 240;
const IMG_W = COL_W;
const IMG_H = 160;

function fetchImage(url) {
  return new Promise((resolve, reject) => {
    if (!url || url.startsWith('data:image/svg')) return resolve(null); // skip SVG placeholders
    if (url.startsWith('data:image/')) {
      const match = url.match(/base64,(.+)/);
      if (match) return resolve(Buffer.from(match[1], 'base64'));
      return resolve(null);
    }
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', () => resolve(null));
  });
}

async function generateStoryboardPDF(frames, options = {}) {
  const { projectName = '分镜板', outputPath } = options;

  const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], layout: 'landscape', margin: MARGIN });
  const buffers = [];
  
  if (outputPath) {
    doc.pipe(fs.createWriteStream(outputPath));
  } else {
    doc.on('data', b => buffers.push(b));
  }

  // Register Chinese font if available, fallback to Helvetica
  let fontFamily = 'Helvetica';
  const fontPaths = [
    '/usr/share/fonts/chinese/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc',
  ];
  for (const fp of fontPaths) {
    if (fs.existsSync(fp)) {
      doc.registerFont('CJK', fp);
      fontFamily = 'CJK';
      break;
    }
  }

  // Title page
  doc.font(fontFamily).fontSize(28).text(projectName, MARGIN, PAGE_H / 2 - 60, { align: 'center', width: PAGE_W - MARGIN * 2 });
  doc.fontSize(14).fillColor('#666').text('Storyboard / 分镜板', { align: 'center', width: PAGE_W - MARGIN * 2 });
  doc.fontSize(10).text(`${frames.length} 帧 | ${new Date().toLocaleDateString('zh-CN')}`, { align: 'center', width: PAGE_W - MARGIN * 2 });

  // Frames - 2 per row, 2 rows per page
  for (let i = 0; i < frames.length; i++) {
    if (i % 4 === 0) doc.addPage();
    const frame = frames[i];
    const col = i % 2;
    const row = Math.floor((i % 4) / 2);
    const x = MARGIN + col * (COL_W + MARGIN);
    const y = MARGIN + row * (ROW_H + 20);

    // Frame border
    doc.save().rect(x, y, COL_W, ROW_H).stroke('#ccc').restore();

    // Image area
    let imgBuf = null;
    if (frame.imageUrl && !frame.imageUrl.startsWith('data:image/svg')) {
      imgBuf = await fetchImage(frame.imageUrl);
    }
    if (imgBuf) {
      try { doc.image(imgBuf, x + 5, y + 25, { width: IMG_W - 10, height: IMG_H - 10, fit: [IMG_W - 10, IMG_H - 10] }); }
      catch { /* skip bad images */ }
    } else {
      // Placeholder
      doc.save().rect(x + 5, y + 25, IMG_W - 10, IMG_H - 10).fill('#1a1a2e').restore();
      doc.font(fontFamily).fontSize(20).fillColor('#444').text(`#${frame.id}`, x + 5, y + 70, { width: IMG_W - 10, align: 'center' });
      doc.fillColor('#000');
    }

    // Title bar
    doc.font(fontFamily).fontSize(10).fillColor('#333')
      .text(`#${frame.id} ${frame.title || ''}`, x + 5, y + 5, { width: COL_W - 10, lineBreak: false });

    // Interaction text below image
    const textY = y + IMG_H + 5;
    doc.font(fontFamily).fontSize(7).fillColor('#444')
      .text((frame.interaction || '').slice(0, 120), x + 5, textY, { width: COL_W - 10, height: ROW_H - IMG_H - 15, lineBreak: true });
    
    doc.fillColor('#000');
  }

  doc.end();

  if (!outputPath) {
    return new Promise(resolve => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));
    });
  }
}

module.exports = { generateStoryboardPDF };
