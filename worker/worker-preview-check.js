/**
 * worker-preview-check.js
 * 构建完成后、CUA 前的快速预览健康检查
 * 用 Playwright 打开构建产物，检查是否卡在 loading/进度条
 * 返回 { ok: boolean, error?: string, screenshot?: string }
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PREVIEW_TIMEOUT = 15000; // 15秒加载超时
const GAME_READY_TIMEOUT = 10000; // 游戏就绪等待

/**
 * 启动临时 HTTP 服务托管构建产物（如果 cua-service 不可用）
 */
function startTempServer(dir, port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(dir, req.url === '/' ? 'iframe.html' : req.url);
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * 快速预览检查
 * @param {string} stage4Dir - Luna stage4 构建输出目录
 * @param {string} taskId - 任务 ID
 * @param {Function} log - 日志函数
 * @returns {{ ok: boolean, error?: string, screenshotPath?: string }}
 */
async function runPreviewCheck(stage4Dir, taskId, log) {
  log('[preview-check] Starting quick preview health check...', taskId);

  // Check if iframe.html exists
  const iframePath = path.join(stage4Dir, 'iframe.html');
  if (!fs.existsSync(iframePath)) {
    return { ok: false, error: 'iframe.html not found in build output' };
  }

  // Start temp server
  const server = await startTempServer(stage4Dir);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/iframe.html`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });

    // Collect console errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));

    // Navigate
    await page.goto(url, { timeout: PREVIEW_TIMEOUT, waitUntil: 'domcontentloaded' });

    // Wait for game to load
    await page.waitForTimeout(8000);

    // Take screenshot
    const screenshotDir = path.join(path.dirname(stage4Dir), '..', 'worker', 'cua-results');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `${taskId}-preview.png`);
    // Fallback to a simpler path
    const ssPath = path.join(process.cwd(), 'cua-results', `${taskId}-preview.png`);
    if (!fs.existsSync(path.dirname(ssPath))) fs.mkdirSync(path.dirname(ssPath), { recursive: true });
    await page.screenshot({ path: ssPath });

    // Check for stuck loading indicators
    const loadingCheck = await page.evaluate(() => {
      const body = document.body;
      if (!body) return { stuck: true, reason: 'no body element' };

      // Check for common loading indicators
      const loadingElements = document.querySelectorAll('[class*="loading"], [class*="progress"], [id*="loading"], [id*="progress"]');
      const visibleLoading = Array.from(loadingElements).filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      });

      // Check for Unity/Luna loading bar
      const unityLoader = document.querySelector('#unity-loading-bar, .unity-loader, #UnityLoading, .webgl-content .loading');
      const lunaProgress = document.querySelector('.luna-loading, #luna-loading, [class*="luna"][class*="load"]');

      // Check canvas existence and dimensions
      const canvas = document.querySelector('canvas');
      const hasCanvas = !!canvas;
      let canvasInfo = null;
      if (canvas) {
        canvasInfo = { width: canvas.width, height: canvas.height };
        // Try to check if canvas has content (not just black/white)
        try {
          const ctx = canvas.getContext('2d') || canvas.getContext('webgl') || canvas.getContext('webgl2');
          if (ctx && ctx.getImageData) {
            const data = ctx.getImageData(0, 0, Math.min(canvas.width, 100), Math.min(canvas.height, 100)).data;
            const nonZero = data.some((v, i) => i % 4 !== 3 && v !== 0 && v !== 255);
            canvasInfo.hasContent = nonZero;
          }
        } catch(e) { /* WebGL context, can't getImageData */ }
      }

      // Check if page is mostly empty (just a loading screen)
      const textContent = document.body.innerText.trim();
      const hasLoadingText = /loading|加载中|please wait|initializing/i.test(textContent);

      return {
        stuck: false,
        visibleLoadingCount: visibleLoading.length,
        hasUnityLoader: !!unityLoader,
        hasLunaProgress: !!lunaProgress,
        hasCanvas,
        canvasInfo,
        hasLoadingText,
        bodyTextLength: textContent.length,
        bodyText: textContent.slice(0, 200)
      };
    });

    // Check for fatal JS errors
    const fatalErrors = errors.filter(e => 
      /uncaught|exception|cannot read|is not defined|is not a function|stack overflow|maximum call/i.test(e)
    );

    // Decision logic
    let ok = true;
    let failReason = '';

    if (fatalErrors.length > 0) {
      ok = false;
      failReason = `Fatal JS errors: ${fatalErrors.slice(0, 3).join('; ').slice(0, 300)}`;
    } else if (loadingCheck.hasLoadingText && !loadingCheck.hasCanvas) {
      ok = false;
      failReason = 'Page stuck on loading text, no game canvas found';
    } else if (loadingCheck.hasUnityLoader || loadingCheck.hasLunaProgress) {
      ok = false;
      failReason = 'Unity/Luna loading indicator still visible after 8s';
    } else if (!loadingCheck.hasCanvas) {
      ok = false;
      failReason = 'No canvas element found - game did not initialize';
    } else if (loadingCheck.visibleLoadingCount > 0 && loadingCheck.hasLoadingText) {
      ok = false;
      failReason = `Loading indicators still visible (${loadingCheck.visibleLoadingCount} elements)`;
    }

    // Screenshot pixel analysis: detect blank/uniform scenes (all same color = nothing rendered)
    if (ok) {
      try {
        const screenshot = await page.screenshot({ type: 'png' });
        const pixels = screenshot; // raw PNG buffer
        // Sample center region of canvas via page.evaluate
        const pixelCheck = await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return { uniform: false, reason: 'no canvas' };
          // Try to get pixel data from a 2D snapshot
          const tempCanvas = document.createElement('canvas');
          const w = Math.min(canvas.width, 200);
          const h = Math.min(canvas.height, 200);
          tempCanvas.width = w; tempCanvas.height = h;
          const ctx = tempCanvas.getContext('2d');
          try { ctx.drawImage(canvas, 0, 0, w, h); } catch(e) { return { uniform: false, reason: 'drawImage failed: ' + e.message }; }
          const data = ctx.getImageData(0, 0, w, h).data;
          // Count unique colors (sample every 4th pixel)
          const colorSet = new Set();
          for (let i = 0; i < data.length; i += 16) {
            const key = data[i] + ',' + data[i+1] + ',' + data[i+2];
            colorSet.add(key);
            if (colorSet.size > 10) break; // enough variety
          }
          return { uniqueColors: colorSet.size, uniform: colorSet.size <= 3 };
        });
        if (pixelCheck.uniform) {
          ok = false;
          failReason = `Scene appears blank/uniform (only ${pixelCheck.uniqueColors} unique colors). Game objects may not have rendered.`;
        }
        log(`[preview-check] Pixel analysis: ${pixelCheck.uniqueColors} unique colors${pixelCheck.uniform ? ' (UNIFORM - likely empty scene)' : ''}`, taskId);
      } catch(pixErr) {
        log(`[preview-check] Pixel analysis skipped: ${pixErr.message}`, taskId);
      }
    }

    // Scene object verification: check for visible text labels and color diversity
    if (ok) {
      try {
        // Check if there are visible DOM text elements (floating labels created by AddLabel)
        const sceneCheck = await page.evaluate(() => {
          // In Luna WebGL, UI Text elements render on canvas, not DOM.
          // But we can check the canvas pixel diversity more thoroughly
          const canvas = document.querySelector('canvas');
          if (!canvas) return { hasObjects: false, reason: 'no canvas' };
          
          const tempCanvas = document.createElement('canvas');
          const w = Math.min(canvas.width, 400);
          const h = Math.min(canvas.height, 400);
          tempCanvas.width = w; tempCanvas.height = h;
          const ctx = tempCanvas.getContext('2d');
          try { ctx.drawImage(canvas, 0, 0, w, h); } catch(e) { return { hasObjects: false, reason: 'drawImage: ' + e.message }; }
          const data = ctx.getImageData(0, 0, w, h).data;
          
          // Analyze color distribution in regions (divide into 4x4 grid)
          const gridSize = 4;
          const cellW = Math.floor(w / gridSize);
          const cellH = Math.floor(h / gridSize);
          const regionColors = [];
          
          for (let gy = 0; gy < gridSize; gy++) {
            for (let gx = 0; gx < gridSize; gx++) {
              const colorSet = new Set();
              for (let y = gy * cellH; y < (gy + 1) * cellH; y += 4) {
                for (let x = gx * cellW; x < (gx + 1) * cellW; x += 4) {
                  const i = (y * w + x) * 4;
                  // Quantize to reduce noise (bucket by 32)
                  const r = Math.floor(data[i] / 32);
                  const g = Math.floor(data[i+1] / 32);
                  const b = Math.floor(data[i+2] / 32);
                  colorSet.add(r + ',' + g + ',' + b);
                }
              }
              regionColors.push(colorSet.size);
            }
          }
          
          // Count how many regions have >2 colors (meaning objects are there)
          const activeRegions = regionColors.filter(c => c > 2).length;
          // Total unique colors across entire image
          const totalColors = new Set();
          for (let i = 0; i < data.length; i += 16) {
            const r = Math.floor(data[i] / 32);
            const g = Math.floor(data[i+1] / 32);
            const b = Math.floor(data[i+2] / 32);
            totalColors.add(r + ',' + g + ',' + b);
          }
          
          // Check for white/light colored text pixels (labels are usually white text)
          let textPixelCount = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 220 && data[i+1] > 220 && data[i+2] > 220) textPixelCount++;
          }
          const textRatio = textPixelCount / (w * h);
          
          return {
            hasObjects: activeRegions >= 4 && totalColors.size >= 8,
            activeRegions,
            totalRegions: gridSize * gridSize,
            totalUniqueColors: totalColors.size,
            textPixelRatio: textRatio.toFixed(4),
            hasTextLabels: textRatio > 0.005, // At least 0.5% white pixels = likely has text labels
            regionColorCounts: regionColors
          };
        });
        
        log(`[preview-check] Scene analysis: ${sceneCheck.activeRegions}/${sceneCheck.totalRegions} active regions, ${sceneCheck.totalUniqueColors} colors, text=${sceneCheck.hasTextLabels} (${sceneCheck.textPixelRatio})`, taskId);
        
        if (!sceneCheck.hasObjects) {
          ok = false;
          failReason = `Scene too empty: only ${sceneCheck.activeRegions}/${sceneCheck.totalRegions} regions have objects, ${sceneCheck.totalUniqueColors} unique colors. Game objects not rendered properly. AI must create visible objects with DISTINCT colors and text labels.`;
        }
      } catch(sceneErr) {
        log(`[preview-check] Scene analysis skipped: ${sceneErr.message}`, taskId);
      }
    }

    log(`[preview-check] Result: ${ok ? 'PASS' : 'FAIL'} | canvas=${loadingCheck.hasCanvas} | errors=${errors.length} | fatalErrors=${fatalErrors.length}${failReason ? ' | reason=' + failReason : ''}`, taskId);

    if (errors.length > 0) {
      log(`[preview-check] Console errors: ${errors.slice(0, 5).join(' | ').slice(0, 500)}`, taskId);
    }

    return { ok, error: failReason || undefined, screenshotPath: ssPath, details: loadingCheck, consoleErrors: errors };

  } catch (err) {
    log(`[preview-check] Error: ${err.message}`, taskId);
    return { ok: false, error: `Preview check crashed: ${err.message}` };
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
}

module.exports = { runPreviewCheck };
