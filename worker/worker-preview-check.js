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

    // Check for fatal JS errors (exclude known Luna engine errors that don't affect gameplay)
    const LUNA_ENGINE_ERRORS = /Awake\(\)|OnEnable\(\)|_invokeOverload|onAwake|onInit/i;
    const fatalErrors = errors.filter(e => 
      /uncaught|exception|cannot read|is not defined|is not a function|stack overflow|maximum call/i.test(e)
      && !LUNA_ENGINE_ERRORS.test(e)  // Luna template component lifecycle errors — safe to ignore
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

    // NOTE: WebGL canvas drawImage returns all-black (preserveDrawingBuffer=false).
    // Must use page.screenshot() for pixel analysis — it captures the compositor output.
    // HOWEVER: On headless Chromium without GPU (e.g. Worker ECS Windows Server),
    // WebGL renders near-black even with screenshot. Skip pixel analysis in that case.

    // Detect GPU availability: check if WebGL renders anything beyond background
    let hasGPU = true;
    if (ok) {
      try {
        const gpuCheck = await page.evaluate(() => {
          var c = document.createElement('canvas');
          c.width = 64; c.height = 64;
          var gl = c.getContext('webgl2') || c.getContext('webgl');
          if (!gl) return { hasGPU: false, reason: 'no webgl context' };
          var renderer = gl.getParameter(gl.RENDERER) || '';
          var vendor = gl.getParameter(gl.VENDOR) || '';
          // SwiftShader / llvmpipe / software = no real GPU
          var isSoftware = /swiftshader|llvmpipe|software|mesa/i.test(renderer + ' ' + vendor);
          return { hasGPU: !isSoftware, renderer, vendor };
        });
        hasGPU = gpuCheck.hasGPU;
        if (!hasGPU) {
          log(`[preview-check] No GPU detected (renderer: ${gpuCheck.renderer}). Skipping pixel analysis — WebGL content invisible in software rendering.`, taskId);
        }
      } catch (gpuErr) {
        log(`[preview-check] GPU detection failed: ${gpuErr.message}, assuming no GPU`, taskId);
        hasGPU = false;
      }
    }

    // Scene object verification via Playwright screenshot (NOT drawImage — WebGL preserveDrawingBuffer=false)
    if (ok && hasGPU) {
      try {
        // Use sharp or raw PNG parsing to analyze the screenshot pixels
        // Since we may not have sharp, use a second page with the screenshot loaded as an image
        const screenshotBuf = await page.screenshot({ type: 'png' });
        
        // Open a new page, load the screenshot as an image, then analyze via canvas 2D
        const page2 = await browser.newPage();
        const b64 = screenshotBuf.toString('base64');
        await page2.setContent(`<canvas id="c"></canvas><script>
          var img = new Image();
          img.onload = function() {
            var c = document.getElementById('c');
            c.width = img.width; c.height = img.height;
            c.getContext('2d').drawImage(img, 0, 0);
            window.__ready = true;
          };
          img.src = 'data:image/png;base64,${b64}';
        </script>`);
        await page2.waitForFunction('window.__ready', { timeout: 5000 });
        
        const sceneCheck = await page2.evaluate(() => {
          var c = document.getElementById('c');
          var ctx = c.getContext('2d');
          var w = c.width, h = c.height;
          var data = ctx.getImageData(0, 0, w, h).data;
          
          // 4x4 grid region analysis
          var gridSize = 4;
          var cellW = Math.floor(w / gridSize), cellH = Math.floor(h / gridSize);
          var regionColors = [];
          for (var gy = 0; gy < gridSize; gy++) {
            for (var gx = 0; gx < gridSize; gx++) {
              var colorSet = new Set();
              for (var y = gy * cellH; y < (gy + 1) * cellH; y += 4) {
                for (var x = gx * cellW; x < (gx + 1) * cellW; x += 4) {
                  var i = (y * w + x) * 4;
                  colorSet.add(Math.floor(data[i]/32) + ',' + Math.floor(data[i+1]/32) + ',' + Math.floor(data[i+2]/32));
                }
              }
              regionColors.push(colorSet.size);
            }
          }
          
          var activeRegions = regionColors.filter(function(c) { return c > 2; }).length;
          var totalColors = new Set();
          for (var i = 0; i < data.length; i += 16) {
            totalColors.add(Math.floor(data[i]/32) + ',' + Math.floor(data[i+1]/32) + ',' + Math.floor(data[i+2]/32));
          }
          
          // White text pixel detection
          var textPixels = 0;
          for (var i = 0; i < data.length; i += 4) {
            if (data[i] > 220 && data[i+1] > 220 && data[i+2] > 220) textPixels++;
          }
          var textRatio = textPixels / (w * h);
          
          return {
            hasObjects: activeRegions >= 4 && totalColors.size >= 8,
            activeRegions: activeRegions,
            totalRegions: gridSize * gridSize,
            totalUniqueColors: totalColors.size,
            textPixelRatio: textRatio.toFixed(4),
            hasTextLabels: textRatio > 0.005,
            regionColorCounts: regionColors
          };
        });
        
        await page2.close();
        
        log(`[preview-check] Scene analysis: ${sceneCheck.activeRegions}/${sceneCheck.totalRegions} active regions, ${sceneCheck.totalUniqueColors} colors, text=${sceneCheck.hasTextLabels} (${sceneCheck.textPixelRatio})`, taskId);
        
        if (!sceneCheck.hasObjects) {
          ok = false;
          failReason = `Scene too empty: only ${sceneCheck.activeRegions}/${sceneCheck.totalRegions} regions have objects, ${sceneCheck.totalUniqueColors} unique colors. Game objects not rendered properly. AI must create visible objects with DISTINCT colors and text labels.`;
        }
      } catch(sceneErr) {
        log(`[preview-check] Scene analysis error: ${sceneErr.message}`, taskId);
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
