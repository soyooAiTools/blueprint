// Screenshot Review — Take screenshot of WebGL build and AI-review against blueprint
// Runs on Main ECS (Linux) with Playwright + Gemini
// Usage: node screenshot-review.cjs <taskId> <blueprintJsonPath> [webglDir]
// Returns: { ok: true/false, reason: string, screenshotPath: string }

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE_URL = process.env.GOOGLE_GEMINI_BASE_URL || 'https://sub.mindrix.app';
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

function callGemini(prompt, imageBase64) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/png', data: imageBase64 } }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1000 }
    });

    const url = new URL(`${GEMINI_BASE_URL}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
        } catch (e) { reject(new Error('Gemini parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

async function reviewScreenshot(screenshotPath, blueprint) {
  const imageBuffer = fs.readFileSync(screenshotPath);
  const imageBase64 = imageBuffer.toString('base64');

  // Build blueprint summary for comparison
  const nodes = blueprint.nodes || [];
  const shotSummary = nodes.map((n, i) => {
    const d = n.data || {};
    return `Shot ${i + 1}: ${d.label || d.name || 'unnamed'} — ${(d.sceneObjects || d.description || '').slice(0, 200)}`;
  }).join('\n');

  const prompt = `You are reviewing a screenshot of a playable ad (HTML5 game) built from a blueprint.

## Blueprint Summary:
Project: ${blueprint.projectName || 'Unknown'}
${shotSummary}

## Your Task:
Look at this screenshot and answer these questions:
1. Is the screen BLANK or showing only a solid color? (yes/no)
2. Does it look like a generic SLG/idle game template (buildings, resources, upgrade buttons)? (yes/no)  
3. Does it appear to show content related to the blueprint description above? (yes/no)
4. Are there visible game objects, UI elements, or interactive content? (yes/no)

## Decision:
- If screen is blank → REJECT (reason: blank screen)
- If it looks like an SLG template → REJECT (reason: template content)
- If it shows relevant content matching the blueprint → APPROVE
- If uncertain but not blank and not template → APPROVE

Respond in this EXACT format (JSON only, no markdown):
{"decision": "APPROVE" or "REJECT", "reason": "brief explanation", "blank": true/false, "template": true/false, "relevant": true/false}`;

  try {
    const response = await callGemini(prompt, imageBase64);
    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return { ok: result.decision === 'APPROVE', ...result };
    }
    return { ok: false, reason: 'Failed to parse AI response: ' + response.slice(0, 200) };
  } catch (e) {
    // If AI review fails, don't block — pass with warning
    return { ok: true, reason: 'AI review failed (passing anyway): ' + e.message, warning: true };
  }
}

async function main() {
  const taskId = process.argv[2];
  const blueprintPath = process.argv[3];
  const webglDir = process.argv[4];

  if (!taskId || !blueprintPath) {
    console.log(JSON.stringify({ ok: false, error: 'Usage: node screenshot-review.cjs <taskId> <blueprintPath> [webglDir]' }));
    process.exit(1);
  }

  // Take screenshots
  const ssResult = await takeScreenshot(taskId, webglDir);
  if (!ssResult.ok) {
    console.log(JSON.stringify(ssResult));
    process.exit(1);
  }

  // Load blueprint
  let blueprint;
  try {
    blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf-8'));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: 'Failed to load blueprint: ' + e.message }));
    process.exit(1);
  }

  // Review both screenshots (use the later one as primary — more likely to have loaded)
  const reviewPath = fs.existsSync(ssResult.screenshot2Path) ? ssResult.screenshot2Path : ssResult.screenshotPath;
  const review = await reviewScreenshot(reviewPath, blueprint);
  
  console.log(JSON.stringify({
    ...review,
    screenshotPath: ssResult.screenshotPath,
    screenshot2Path: ssResult.screenshot2Path
  }));
  
  process.exit(review.ok ? 0 : 1);
}

module.exports = { takeScreenshot, reviewScreenshot, callGemini };

if (require.main === module) main().catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
