/**
 * Reference Analyzer — 运行竞品 HTML 并提取交互流程
 *
 * 1. Playwright 加载 HTML
 * 2. 首屏截图
 * 3. 自动交互探测 (tap/drag/swipe)
 * 4. 阶段切换检测 (截图 diff)
 * 5. CTA 检测
 * 6. 辅助静态分析 (DOM/事件/资源)
 *
 * 输出: { screenshots[], interactionFlow[], detectedEntities[], staticAnalysis }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/screenshots';
const ANALYSIS_TIMEOUT = 60000; // 60s total
const VIEWPORT = { width: 390, height: 844 }; // iPhone 14 Pro

/**
 * 计算两张截图的差异百分比 (0~1)
 */
function imageDiff(buf1, buf2) {
  try {
    var img1 = PNG.sync.read(buf1);
    var img2 = PNG.sync.read(buf2);
    if (img1.width !== img2.width || img1.height !== img2.height) return 1;

    var totalPixels = img1.width * img1.height;
    var diffPixels = 0;
    var d1 = img1.data, d2 = img2.data;

    // 每隔4个像素采样（加速）
    for (var i = 0; i < d1.length; i += 16) {
      var dr = Math.abs(d1[i] - d2[i]);
      var dg = Math.abs(d1[i + 1] - d2[i + 1]);
      var db = Math.abs(d1[i + 2] - d2[i + 2]);
      if (dr + dg + db > 30) diffPixels++;
    }
    return diffPixels / (totalPixels / 4);
  } catch (e) {
    return 1; // 解析失败视为完全不同
  }
}

/**
 * 运行竞品 HTML 并分析
 */
async function analyzeReference(htmlPath, metadata, log, taskId) {
  log('[reference-analyzer] Starting analysis: ' + htmlPath, taskId);

  var chromium;
  try { chromium = require('playwright').chromium; } catch (e) {
    throw new Error('playwright not installed: ' + e.message);
  }

  // 确保截图目录存在
  var ssDir = path.join(SCREENSHOT_DIR, 'ref_' + Date.now());
  fs.mkdirSync(ssDir, { recursive: true });

  var browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  var screenshots = [];
  var interactionFlow = [];
  var staticAnalysis = {};

  try {
    var page = await browser.newPage({ viewport: VIEWPORT });

    // 导航到 HTML 文件
    var fileUrl = htmlPath.startsWith('http') ? htmlPath : ('file://' + path.resolve(htmlPath));
    await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000); // 等游戏引擎初始化

    // === 1. 首屏截图 ===
    var ssPath0 = path.join(ssDir, 'stage_0_initial.png');
    await page.screenshot({ path: ssPath0 });
    screenshots.push({ stage: 'initial', path: ssPath0, timestamp: 0 });
    var prevBuf = fs.readFileSync(ssPath0);
    log('[reference-analyzer] Initial screenshot taken', taskId);

    // === 2. 静态分析 ===
    try {
      staticAnalysis = await page.evaluate(function() {
        var result = {
          canvasCount: document.querySelectorAll('canvas').length,
          canvasSize: null,
          imgCount: document.querySelectorAll('img').length,
          divCount: document.querySelectorAll('div').length,
          hasAudio: document.querySelectorAll('audio').length > 0,
          bodyBgColor: getComputedStyle(document.body).backgroundColor,
          visibleText: [],
        };

        // canvas 尺寸
        var canvas = document.querySelector('canvas');
        if (canvas) {
          result.canvasSize = { width: canvas.width, height: canvas.height };
        }

        // 提取可见文本（按钮、标签等）
        var textEls = document.querySelectorAll('button, a, span, p, h1, h2, h3, label, [class*="text"], [class*="btn"]');
        for (var i = 0; i < Math.min(textEls.length, 20); i++) {
          var t = (textEls[i].textContent || '').trim();
          if (t && t.length < 100) result.visibleText.push(t);
        }

        // 检测 CTA 元素
        var ctaEls = document.querySelectorAll('a[href*="store"], a[href*="play.google"], a[href*="apple.com"], [class*="cta"], [class*="install"], [class*="download"]');
        result.ctaElements = ctaEls.length;

        // 检测 MRAID
        result.hasMraid = typeof window.mraid !== 'undefined';

        return result;
      });
      log('[reference-analyzer] Static analysis: canvas=' + staticAnalysis.canvasCount + ', framework=' + (metadata.framework || 'unknown'), taskId);
    } catch (e) {
      log('[reference-analyzer] Static analysis failed (non-fatal): ' + e.message, taskId);
      staticAnalysis = { error: e.message };
    }

    // === 3. 自动交互探测 ===
    var cx = VIEWPORT.width / 2;
    var cy = VIEWPORT.height / 2;
    var stageIndex = 1;

    // 交互点列表：中心、四象限、常见按钮位置
    var tapPoints = [
      { x: cx, y: cy, label: 'center' },
      { x: cx, y: cy + 200, label: 'lower-center' },
      { x: cx, y: cy - 200, label: 'upper-center' },
      { x: cx - 100, y: cy, label: 'left-center' },
      { x: cx + 100, y: cy, label: 'right-center' },
      { x: cx, y: VIEWPORT.height - 100, label: 'bottom' },  // CTA 区域
    ];

    for (var i = 0; i < tapPoints.length && stageIndex < 8; i++) {
      var tp = tapPoints[i];
      try {
        // Tap
        await page.mouse.click(tp.x, tp.y);
        await page.waitForTimeout(1500);

        // 截图并比较
        var ssPathN = path.join(ssDir, 'stage_' + stageIndex + '_tap_' + tp.label + '.png');
        await page.screenshot({ path: ssPathN });
        var curBuf = fs.readFileSync(ssPathN);
        var diff = imageDiff(prevBuf, curBuf);

        if (diff > 0.05) {
          // 画面有显著变化
          screenshots.push({
            stage: 'after_tap_' + tp.label,
            path: ssPathN,
            timestamp: (i + 1) * 1500,
            diff: (diff * 100).toFixed(1) + '%',
          });
          interactionFlow.push({
            action: 'tap',
            x: tp.x,
            y: tp.y,
            label: tp.label,
            result: diff > 0.3 ? 'phase_change' : 'minor_change',
            diff: diff,
          });
          prevBuf = curBuf;
          stageIndex++;
          log('[reference-analyzer] Tap ' + tp.label + ' → diff ' + (diff * 100).toFixed(1) + '%', taskId);
        } else {
          // 无变化，删除截图
          try { fs.unlinkSync(ssPathN); } catch (e) {}
        }
      } catch (e) {
        log('[reference-analyzer] Tap ' + tp.label + ' failed: ' + e.message, taskId);
      }
    }

    // === 4. 尝试 swipe/drag ===
    if (stageIndex < 4) {
      // tap 探测结果不多，尝试拖拽
      var dragTests = [
        { from: { x: cx, y: cy + 100 }, to: { x: cx, y: cy - 100 }, label: 'swipe-up' },
        { from: { x: cx - 100, y: cy }, to: { x: cx + 100, y: cy }, label: 'swipe-right' },
        { from: { x: cx, y: cy }, to: { x: cx + 150, y: cy + 150 }, label: 'drag-diagonal' },
      ];

      for (var d = 0; d < dragTests.length && stageIndex < 8; d++) {
        var dt = dragTests[d];
        try {
          await page.mouse.move(dt.from.x, dt.from.y);
          await page.mouse.down();
          await page.mouse.move(dt.to.x, dt.to.y, { steps: 10 });
          await page.mouse.up();
          await page.waitForTimeout(1500);

          var ssDrag = path.join(ssDir, 'stage_' + stageIndex + '_drag_' + dt.label + '.png');
          await page.screenshot({ path: ssDrag });
          var dragBuf = fs.readFileSync(ssDrag);
          var dragDiff = imageDiff(prevBuf, dragBuf);

          if (dragDiff > 0.05) {
            screenshots.push({
              stage: 'after_' + dt.label,
              path: ssDrag,
              timestamp: Date.now(),
              diff: (dragDiff * 100).toFixed(1) + '%',
            });
            interactionFlow.push({
              action: 'drag',
              from: [dt.from.x, dt.from.y],
              to: [dt.to.x, dt.to.y],
              label: dt.label,
              result: dragDiff > 0.3 ? 'phase_change' : 'minor_change',
              diff: dragDiff,
            });
            prevBuf = dragBuf;
            stageIndex++;
            log('[reference-analyzer] Drag ' + dt.label + ' → diff ' + (dragDiff * 100).toFixed(1) + '%', taskId);
          } else {
            try { fs.unlinkSync(ssDrag); } catch (e) {}
          }
        } catch (e) {}
      }
    }

    // === 5. 等待自动播放截图 ===
    // 有些广告有自动动画/引导，等几秒再截一张
    await page.waitForTimeout(3000);
    var ssAuto = path.join(ssDir, 'stage_' + stageIndex + '_auto.png');
    await page.screenshot({ path: ssAuto });
    var autoBuf = fs.readFileSync(ssAuto);
    var autoDiff = imageDiff(prevBuf, autoBuf);
    if (autoDiff > 0.05) {
      screenshots.push({ stage: 'auto_play', path: ssAuto, timestamp: Date.now(), diff: (autoDiff * 100).toFixed(1) + '%' });
      log('[reference-analyzer] Auto-play detected, diff ' + (autoDiff * 100).toFixed(1) + '%', taskId);
    } else {
      try { fs.unlinkSync(ssAuto); } catch (e) {}
    }

    // === 6. CTA 检测 ===
    var ctaDetected = false;
    try {
      ctaDetected = await page.evaluate(function() {
        var els = document.querySelectorAll('a, button, div, span, img');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var text = (el.textContent || '').toLowerCase();
          var cls = (el.className || '').toLowerCase();
          var href = (el.href || '').toLowerCase();
          if (/install|download|play now|get it|立即下载|立即安装|get the game/i.test(text) ||
              /cta|install|download/i.test(cls) ||
              /play\.google|apple\.com|apps\.apple/i.test(href)) {
            return true;
          }
        }
        return false;
      });
    } catch (e) {}

    log('[reference-analyzer] Analysis complete: ' + screenshots.length + ' screenshots, ' +
        interactionFlow.length + ' interactions, CTA=' + ctaDetected, taskId);

    return {
      screenshots: screenshots,
      interactionFlow: interactionFlow,
      staticAnalysis: staticAnalysis,
      ctaDetected: ctaDetected,
      phaseCount: screenshots.length,
      screenshotDir: ssDir,
    };

  } finally {
    await browser.close();
  }
}

module.exports = { analyzeReference, imageDiff };
