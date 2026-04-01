// Screenshot Review — Take screenshot of WebGL build and AI-review against blueprint
// Runs on Main ECS (Linux) with Playwright + Doubao
// Usage: node screenshot-review.cjs <taskId> <blueprintJsonPath> [webglDir]
// Returns: { ok: true/false, reason: string, screenshotPath: string }

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY || '197cb950-3cf3-4b30-b656-6afaa4306a7a';
const DOUBAO_MODEL = 'doubao-seed-2-0-pro-260215';
const DOUBAO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const WEBGL_BASE = process.env.WEBGL_BASE || '/opt/blueprint-editor/server-data/webgl';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/screenshots';

async function takeScreenshot(taskId, webglDir) {
  const indexPath = path.join(webglDir || WEBGL_BASE, taskId, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return { ok: false, error: 'index.html not found: ' + indexPath };
  }

  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const screenshotPath = path.join(SCREENSHOT_DIR, taskId + '.png');

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone 14 size
    
    // Serve locally via file:// protocol
    await page.goto('file://' + indexPath, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    
    // Wait for WebGL to render (Luna needs time)
    await page.waitForTimeout(5000);
    
    // Take screenshot
    await page.screenshot({ path: screenshotPath, fullPage: false });
    
    // Take a second screenshot after more time (some games have loading)
    await page.waitForTimeout(3000);
    const screenshot2Path = path.join(SCREENSHOT_DIR, taskId + '_late.png');
    await page.screenshot({ path: screenshot2Path, fullPage: false });
    
    // Pixel-level blank screen detection on the late screenshot
    const blankResult = await detectBlankScreen(page);
    
    return { ok: true, screenshotPath, screenshot2Path, blankDetection: blankResult };
  } catch (e) {
    return { ok: false, error: 'Screenshot failed: ' + e.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Pixel-level blank/white screen detection using Canvas in Playwright
async function detectBlankScreen(page) {
  try {
    const result = await page.evaluate(() => {
      // Find the main canvas element (WebGL games render to canvas)
      const canvas = document.querySelector('canvas');
      if (!canvas) return { blank: true, reason: 'no_canvas', uniqueColors: 0 };
      
      // Sample pixels from the canvas
      const ctx = canvas.getContext('2d') || canvas.getContext('webgl') || canvas.getContext('webgl2');
      
      // For WebGL context, we need to read pixels differently
      let pixels;
      if (ctx && ctx.readPixels) {
        // WebGL context
        const w = Math.min(canvas.width, 200);
        const h = Math.min(canvas.height, 200);
        pixels = new Uint8Array(w * h * 4);
        ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, pixels);
      } else {
        // Try creating a temporary 2D canvas from the WebGL canvas
        const tempCanvas = document.createElement('canvas');
        const tw = Math.min(canvas.width, 200);
        const th = Math.min(canvas.height, 200);
        tempCanvas.width = tw;
        tempCanvas.height = th;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(canvas, 0, 0, tw, th);
        const imageData = tempCtx.getImageData(0, 0, tw, th);
        pixels = imageData.data;
      }
      
      if (!pixels || pixels.length === 0) return { blank: true, reason: 'no_pixels', uniqueColors: 0 };
      
      // Analyze pixel variance
      const colorSet = new Set();
      let totalR = 0, totalG = 0, totalB = 0;
      const sampleCount = Math.floor(pixels.length / 4);
      const step = Math.max(1, Math.floor(sampleCount / 1000)); // Sample up to 1000 pixels
      let sampled = 0;
      
      for (let i = 0; i < pixels.length; i += step * 4) {
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        // Quantize to reduce noise (group similar colors)
        const qr = Math.floor(r / 16);
        const qg = Math.floor(g / 16);
        const qb = Math.floor(b / 16);
        colorSet.add(`${qr},${qg},${qb}`);
        totalR += r; totalG += g; totalB += b;
        sampled++;
      }
      
      const avgR = Math.round(totalR / sampled);
      const avgG = Math.round(totalG / sampled);
      const avgB = Math.round(totalB / sampled);
      const uniqueColors = colorSet.size;
      
      // Blank detection rules:
      // - Very few unique colors (< 5) = likely blank/solid
      // - White: avg RGB all > 240
      // - Black: avg RGB all < 15
      // - Gray: avg RGB all within 10 of each other AND few colors
      const isWhite = avgR > 240 && avgG > 240 && avgB > 240 && uniqueColors < 5;
      const isBlack = avgR < 15 && avgG < 15 && avgB < 15 && uniqueColors < 5;
      const isGray = Math.abs(avgR - avgG) < 15 && Math.abs(avgG - avgB) < 15 && uniqueColors < 8;
      const isSolidColor = uniqueColors < 3;
      
      const blank = isWhite || isBlack || isSolidColor || (isGray && uniqueColors < 5);
      
      return {
        blank,
        reason: isWhite ? 'white_screen' : isBlack ? 'black_screen' : isSolidColor ? 'solid_color' : isGray ? 'gray_screen' : 'has_content',
        uniqueColors,
        avgColor: { r: avgR, g: avgG, b: avgB },
        sampled
      };
    });
    return result;
  } catch (e) {
    return { blank: false, reason: 'detection_error: ' + e.message, uniqueColors: -1 };
  }
}

function callDoubao(prompt, imageBase64) {
  return new Promise((resolve, reject) => {
    const messages = [];
    if (imageBase64) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } }
        ]
      });
    } else {
      messages.push({ role: 'user', content: prompt });
    }
    
    const payload = JSON.stringify({
      model: DOUBAO_MODEL,
      messages: messages,
      max_tokens: 4096,
      temperature: 0.3,
    });
    
    const options = {
      hostname: 'ark.cn-beijing.volces.com',
      path: '/api/v3/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DOUBAO_API_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    };
    
    // Clear proxy
    const prevProxy = process.env.HTTPS_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    
    const req = require('https').request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (prevProxy) process.env.HTTPS_PROXY = prevProxy;
        try {
          const json = JSON.parse(body);
          if (json.error) { reject(new Error('Doubao error: ' + (json.error.message || JSON.stringify(json.error)))); return; }
          const text = json.choices && json.choices[0] ? json.choices[0].message.content : '';
          resolve(text);
        } catch (e) { reject(new Error('Doubao parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Doubao timeout')); });
    req.on('error', (e) => { if (prevProxy) process.env.HTTPS_PROXY = prevProxy; reject(e); });
    req.write(payload);
    req.end();
  });
}

module.exports = { takeScreenshot, reviewScreenshot, callDoubao };

if (require.main === module) main().catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
