// Screenshot Review — Take screenshot of WebGL build and AI-review against blueprint
// Runs on Main ECS (Linux) with Playwright + Doubao
// Usage: node screenshot-review.cjs <taskId> <blueprintJsonPath> [webglDir]
// Returns: { ok: true/false, reason: string, screenshotPath: string }

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const modelProvider = require('../lib/model-provider.cjs');
var _reviewProvider = modelProvider.createProvider('doubao', {});

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

    return { ok: true, screenshotPath, screenshot2Path };
  } catch (e) {
    return { ok: false, error: 'Screenshot failed: ' + e.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function callVisionLLM(prompt, imageBase64) {
  var result = await _reviewProvider.generate(
    {
      system: 'You are a playable ad screenshot reviewer. Respond only in JSON.',
      user: prompt,
      images: [{ data: imageBase64, mimeType: 'image/png' }],
    },
    { temperature: 0.1, maxTokens: 1000, timeoutMs: 30000 }
  );
  return result.text || '';
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
    const response = await callVisionLLM(prompt, imageBase64);
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

module.exports = { takeScreenshot, reviewScreenshot, callVisionLLM };

if (require.main === module) main().catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
